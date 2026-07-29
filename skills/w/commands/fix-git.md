---
description: Use when a merge left conflicts to resolve. `aw fix-git` hands you the three versions of each conflict, validates your resolution and owns edit, stage and commit. Git-safe, transversal, never touches docs/.
argument-hint: "[--source <alias> | --path <ruta>]"
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# fix-git — merge conflicts

No loop, no session, never writes `docs/`. Any git repo, workspace or not. Output in the **user's language**.

**Hard floor:**

1. **You supply content; the CLI owns the effects.** Never edit a conflicted file, never `git add` or `git commit` by hand.
2. **Only unambiguous resolutions** — what evidence cannot settle is `state: "ambiguous"`; never guess a side.
3. **The commit is separate**, always confirmed, message proposed first. Never `--no-verify`, `--amend` or push.
4. **Never `git merge --abort` yourself** — propose it; the user decides.

## Run

1. `aw fix-git prepare --format human [--source <alias> | --path <ruta>]` — merge direction (`theirs → ours`), conflicted paths, their three stages and blob hashes; inspector `aw merge-state`.
2. Resolve each conflict from `base` (ancestor), `ours` (HEAD) and `theirs` (incoming) by *intent*, not text: one side, a combination, or a rewrite of both.
3. One JSON answer: `version`, `operation`, `input_digest` verbatim, `state: "proposed"`, `artifacts` = one complete `{ path, content }` per conflicted file.
   - Cannot settle it → `state: "ambiguous"` with `reason`, nothing written. Binary conflict → rejected; propose `git checkout --ours|--theirs`.
4. `echo '<json>' | aw fix-git apply --format human [--source …]` — authorized while the set is unambiguous and current. A rejection names its cause and next action; nothing was written — fix and repeat.
5. Propose the merge commit; on approval `aw fix-git commit --message "<mensaje>" --confirm`.

> **No merge in progress?** User asked to merge a branch → run `git -C <path> merge <branch>` and continue; otherwise say nothing is left to resolve.

## What the CLI decides (do not re-derive)

- **Writable paths**: only files still unmerged — anything else is rejected, and blob hashes seal the set: a moved conflict fails stale.
- **Resolved**: leftover `<<<<<<<` / `=======` / `>>>>>>>` is a rejection.
- **Can close**: `commit` refuses while a file stays unmerged.

## More context

`aw context-plan --command fix-git --signal <s>` returns the extra documents a case needs; read exactly what it lists.
