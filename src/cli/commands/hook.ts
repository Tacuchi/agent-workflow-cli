import { runBranchCheckHook } from "../../application/hook-branch-check.js";
import { runGitCommitAdvisor } from "../../application/hook-git-commit-advisor.js";
import { runSqlMutationGuard } from "../../application/hook-sql-mutation-guard.js";
import { runTurnStartHook } from "../../application/hook-turn-start.js";
import type { CommandResult } from "../../domain/types.js";
import { readHookStdin } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail, writeStderr, writeStdout } from "../render.js";
import type { CliContext } from "../types.js";

export const hookCommand: CliCommand = {
  name: "hook",
  flags: { known: [], mode: "warn" },
  describe:
    "Hook target. Subcommands: branch-check, sql-mutation-guard, git-commit-advisor, turn-start.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const subcommand = args.rest[0];
    if (!subcommand) {
      return fail(
        "INVALID_INPUT",
        "hook requires a subcommand: branch-check | sql-mutation-guard | git-commit-advisor",
      );
    }
    // Bounded like the lifecycle hooks: run by hand from an agent's shell, fd 0
    // is an idle socket and an unbounded read would hang until the tool timeout.
    const stdin = (await readHookStdin()) ?? "";
    if (subcommand === "turn-start") {
      const result = await runTurnStartHook({
        stdin,
        fs: ctx.fs,
        env: ctx.env,
        git: ctx.git,
        paths: ctx.paths,
      });
      if (result.stdout) writeStdout(result.stdout);
      return { ok: true, data: undefined, exitCode: 0 };
    }
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
      const result = runSqlMutationGuard({
        stdin,
        env: ctx.env,
        runtime: ctx.runtime,
        paths: ctx.paths,
      });
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
