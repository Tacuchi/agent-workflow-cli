---
description: Use when a merge left conflicts to resolve. `aw fix-git` shows the three versions, validates, owns edit/stage/commit.; stops on recreated upstreams.
argument-hint: "[--source <alias> | --path <ruta>]"
allowed-tools: ["Bash", "Read"]
---

# fix-git — merge conflicts

No loop, no session, never writes `docs/`. Any repo; output in the user's language.

**Hard floor:**

1. **You supply content; the CLI owns the effects.** Never edit a conflicted file, never `git add`/`commit` by hand.
2. **Only unambiguous resolutions** — what evidence cannot settle is `state: "ambiguous"`; never take a whole side blind.
3. **The commit is separate**, always confirmed, message proposed first. Never `--no-verify`/`--amend`/push/`--force`/`reset --hard`/`merge --abort` — proposed, never run.
4. **Recreated upstream = STOP.** First: `git fetch`, READ it — `forced update` = branch re-created upstream; corroborate: `git rev-list --left-right --count HEAD...@{upstream}` both > 0. Those commits were retired — never merge or push them back; propose re-sync (backup `respaldo-<fecha>` + `reset --hard @{upstream}`). Merging `<branch>` → check `<branch>...<branch>@{upstream}` too. No upstream → warn.

## Run

1. After rule 4: `aw fix-git prepare --format human [--source <alias> | --path <ruta>]` — direction (`theirs → ours`), paths, stages, blob hashes. None in progress: one requested → `git -C <path> merge <branch>`, else nothing to resolve.
2. Resolve each conflict from `base`/`ours`/`theirs` (ancestor/HEAD/incoming) by *intent*: one side, a mix, or a rewrite.
3. One JSON answer: `version`, `operation`, `input_digest` verbatim, `state: "proposed"`, `artifacts` = complete `{ path, content }` per file.
   - Cannot settle → `state: "ambiguous"` with `reason`. Binary → rejected; propose `git checkout --ours|--theirs`.
4. `echo '<json>' | aw fix-git apply --format human [--source …]` — valid while the set is unambiguous and current; rejections name cause and next action, nothing written — fix and repeat.
5. Propose the merge commit; on approval `aw fix-git commit --message "<mensaje>" --confirm`.

## What the CLI decides

- **Writable paths**: files still unmerged; blob hashes seal the set — stale conflicts fail.
- **Resolved**: leftover `<<<<<<<`/`=======`/`>>>>>>>` is a rejection.
- **Can close**: `commit` refuses with a file unmerged.

## More context

`aw context-plan --command fix-git --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` lists extra reads.
