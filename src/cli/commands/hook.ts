import { text } from "node:stream/consumers";
import { runBranchCheckHook } from "../../application/hook-branch-check.js";
import { runGitCommitAdvisor } from "../../application/hook-git-commit-advisor.js";
import { runSqlMutationGuard } from "../../application/hook-sql-mutation-guard.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail, writeStderr } from "../render.js";
import type { CliContext } from "../types.js";

export const hookCommand: QtcCommand = {
  name: "hook",
  describe:
    "PreToolUse hook target. Subcommands: branch-check, sql-mutation-guard, git-commit-advisor.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const subcommand = args.rest[0];
    if (!subcommand) {
      return fail(
        "INVALID_INPUT",
        "hook requires a subcommand: branch-check | sql-mutation-guard | git-commit-advisor",
      );
    }
    const stdin = await text(process.stdin);
    if (subcommand === "branch-check") {
      const result = await runBranchCheckHook({
        stdin,
        fs: ctx.fs,
        env: ctx.env,
        git: ctx.git,
        paths: ctx.paths,
        displayName: ctx.runtime.displayName ?? ctx.namespace.namespace,
      });
      if (result.stderr) writeStderr(result.stderr);
      return { ok: true, data: undefined, exitCode: result.exitCode };
    }
    if (subcommand === "sql-mutation-guard") {
      const result = runSqlMutationGuard({ stdin, env: ctx.env, runtime: ctx.runtime });
      if (result.stderr) writeStderr(result.stderr);
      return { ok: true, data: undefined, exitCode: result.exitCode };
    }
    if (subcommand === "git-commit-advisor") {
      const result = await runGitCommitAdvisor({
        stdin,
        fs: ctx.fs,
        env: ctx.env,
        paths: ctx.paths,
        displayName: ctx.runtime.displayName ?? ctx.namespace.namespace,
      });
      if (result.stderr) writeStderr(result.stderr);
      return { ok: true, data: undefined, exitCode: result.exitCode };
    }
    return fail("INVALID_INPUT", `hook: unknown subcommand '${subcommand}'`);
  },
};
