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
  flags: { known: ["host"] },
  help: {
    purpose: "Identify the agent host running this invocation from its environment markers.",
    flags: {
      host: {
        value: `<${HARNESS_IDS.replaceAll(" ", "")}>`,
        effect: "Bind the answer to this host instead of detecting it.",
      },
    },
    output:
      "{agent_host, terminal_host, harness (deprecated), execution, resource_policy {deterministic, semantic_default}, supports_plan_subagent, detected_via, terminal_detected_via, ...}.",
    notes: [
      "unknown is a legitimate answer: some hosts export no marker to their subprocesses. aw self detect-hosts reports what is installed on the machine.",
    ],
  },
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
  flags: { known: [] },
  help: {
    purpose: "Resolve the user preferences declared in the namespace's user-config.md.",
    output:
      "{validation_mode: ask|auto|manual, teaching_mode: off|on, delegate_to_subagent, source: default|user-config, legacy_section_detected}.",
  },
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runProfiles(ctx.fs, ctx.paths);
    return { ok: true, data, exitCode: 0 };
  },
};

export const logsCommand: CliCommand = {
  name: "logs",
  flags: { known: ["tail", "clear"] },
  help: {
    purpose: "Show or clear the CLI's user-level daily log.",
    flags: {
      tail: { value: "<n>", effect: "Show the last n lines of today's log (default 20)." },
      clear: { effect: "Delete every daily log file instead of showing one." },
    },
    output:
      "{path, lines[], total_lines?, showing?, message?}; with --clear: {cleared: true, path}.",
  },
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
  if (claim !== undefined && dryRun) {
    return "--dry-run no se combina con --claim: una consulta no puede poseer una reserva";
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
  flags: { known: ["claim", "publish", "code", "dry-run", "folder"] },
  help: {
    purpose:
      "Number a new document: compute the next NNN of a directory, reserve it for a session, or write a reserved document under it; to publish conversation work use aw persist.",
    args: "<dir>",
    flags: {
      claim: {
        value: "<name>",
        effect: "Reserve <NNN>-<name> for the session given by --code; requires --code.",
      },
      publish: {
        value: "<name>",
        effect:
          "Write the document read from stdin as <NNN>-<name>, with NNN in its title; idempotent.",
      },
      code: { value: "<code>", effect: "Session that owns the --claim reservation." },
      "dry-run": { effect: "Preview without creating the directory or writing; not with --claim." },
      folder: {
        effect: "With --claim, reserve a directory with its marker inside instead of a file.",
      },
    },
    output:
      "{directory, exists, created, current_max, next, files[], claimed_path, claimed_owner, published_path, claim_reused}.",
    notes: [
      "Without --claim or --publish it is a pure query. --claim and --publish exclude each other. --publish needs a materialized Workline workspace (.workflow/sessions/) and the final content on stdin; zero bytes are refused.",
    ],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const dir = args.rest[0];
    const usage =
      "uso: next-number <directorio> [--claim <nombre> --code <sesión> [--folder]] [--publish <nombre> [--dry-run]] [--dry-run]";
    if (!dir) return fail("INVALID_INPUT", usage, { error: usage });

    const claim = args.values.get("claim");
    const publish = args.values.get("publish");
    const code = args.values.get("code");
    const dryRun = args.flags.has("--dry-run");
    const folder = args.flags.has("--folder");
    if (folder && claim === undefined)
      return fail("INVALID_INPUT", "--folder exige --claim <nombre> y --code <sesión>");

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
        claim: {
          name: claim,
          owner: resolution.session.folder,
          ...(folder ? { folder: true } : {}),
        },
      });
      return { ok: true, data, exitCode: 0 };
    }

    if (publish !== undefined) {
      if (!(await ctx.fs.exists(ctx.paths.cwdSessionsDir()))) {
        return fail(
          "WORKSPACE_ABSENT",
          "--publish necesita un workspace Workline materializado; no se creó ninguno",
          {
            action: "invocá el comando desde un workspace con .workflow/sessions/ existente",
          },
        );
      }
      const content = await readRequiredStdin();
      if (content.length === 0) {
        const message =
          "--publish exige el contenido final del documento por stdin: publicar cero bytes dejaría exactamente el placeholder anónimo que este camino existe para evitar";
        return fail("INVALID_INPUT", message, { error: message });
      }
      const data = await runNextNumber(ctx.fs, ctx.env, ctx.paths, {
        directory: dir,
        publish: { name: publish, content },
        dryRun,
      });
      return { ok: true, data, exitCode: 0 };
    }

    const data = await runNextNumber(ctx.fs, ctx.env, ctx.paths, { directory: dir, dryRun });
    return { ok: true, data, exitCode: 0 };
  },
};
