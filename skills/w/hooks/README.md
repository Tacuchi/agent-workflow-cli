# hooks — host hook template

`hooks.template.json` wires the host (Claude Code) to the `agent-workflow` runtime hooks. Merge it into your host's user-level hook config (e.g. `~/.claude/settings.json`); the installer does this automatically for Claude.

| Event | Hook | Purpose |
|---|---|---|
| `SessionStart` | namespace pin | Pins the workspace namespace to `workflow` (so `.workflow/` resolves). |
| `PreToolUse` (Edit/Write) | `hook branch-check` | Verifies the expected work branch before any file edit (git-safe invariant). |
| `PreToolUse` (`execute_sql`) | `hook sql-mutation-guard` | Blocks DML/DDL over MCP — reads only (DB scripts-only invariant). |
| `PreToolUse` (Bash) | `hook git-commit-advisor` | Advises on commit policy (propose-then-execute, no `push`/`--amend`/`--no-verify`). |
| `SessionEnd` | `auto-compact-on-close` | Persists pending state on close. |
| `PreCompact` | `checkpoint-write` | Writes `CHECKPOINT.md` before the host compacts. |
| `PostCompact` | `resume-summary` | Recovers the active loop state after a compact. |

> These hooks enforce invariants 4 (DB scripts-only) and 5 (git-safe) at the host level, independent of the loop logic. The hook commands are runtime CLI subcommands (`agent-workflow hook …`), unchanged across the bundle namespace.
