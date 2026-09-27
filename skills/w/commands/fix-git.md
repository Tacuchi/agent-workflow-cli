---
description: Use for merge conflicts. `aw fix-git` summarizes, shows versions on demand, resolves partially and builds before commit; stops on recreated upstreams.
argument-hint: "[--source <alias> | --path <ruta>]"
allowed-tools: ["Bash", "Read"]
---

# fix-git — merge conflicts

No loop, no session, never writes `docs/`. Any repo; output in the user's language.

**Hard floor:**

1. **the CLI owns the effects.** Never edit a conflicted file or `git add`/`commit` by hand. Binary/deletion → `resolutions`.
2. **Only unambiguous resolutions** — what evidence cannot settle is `state: "ambiguous"`; never take a whole side blind.
3. **Commit separately**: preview, approval, `--confirm`; long build timeout. Never `--no-verify`/`--amend`/push/`--force`/`reset --hard`/`merge --abort` — proposed, never run.
4. **Recreated upstream = STOP.** `git fetch`: `forced update` → verify `git rev-list --left-right --count HEAD...@{upstream}` both > 0. Never merge/push retired commits; propose re-sync (backup `respaldo-<fecha>` + `reset --hard @{upstream}`). Check `<branch>...<branch>@{upstream}` too. No upstream → warn.

## Run

1. `aw fix-git prepare [--source <alias> | --path <ruta>]` summarizes kind, binary, bytes, EOL, allowed choices/cap and virtual base. Repeat `--show <ruta>` for versions; `--adapt <ruta>` includes tracked clean files, even after conflicts end.
2. Resolve by intent (`base`/`ours`/`theirs`); inspect code and `git log --merge -p -- <file>` if unclear.
3. Reply JSON copying `version`, `operation`, `input_digest`, any `scope`, `state: "proposed"`, and a subset of `artifacts: [{path,content}]` and/or `resolutions: [{path,choice}]`. Binary → `ours|theirs`; absent stage → `delete`; doubt → `ambiguous` with `reason`.
4. Write file-tool JSON → `aw fix-git apply [--source …] < <file>`. Partial? Repeat; no manual `git add`. No shell JSON.
5. Preview `aw fix-git commit --message "<mensaje>"`: build, included, `left_out`. After approval add `--confirm`; missing/failed build refuses. `ninguno` or `--skip-build "<motivo>"` reports skipped + origin. Use a long host timeout.

## What the CLI decides

- **Writable**: sealed conflicts + requested adaptations; stale stages fail.
- **Resolved**: `<<<<<<<`/`=======`/`>>>>>>>` fails; apply may be partial.
- **Close**: unmerged files or failed/missing build (without explicit skip) refuse commit.

## More context

`aw context-plan --command fix-git --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` lists extra reads.
