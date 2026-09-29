import { runStack } from "../../application/stack-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const stackCommand: CliCommand = {
  name: "stack",
  flags: { known: ["project-dir"] },
  help: {
    purpose: "Detect the project's stack: language, framework, database and build tool.",
    flags: {
      "project-dir": {
        value: "<dir>",
        effect: "Inspect this directory instead of the current one.",
      },
    },
    output: "{language, framework, db, build, wrapper}; each is null when not detected.",
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const projectDir = args.values.get("project-dir");
    const data = await runStack(ctx.fs, ctx.env, projectDir !== undefined ? { projectDir } : {});
    return { ok: true, data, exitCode: 0 };
  },
};
