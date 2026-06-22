import { type MergeStateInput, runMergeState } from "../../application/merge-state-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const mergeStateCommand: QtcCommand = {
  name: "merge-state",
  describe:
    "Inspect in-progress merge state per repo, read-only (origin/destination + conflicted files). " +
    "Usage: aw merge-state [<repo-path>] [--source <alias>] [--all]. Works on any repo (no workspace needed). " +
    "Exit 2 when a merge is in progress.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: MergeStateInput = {};
    const path = args.rest[0];
    if (path !== undefined) input.path = path;
    // `--source` is a multi-value flag (parser); take the last occurrence, `values` as fallback.
    const sourceMulti = args.valuesMulti.get("source");
    const source =
      sourceMulti && sourceMulti.length > 0
        ? sourceMulti[sourceMulti.length - 1]
        : args.values.get("source");
    if (source !== undefined) input.source = source;
    if (args.flags.has("--all")) input.all = true;

    const data = await runMergeState(ctx.fs, ctx.git, ctx.env, ctx.paths, input);
    // A merge in progress is an expected, actionable state → exit 2 (like git-flow
    // conflict / check-branch --strict) so callers/loops can detect "needs resolution".
    const exit: 0 | 2 = data.any_merging ? 2 : 0;
    return { ok: true, data, exitCode: exit };
  },
};
