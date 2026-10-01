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
  help: {
    purpose:
      "Manage a flow's isolation unit: one git worktree of a source on its own branch, so concurrent flows never share a working tree.",
    args: "<ensure|list|release|integrate|reclaim>",
    flags: {
      code: {
        value: "<code>",
        effect:
          "Session whose units to act on; defaults to the conversation's session (list and reclaim default to the whole hub).",
      },
      session: { value: "<code>", effect: "Alias of --code." },
      source: { value: "<alias>", effect: "Source whose unit to act on." },
    },
    output:
      "ensure: {alias, source_path, session, path, branch, created, visibility, base, dependencies, longpaths_enabled}. list: {hub_key, units[] (with session_active, dirty, head), orphans[], unreadable[], session?}. release: {alias, session, path, branch, released, visibility, branch_kept?, residue_completed?}. integrate with --source: {alias, source_path, session, into, branch, integrated, conflicted[], released, next, unit_path?, merge_path?}; without it: {session, plan, results[], integrated[], pending[], reclaimed[], retained[], next}. reclaim: {hub_key, session?, reclaimed[], retained[], unreadable[], next}. Refusal: {error, message, hint?, occupant?}.",
    exit_codes: {
      "2": "The unit is occupied by another live flow or the action was refused; data is {error, message, hint?, occupant?}.",
    },
    notes: [
      "The unit lives at ~/<ns>/worktrees/<hub>/<alias>/<session> on branch aw/<session>; the path IS the registry and `git worktree list` its live view.",
      "integrate moves the work to the unit's sealed base without switching the checkout and gives the unit back: one source with --source, or every unit of the session in alias order with only --code. A conflict is reported with its plan, files and the path where the merge stopped; resolve it externally and retry, it is never resolved or aborted automatically.",
      "list shows every unit and orphan of the hub, or one session's with --code, each with its branch, dirty state and HEAD.",
      "reclaim collects the residue in one act (every orphan of the hub, or one session's units with --code), reaching closed or gone sessions without reopening any. A unit that still holds work SURVIVES: uncommitted changes, a half-resolved git operation, commits outside its sealed base, or a read that could not complete. It reports what it collected and retained, with the reason and next step per retention; it never uses --force and keeps the document and base branches.",
    ],
  },
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
