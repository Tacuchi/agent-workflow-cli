import { type MergeStateInput, runMergeState } from "../../application/merge-state-service.js";
import type { CommandResult } from "../../domain/types.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { CliCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const mergeStateCommand: CliCommand = {
  name: "merge-state",
  flags: { known: ["source", "all"] },
  help: {
    purpose:
      "Inspect the in-progress merge of each repository: origin, destination and conflicted files.",
    args: "[<repo-path>]",
    flags: {
      source: { value: "<alias>", effect: "Inspect this hub source." },
      all: { effect: "Inspect every hub source." },
    },
    output:
      "{repos[] {alias, unit?, path, is_repo, is_merging, current_branch, merge_origin, conflicted_files[], dirty, error?}, any_merging, unreadable[] {alias, path, code, action}, notes[]?}.",
    exit_codes: {
      "1": "A source or unit could not be read and no merge was found; ok is still true and data lists unreadable.",
      "2": "A merge is in progress.",
    },
    notes: ["Read-only. With a path, or none, it works on any repository without a hub."],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: MergeStateInput = {};
    const path = args.rest[0];
    if (path !== undefined) input.path = path;
    const source = flagValue(args, "source");
    if (source !== undefined) input.source = source;
    if (args.flags.has("--all")) input.all = true;

    const data = await runMergeState(ctx.fs, ctx.git, ctx.env, ctx.paths, input);
    // A merge in progress is an expected, actionable state → exit 2 (like git-flow
    // conflict / check-branch --strict) so callers/loops can detect "needs resolution".
    const exit: 0 | 1 | 2 = data.any_merging === true ? 2 : data.unreadable.length ? 1 : 0;
    return { ok: true, data, exitCode: exit };
  },
};
