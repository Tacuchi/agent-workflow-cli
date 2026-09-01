# hooks — host hook template

`hooks.template.json` wires the host (Claude Code) to the `agent-workflow` runtime hooks. Merge it into your host's user-level hook config (e.g. `~/.claude/settings.json`); the installer does this automatically for Claude.

> **Agnostic binding.** Hooks are **inherently host-specific**: they are the *Claude Code binding* of intents the doctrine states agnostically (DB scripts-only, safe branch, CHECKPOINT on compact/close). Another harness would satisfy the same intents with its own mechanisms; the doctrine does **not** depend on these hooks.

| Event | Hook | Purpose |
|---|---|---|
| `SessionStart` | namespace pin | Pins the workspace namespace to `workflow` (so `.workflow/` resolves). |
| `PreToolUse` (Edit/Write) | `hook branch-check` | Verifies the flow's line of work before any file edit — its isolation unit's branch, or the declared work branch when the source has no units (git-safe invariant). |
| `PreToolUse` (`execute_sql`) | `hook sql-mutation-guard` | Blocks DML/DDL over MCP — reads only (DB scripts-only invariant). |
| `PreToolUse` (Bash) | `hook git-commit-advisor` | **Advisory (does not block)**: warns if a `git commit` message lacks the active session's `sessionNNN` tag (traceability). Does **not** inspect `push`/`--amend`/`--no-verify`. |
| `SessionEnd` | `auto-compact-on-close` | Writes `CHECKPOINT.md` on close — the resume key (*CHECKPOINT always* — chassis § Convergence / exit). |
| `PreCompact` | `checkpoint-write` | Writes `CHECKPOINT.md` before the host compacts. **Never blocks the compaction.** |
| `PostCompact` | `resume-summary` | Recovers **the conversation's own** loop state after a compact. |

> **Conversation identity (spec 011).** The three lifecycle hooks act on **one**
> session — the conversation's own — never on "the first active one" and never
> on all of them. They resolve it with the canonical precedence: explicit
> `--code` → the conversation's durable association → the sole active session.
> The identity travels in the hook payload's `session_id` (read from stdin) or
> in `AW_CONTEXT_ID`; two signals naming different conversations fail with
> `CONTEXT_ID_CONFLICT` instead of picking one. The association lives in
> `.workflow/sessions/.bindings.json` keyed by the SHA-256 of that id — the raw
> value is never persisted.
>
> **An unresolved session never holds a compaction back.** `PreCompact` always
> exits **0**. It used to exit 2 on an ambiguity so a person could name the
> session first, and that trapped the conversation: the remedy it printed does
> not always bind the conversation, so the next `/compact` blocked again. Now the
> host's compaction completes, Workline reports `continuity: "degraded"` with
> `primary_session: null`, and — whenever there is a candidate that could adopt
> it — parks a **refuge checkpoint** in `.workflow/sessions/.refuge/` naming the
> reason, the candidates and the way out. `PostCompact` reports it as `refuge`,
> and the first `checkpoint-write` that does resolve the session (typically
> `--code <NNN>`) folds it into that session's `CHECKPOINT.md` and removes it.
> The refuge names its conversation by the SHA-256 of the id, like the
> association registry. Per-host installation and transport belong to spec 010.

> **What they enforce (host-level, blocking):** invariant **#4** (DB scripts-only) via `sql-mutation-guard` (blocks DML/DDL over MCP), and the *expected-branch* clause of **#5** via `branch-check` (blocks edits on the wrong branch). The rest of git-safe (`push`/`--amend`/`--no-verify`/`--force`) is **doctrinal** — `git-commit-advisor` only **warns**, it does not block; a host may add its own deny hook if it wants hard enforcement.
>
> **Commands:** the three `PreToolUse` hooks are `agent-workflow hook <branch-check|sql-mutation-guard|git-commit-advisor>` subcommands; the lifecycle hooks (`auto-compact-on-close`, `checkpoint-write`, `resume-summary`) are **top-level** runtime commands (`agent-workflow <cmd>`).
>
> **Portability (`SessionStart`).** The namespace-pin hook invokes the binary directly — `agent-workflow self namespace --pin workflow` — which writes `~/.config/agent-workflow/namespace` cross-platform via Node `fs` (no shell, no literal `$HOME`), the same portable-argv shape every other hook uses. It replaced the old `sh -c` + `$HOME` one-liner, which was the only hook that could not run on Windows.
