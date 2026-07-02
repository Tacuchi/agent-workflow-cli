import { runCompressCheckpoint } from "../../application/checkpoint-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const compressCheckpointCommand: QtcCommand = {
  name: "compress-checkpoint",
  describe:
    "Identify long artifacts that should be compressed (HALLAZGOS/EVIDENCIA/...). " +
    "Usage: aw compress-checkpoint [--code <session>] [--threshold <chars>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const thresholdRaw = args.values.get("threshold");
    const options: Parameters<typeof runCompressCheckpoint>[3] = {};
    if (code !== undefined) options.code = code;
    if (thresholdRaw !== undefined) {
      const n = Number.parseInt(thresholdRaw, 10);
      if (Number.isFinite(n)) options.threshold = n;
    }
    const data = await runCompressCheckpoint(ctx.fs, ctx.env, ctx.paths, options);
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
