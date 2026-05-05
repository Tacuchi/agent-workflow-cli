import { runBranchCheckHook } from "../../application/hook-branch-check.js";
import { runSqlMutationGuard } from "../../application/hook-sql-mutation-guard.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { writeStderr } from "../render.js";
import type { CliContext } from "../types.js";

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk.toString();
  }
  return data;
}

export const hookCommand: QtcCommand = {
  name: "hook",
  describe: "PreToolUse hook target. Subcommands: branch-check, sql-mutation-guard.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const subcommand = args.rest[0];
    if (!subcommand) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "hook requires a subcommand: branch-check | sql-mutation-guard",
        },
        exitCode: 1,
      };
    }
    const stdin = await readStdin();
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
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: `hook: unknown subcommand '${subcommand}'` },
      exitCode: 1,
    };
  },
};
