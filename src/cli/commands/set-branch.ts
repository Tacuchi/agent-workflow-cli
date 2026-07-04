import { runProjectMdUpsertWrite } from "../../application/project-md-upsert-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

// set-working-branch and set-qa-branch are the same command modulo the label
// and the WORKSPACE-block key they write; the factory keeps them in lockstep.
function makeSetBranchCommand(
  name: string,
  label: string,
  key: "workingBranches" | "qaBranches",
): QtcCommand {
  return {
    name,
    describe:
      `Set the ${label} branch for a source in the WORKSPACE block. ` +
      `Usage: aw ${name} <alias> <rama>.`,
    async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
      const alias = args.rest[0];
      const rama = args.rest[1];
      if (!alias || !rama) {
        return fail("INVALID_INPUT", `Usage: aw ${name} <alias> <rama>`);
      }

      const branches = { [alias]: rama };
      const data = await runProjectMdUpsertWrite(ctx.fs, ctx.env, ctx.paths, {
        op: "init",
        ...(key === "workingBranches" ? { workingBranches: branches } : { qaBranches: branches }),
        verbose: args.flags.has("--verbose"),
      });
      if ("error" in data) {
        return fail("INVALID_INPUT", data.error, data);
      }
      return { ok: data.ok, data, exitCode: data.ok ? 0 : 1 };
    },
  };
}

export const setWorkingBranchCommand = makeSetBranchCommand(
  "set-working-branch",
  "WORKING",
  "workingBranches",
);

export const setQaBranchCommand = makeSetBranchCommand("set-qa-branch", "QA", "qaBranches");
