import { runStack } from "../../application/stack-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const stackCommand: QtcCommand = {
  name: "stack",
  describe:
    "Detect stack of the project (language/framework/db/build). " +
    "Usage: aw stack [--project-dir <dir>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const projectDir = args.values.get("project-dir");
    const data = await runStack(ctx.fs, ctx.env, projectDir !== undefined ? { projectDir } : {});
    return { ok: true, data, exitCode: 0 };
  },
};
