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
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

// Derived from the catalog: the describe used to name two hosts out of seven.
const HARNESS_IDS = HARNESSES.map((h) => h.id).join(" | ");

export const harnessCommand: QtcCommand = {
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

export const profilesCommand: QtcCommand = {
  name: "profiles",
  describe: "Resolve user preferences from the namespace's user-config.md.",
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runProfiles(ctx.fs, ctx.paths);
    return { ok: true, data, exitCode: 0 };
  },
};

export const logsCommand: QtcCommand = {
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

export const nextNumberCommand: QtcCommand = {
  name: "next-number",
  describe:
    "Compute next NNN correlative for a directory, creating it when missing. With --claim <resto-del-nombre> the number is CLAIMED instead of consulted: the file is materialized under the workspace lock, so two concurrent flows never receive the same NNN. With --code <NNN> the reservation BELONGS to that session — only its own sealed proposal can complete it, asking again returns the same slot, and closing the session releases it if it never did. Usage: aw next-number <directorio> [--claim <resto-del-nombre>] [--code <NNN>] [--dry-run].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const dir = args.rest[0];
    if (!dir) {
      const usage =
        "uso: next-number <directorio> [--claim <resto-del-nombre>] [--code <NNN>] [--dry-run]";
      return fail("INVALID_INPUT", usage, { error: usage });
    }
    const claim = args.values.get("claim");
    if (claim !== undefined && args.flags.has("--dry-run")) {
      const message = "--claim y --dry-run se excluyen: un reclamo escribe, una consulta no";
      return fail("INVALID_INPUT", message, { error: message });
    }
    const code = args.values.get("code");
    if (code !== undefined && claim === undefined) {
      const message = "--code sólo tiene sentido con --claim: una consulta no reserva nada";
      return fail("INVALID_INPUT", message, { error: message });
    }
    // Asking for an owner and getting an anonymous slot instead is the one
    // outcome that must not happen quietly: the caller would believe its run
    // holds a reservation nobody can attribute to it.
    let owner: string | undefined;
    if (code !== undefined) {
      const resolution = await resolveSessionTarget(ctx.fs, ctx.paths, { code });
      if (resolution.outcome !== "resolved") {
        const message = `no se pudo resolver la sesión '${code}' que reclamaría el correlativo`;
        return fail("INVALID_INPUT", message, { error: message, sessionError: resolution });
      }
      owner = resolution.session.folder;
    }
    const data = await runNextNumber(ctx.fs, ctx.env, ctx.paths, {
      directory: dir,
      dryRun: args.flags.has("--dry-run"),
      ...(claim !== undefined ? { claim } : {}),
      ...(owner !== undefined ? { owner } : {}),
    });
    return { ok: true, data, exitCode: 0 };
  },
};
