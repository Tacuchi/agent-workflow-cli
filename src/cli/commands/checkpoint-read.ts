import { runCheckpointRead } from "../../application/checkpoint-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const checkpointReadCommand: QtcCommand = {
  name: "checkpoint-read",
  describe: "Read CHECKPOINT.md of the active (or --code) session.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const data = await runCheckpointRead(ctx.fs, ctx.env, ctx.paths, code);
    if ("error" in data) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: data.error },
        data,
        exitCode: 1,
      };
    }
    return { ok: true, data, exitCode: 0 };
  },
};
