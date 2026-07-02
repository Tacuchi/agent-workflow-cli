import {
  type GitFlowAction,
  type GitFlowInput,
  runGitFlow,
} from "../../application/git-flow-service.js";
import type { CommandResult } from "../../domain/types.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

const ACTIONS: ReadonlySet<string> = new Set(["sync", "to-qa", "to-prod"]);

export const gitFlowCommand: QtcCommand = {
  name: "git-flow",
  describe:
    "Run a per-source git flow. Usage: aw git-flow <sync|to-qa|to-prod> " +
    "[--source <alias>] [--all] [--target <branch>] [--dry-run].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const action = args.rest[0];
    if (!action || !ACTIONS.has(action)) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message:
            "Usage: aw git-flow <sync|to-qa|to-prod> [--source <alias>] [--all] [--target <branch>] [--dry-run]",
        },
        exitCode: 1,
      };
    }

    const source = flagValue(args, "source");
    const target = flagValue(args, "target");
    const input: GitFlowInput = { action: action as GitFlowAction };
    if (source !== undefined) input.source = source;
    if (target !== undefined) input.target = target;
    if (args.flags.has("--all")) input.all = true;
    if (args.flags.has("--dry-run")) input.dryRun = true;

    const data = await runGitFlow(ctx.fs, ctx.git, ctx.paths, input);
    if (data.status === "error") {
      return {
        ok: false,
        error: { code: "GIT_FLOW_ERROR", message: data.error ?? "git-flow failed" },
        data,
        exitCode: 1,
      };
    }
    // A conflict is a paused-but-expected outcome: exitCode 2 (like check-branch
    // strict) so callers/loops can detect "needs resolution" distinct from error.
    const exit: 0 | 2 = data.status === "conflict" ? 2 : 0;
    return { ok: true, data, exitCode: exit };
  },
};
