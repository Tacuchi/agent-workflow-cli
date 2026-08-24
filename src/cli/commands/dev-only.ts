import {
  isHarnessId,
  runHarness,
  runLogs,
  runNextNumber,
  runProfiles,
} from "../../application/dev-only-services.js";
import { resolveSessionTarget } from "../../application/session-resolver.js";
import { HARNESSES } from "../../domain/harnesses.js";
import type { CommandResult } from "../../domain/types.js";
import { readRequiredStdin } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

// Derived from the catalog: the describe used to name two hosts out of seven.
const HARNESS_IDS = HARNESSES.map((h) => h.id).join(" | ");

export const harnessCommand: CliCommand = {
  name: "harness",
  describe: `Identify the host harness from its env markers (${HARNESS_IDS} | unknown). 'unknown' is a legitimate answer — some hosts export no marker to their subprocesses; use 'self detect-hosts' for what is actually installed on the machine.`,
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const requested = args.values.get("host");
    if (requested !== undefined && !isHarnessId(requested)) {
      return fail(
        "INVALID_INPUT",
        `--host inválido: '${requested}'. Valores válidos: ${HARNESS_IDS}`,
      );
    }
    const data = runHarness((k) => ctx.env.get(k), requested);
    return { ok: true, data, exitCode: 0 };
  },
};

export const profilesCommand: CliCommand = {
  name: "profiles",
  describe: "Resolve user preferences from the namespace's user-config.md.",
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runProfiles(ctx.fs, ctx.paths);
    return { ok: true, data, exitCode: 0 };
  },
};

export const logsCommand: CliCommand = {
  name: "logs",
  describe: "View or clear the CLI log. Usage: aw logs [--tail <n>] [--clear].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const tailStr = args.values.get("tail");
    const tail = tailStr ? Number.parseInt(tailStr, 10) : undefined;
    const clear = args.flags.has("--clear");
    const input: { tail?: number; clear?: boolean } = {};
    if (tail !== undefined && Number.isFinite(tail)) input.tail = tail;
    if (clear) input.clear = true;
    const data = await runLogs(ctx.env, ctx.paths, input);
    return { ok: true, data, exitCode: 0 };
  },
};

/**
 * The refusal this combination of arguments earns, or `null` when it is coherent.
 *
 * Pure and ahead of every effect on purpose: the anonymous durable reservation
 * has to die before the directory is created, before a byte is written and
 * before a correlative leaves the eligible set, so the whole decision is taken
 * from the arguments alone.
 */
function nextNumberRefusal(input: {
  claim: string | undefined;
  publish: string | undefined;
  code: string | undefined;
  dryRun: boolean;
  valuelessFlags: readonly string[];
}): string | null {
  const { claim, publish, code, dryRun, valuelessFlags } = input;
  // A flag that took no value never reaches `values`, so without this it would
  // fall through to the plain query: exit 0, `published_path: null`, and the
  // document the caller piped in DISCARDED with a truthy answer. A silent
  // success that wrote nothing is the worst answer this command can give.
  if (valuelessFlags.length > 0) {
    return `${valuelessFlags.join(" y ")} exige${valuelessFlags.length > 1 ? "n" : ""} su valor: el resto del nombre del archivo. Sin él la invocación se leería como una consulta y lo que venga por stdin se perdería sin aviso`;
  }
  if (claim === "" || publish === "") {
    return "el resto del nombre no puede estar vacío: sin él el documento nacería llamándose sólo por su correlativo, y ningún lector de docs/ lo reconoce";
  }
  if (claim !== undefined && publish !== undefined) {
    return "--claim y --publish se excluyen: un reclamo reserva el número para escribirlo después, una publicación lo asigna y escribe el documento en el mismo acto";
  }
  if ((claim ?? publish) !== undefined && dryRun) {
    return "--dry-run no se combina con --claim ni con --publish: los dos escriben, y una consulta no";
  }
  if (code !== undefined && claim === undefined) {
    return "--code sólo tiene sentido con --claim: una consulta no reserva nada y una publicación no deja reserva que atribuir";
  }
  // It used to be reachable by simply omitting a flag, and the zero-byte file it
  // left had no re-entry, no close and no recovery — so the refusal names the
  // route that replaced it.
  if (claim !== undefined && code === undefined) {
    return "--claim exige --code <NNN>: una reserva durable pertenece a una sesión activa y resoluble. Para crear un documento sin sesión usá 'next-number <directorio> --publish <resto-del-nombre>' con su contenido final por stdin: asigna el correlativo y escribe el documento en un solo acto, sin dejar reserva de nadie";
  }
  return null;
}

export const nextNumberCommand: CliCommand = {
  name: "next-number",
  describe:
    "Compute next NNN correlative for a directory, creating it when missing. With --claim <resto-del-nombre> --code <NNN> the number is CLAIMED for that session: the file is materialized under the workspace lock so two concurrent flows never receive the same NNN, only that session's own sealed proposal can complete it, asking again returns the same slot, and closing the session releases it if it never did. A claim WITHOUT --code is refused: a durable reservation belongs to a session. With --publish <resto-del-nombre> the number is assigned and the final document — read from stdin — is written in ONE atomic operation, which is how a single-pass creation with no session gets a document instead of a reservation. Usage: aw next-number <directorio> [--claim <resto-del-nombre> --code <NNN>] [--publish <resto-del-nombre>] [--dry-run].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const dir = args.rest[0];
    const usage =
      "uso: next-number <directorio> [--claim <resto-del-nombre> --code <NNN>] [--publish <resto-del-nombre>] [--dry-run]";
    if (!dir) return fail("INVALID_INPUT", usage, { error: usage });

    const claim = args.values.get("claim");
    const publish = args.values.get("publish");
    const code = args.values.get("code");
    const dryRun = args.flags.has("--dry-run");

    const valuelessFlags = ["--claim", "--publish", "--code"].filter((f) => args.flags.has(f));
    const refusal = nextNumberRefusal({ claim, publish, code, dryRun, valuelessFlags });
    if (refusal !== null) return fail("INVALID_INPUT", refusal, { error: refusal });

    if (claim !== undefined) {
      // Asking for an owner and getting an anonymous slot instead is the one
      // outcome that must not happen quietly: the caller would believe its run
      // holds a reservation nobody can attribute to it.
      const resolution = await resolveSessionTarget(ctx.fs, ctx.paths, {
        code: code as string,
        intent: "write",
      });
      if (resolution.outcome !== "resolved") {
        const message = `no se pudo resolver la sesión '${code}' que reclamaría el correlativo`;
        return fail("INVALID_INPUT", message, { error: message, sessionError: resolution });
      }
      const data = await runNextNumber(ctx.fs, ctx.env, ctx.paths, {
        directory: dir,
        claim: { name: claim, owner: resolution.session.folder },
      });
      return { ok: true, data, exitCode: 0 };
    }

    if (publish !== undefined) {
      const content = await readRequiredStdin();
      if (content.length === 0) {
        const message =
          "--publish exige el contenido final del documento por stdin: publicar cero bytes dejaría exactamente el placeholder anónimo que este camino existe para evitar";
        return fail("INVALID_INPUT", message, { error: message });
      }
      const data = await runNextNumber(ctx.fs, ctx.env, ctx.paths, {
        directory: dir,
        publish: { name: publish, content },
      });
      return { ok: true, data, exitCode: 0 };
    }

    const data = await runNextNumber(ctx.fs, ctx.env, ctx.paths, { directory: dir, dryRun });
    return { ok: true, data, exitCode: 0 };
  },
};
