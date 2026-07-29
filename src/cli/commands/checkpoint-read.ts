import { runCheckpointRead } from "../../application/checkpoint-service.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { failSessionResolution } from "../render.js";
import type { CliContext } from "../types.js";

export const checkpointReadCommand: QtcCommand = {
  name: "checkpoint-read",
  describe:
    "Read CHECKPOINT.md of the conversation's session (or --code). " +
    "Usage: aw checkpoint-read [--code <session>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const contextId = readContextId(ctx.env);
    const data = await runCheckpointRead(ctx.fs, ctx.paths, {
      ...(code !== undefined ? { code } : {}),
      ...(contextId !== undefined ? { contextId } : {}),
    });
    if ("sessionError" in data) return failSessionResolution(data.sessionError);
    return { ok: true, data, exitCode: 0 };
  },
};
