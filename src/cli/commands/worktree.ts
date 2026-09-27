import { type WorktreeInput, runWorktree } from "../../application/worktree-service.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId } from "../context-id.js";
import { type ParsedArgs, flagValue, sessionCodeFlag } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

const ACTIONS = new Set<WorktreeInput["action"]>([
  "ensure",
  "list",
  "release",
  "integrate",
  "reclaim",
]);

export const worktreeCommand: CliCommand = {
  name: "worktree",
  flags: { known: ["code", "session", "source"] },
  describe:
    "Isolation unit of a flow: one git worktree of a source on its own branch, so concurrent flows never share a working tree. " +
    "The unit lives at ~/<ns>/worktrees/<workspace>/<alias>/<session> on branch aw/<session>; the path IS the registry and " +
    "`git worktree list` its live view. `integrate` moves work to the unit's sealed base, without switching the checkout, and gives the unit back — " +
    "one source with --source, or every unit of the session in alias order with only --code; a conflict is reported with its plan, files and " +
    "path where the merge stopped and routed to `aw fix-git --path <reported path>`, never resolved on its own. " +
    "`list` shows every unit and orphan of the workspace, or only one session's with --code, each with its branch, dirty state and HEAD. " +
    "`reclaim` collects the residue in one act — every orphan of the workspace, or one session's units with --code — reaching sessions that are " +
    "closed or gone without reopening any. A unit that still custodies work SURVIVES: uncommitted changes, a half-resolved git operation, commits " +
    "outside the unit's sealed base, or a read that could not be completed. It reports what it collected and what it retained, with the reason " +
    "and the next step for each retention; it never uses --force and preserves the document and base branches. " +
    "Usage: aw worktree ensure|list|release|integrate|reclaim [--source <alias>] [--code <NNN>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const action = args.rest[0] as WorktreeInput["action"] | undefined;
    if (action === undefined || !ACTIONS.has(action)) {
      const usage =
        "uso: worktree ensure|list|release|integrate|reclaim [--source <alias>] [--code <NNN>]";
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
    // narrows only when the caller names a session out loud. `reclaim` acts on
    // that same inventory and for the same reason: bound to the caller's session
    // it would sweep only that one and leave standing exactly the residue nobody
    // is coming back for.
    if (contextId !== undefined && action !== "list" && action !== "reclaim") {
      input.contextId = contextId;
    }

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
