import {
  isHarnessId,
  runHarness,
  runLogs,
  runNextNumber,
  runProfiles,
} from "../../application/dev-only-services.js";
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
    "Compute next NNN correlative for a directory, creating it when missing. Usage: aw next-number <directorio> [--dry-run].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const dir = args.rest[0];
    if (!dir) {
      const usage = "uso: next-number <directorio> [--dry-run]";
      return fail("INVALID_INPUT", usage, { error: usage });
    }
    const data = await runNextNumber(ctx.fs, ctx.env, {
      directory: dir,
      dryRun: args.flags.has("--dry-run"),
    });
    return { ok: true, data, exitCode: 0 };
  },
};
