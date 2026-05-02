import {
  runAutoCompactOnClose,
  runCheckpointWrite,
} from "../../application/checkpoint-write-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const checkpointWriteCommand: QtcCommand = {
  name: "checkpoint-write",
  describe: "Write CHECKPOINT.md draft for the active (or --code) session.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const force = args.flags.has("--force");
    const options: Parameters<typeof runCheckpointWrite>[3] = {};
    if (code !== undefined) options.code = code;
    if (force) options.force = true;
    const data = await runCheckpointWrite(ctx.fs, ctx.env, ctx.git, options);
    return { ok: true, data, exitCode: 0 };
  },
};

export const autoCompactOnCloseCommand: QtcCommand = {
  name: "auto-compact-on-close",
  describe: "SessionEnd hook target — write checkpoints for all active sessions.",
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runAutoCompactOnClose(ctx.fs, ctx.env, ctx.git);
    return { ok: true, data, exitCode: 0 };
  },
};
