import {
  runHarness,
  runLogs,
  runNextNumber,
  runProfiles,
} from "../../application/dev-only-services.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const harnessCommand: QtcCommand = {
  name: "harness",
  describe: "Detect host harness (claude-code | codex | unknown).",
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = runHarness((k) => ctx.env.get(k));
    return { ok: true, data, exitCode: 0 };
  },
};

export const profilesCommand: QtcCommand = {
  name: "profiles",
  describe: "Resolve user preferences from ~/.qtc/user-config.md.",
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runProfiles(ctx.fs, ctx.paths);
    return { ok: true, data, exitCode: 0 };
  },
};

export const logsCommand: QtcCommand = {
  name: "logs",
  describe: "View or clear qtc-utils log.",
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
  describe: "Compute next NNN correlative for a directory.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const dir = args.rest[0];
    if (!dir) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "uso: next-number <directorio>" },
        data: { error: "uso: next-number <directorio>" },
        exitCode: 1,
      };
    }
    const data = await runNextNumber(ctx.fs, ctx.env, dir);
    return { ok: true, data, exitCode: 0 };
  },
};
