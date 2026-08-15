import { type WorktreeInput, runWorktree } from "../../application/worktree-service.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId } from "../context-id.js";
import { type ParsedArgs, flagValue, sessionCodeFlag } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

const ACTIONS = new Set<WorktreeInput["action"]>(["ensure", "list", "release", "integrate"]);

export const worktreeCommand: CliCommand = {
  name: "worktree",
  describe:
    "Isolation unit of a flow: one git worktree of a source on its own branch, so concurrent flows never share a working tree. " +
    "The unit lives at ~/<ns>/worktrees/<workspace>/<alias>/<session> on branch aw/<session>; the path IS the registry and " +
    "`git worktree list` its live view. `integrate` merges the flow's branch into the source's declared working branch and gives the unit back — " +
    "one source with --source, or every unit of the session in alias order with only --code; a conflict is reported with its plan, files and " +
    "source path and routed to `aw fix-git --path`, never resolved on its own. " +
    "`list` shows every unit and orphan of the workspace, or only one session's with --code, each with its branch, dirty state and HEAD. " +
    "Usage: aw worktree ensure|list|release|integrate [--source <alias>] [--code <NNN>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const action = args.rest[0] as WorktreeInput["action"] | undefined;
    if (action === undefined || !ACTIONS.has(action)) {
      const usage = "uso: worktree ensure|list|release|integrate [--source <alias>] [--code <NNN>]";
      return fail("INVALID_INPUT", usage, { error: usage });
    }
    const alias = flagValue(args, "source");
    const session = sessionCodeFlag(args);
    if (!session.ok) return fail("INVALID_INPUT", session.message, { error: session.message });
    const contextId = readContextId(ctx.env);

    const input: WorktreeInput = { action };
    if (alias !== undefined) input.alias = alias;
    if (session.code !== undefined) input.sessionCode = session.code;
    // The conversation's own binding resolves the unit a VERB acts on. `list` is
    // the inventory — including the orphans nobody is coming back for — so it
    // narrows only when the caller names a session out loud.
    if (contextId !== undefined && action !== "list") input.contextId = contextId;

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
