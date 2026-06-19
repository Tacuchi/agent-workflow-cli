import { runProjectMdUpsertWrite } from "../../application/project-md-upsert-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const setWorkingBranchCommand: QtcCommand = {
  name: "set-working-branch",
  describe:
    "Set the WORKING branch for a source in the WORKSPACE block. Usage: aw set-working-branch <alias> <rama>.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const alias = args.rest[0];
    const rama = args.rest[1];
    if (!alias || !rama) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "Usage: aw set-working-branch <alias> <rama>",
        },
        exitCode: 1,
      };
    }

    const data = await runProjectMdUpsertWrite(ctx.fs, ctx.env, ctx.paths, {
      op: "init",
      workingBranches: { [alias]: rama },
      verbose: args.flags.has("--verbose"),
    });
    if ("error" in data) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: data.error },
        data,
        exitCode: 1,
      };
    }
    return { ok: data.ok, data, exitCode: data.ok ? 0 : 1 };
  },
};
