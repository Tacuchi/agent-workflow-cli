import { runPhaseDetect } from "../../application/phase-detect-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const phaseDetectCommand: QtcCommand = {
  name: "phase-detect",
  describe: "Suggest current session phase from artifacts (no mutation).",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const data = await runPhaseDetect(ctx.fs, ctx.env, ctx.paths, code);
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
