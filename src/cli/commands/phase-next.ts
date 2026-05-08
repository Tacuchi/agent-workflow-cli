import { runPhaseNext } from "../../application/phase-next-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { writeStdout } from "../render.js";
import type { CliContext } from "../types.js";

export const phaseNextCommand: QtcCommand = {
  name: "phase-next",
  describe: "Advance session phase to the next slot in the lifecycle.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const data = await runPhaseNext(ctx.fs, ctx.env, ctx.paths, code);
    if ("error" in data) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: data.error },
        data,
        exitCode: 1,
      };
    }
    if (data.projectMd) {
      writeStdout(`${JSON.stringify(data.projectMd, null, 2)}\n`);
    }
    return { ok: true, data: data.phaseNext, exitCode: 0 };
  },
};
