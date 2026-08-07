import { type WorktreeInput, runWorktree } from "../../application/worktree-service.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId } from "../context-id.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

const ACTIONS = new Set<WorktreeInput["action"]>(["ensure", "list", "release"]);

export const worktreeCommand: QtcCommand = {
  name: "worktree",
  describe:
    "Isolation unit of a flow: one git worktree of a source on its own branch, so concurrent flows never share a working tree. " +
    "The unit lives at ~/<ns>/worktrees/<workspace>/<alias>/<session> on branch aw/<session>; the path IS the registry and " +
    "`git worktree list` its live view. Usage: aw worktree ensure|list|release [--source <alias>] [--code <NNN>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const action = args.rest[0] as WorktreeInput["action"] | undefined;
    if (action === undefined || !ACTIONS.has(action)) {
      const usage = "uso: worktree ensure|list|release [--source <alias>] [--code <NNN>]";
      return fail("INVALID_INPUT", usage, { error: usage });
    }
    const alias = flagValue(args, "source");
    const code = args.values.get("code");
    const contextId = readContextId(ctx.env);

    const input: WorktreeInput = { action };
    if (alias !== undefined) input.alias = alias;
    if (code !== undefined) input.sessionCode = code;
    if (contextId !== undefined) input.contextId = contextId;

    const data = await runWorktree(
      { fs: ctx.fs, env: ctx.env, git: ctx.git, paths: ctx.paths },
      input,
    );
    if ("error" in data) {
      // The unit is occupied by another live flow: a real, expected outcome of
      // concurrency, so it exits non-zero with the occupant named instead of
      // pretending the caller now owns a tree it does not.
      return { ok: true, data, exitCode: 2 };
    }
    return { ok: true, data, exitCode: 0 };
  },
};
