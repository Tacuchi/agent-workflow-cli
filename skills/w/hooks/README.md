# hooks — host hook template

`hooks.template.json` wires the host (Claude Code) to the `agent-workflow` runtime hooks. Merge it into your host's user-level hook config (e.g. `~/.claude/settings.json`); the installer does this automatically for Claude.

> **Agnostic binding.** Hooks are **inherently host-specific**: they bind DB scripts-only and CHECKPOINT continuity to the host. Workline checks a declared branch locally inside the flow, not on every host edit.

| Event | Hook | Purpose |
|---|---|---|
| `SessionStart` | namespace pin | Pins the workspace namespace to `workflow` (so `.workflow/` resolves). |
| `PreToolUse` (`execute_sql`) | `hook sql-mutation-guard` | Blocks DML/DDL over MCP — reads only (DB scripts-only invariant). |
| `SessionEnd` | `auto-compact-on-close` | Writes `CHECKPOINT.md` on close — the resume key (*CHECKPOINT always* — chassis § Convergence / exit). |
| `PreCompact` | `checkpoint-write` | Writes `CHECKPOINT.md` before the host compacts. **Never blocks the compaction.** |
| `PostCompact` | `resume-summary` | Recovers **the conversation's own** loop state after a compact. |

> **Conversation identity (spec 011, spec 056).** The three lifecycle hooks act
> on **one** session — the conversation's own — never on "the first active one"
> and never on all of them. They resolve it as every write does: explicit
> `--code` → the conversation's durable association. A write **never** falls back
> to the sole active session: it may be another conversation's line, so with no
> identity and an active session it refuses with `SESSION_UNBOUND`, lists the
> active sessions and asks for `--code <NNN>`. Only reads keep that fallback. The identity travels in the
> hook payload's `session_id` (read from stdin) or in `AW_CONTEXT_ID`; two
> signals naming different conversations fail with `CONTEXT_ID_CONFLICT` instead
> of picking one. The association lives in `.workflow/sessions/.bindings.json`
> keyed by the SHA-256 of that id — the raw value is never persisted. Hosts that
> give the agent's commands no id associate nothing, so there the CHECKPOINT is
> always written with `aw checkpoint-write --code <NNN>`.
>
> **An unresolved session never holds a compaction back.** `PreCompact` always
> exits **0**. It used to exit 2 on an ambiguity so a person could name the
> session first, and that trapped the conversation: the remedy it printed does
> not always bind the conversation, so the next `/compact` blocked again. Now the
> host's compaction completes, Workline reports `continuity: "degraded"` with
> `primary_session: null`, says so on stderr (`PreCompact` and `SessionEnd`) and
> parks a **refuge checkpoint** in `.workflow/sessions/.refuge/` naming the
> reason, the **active** candidates and the way out — none at all when no
> session is active. `PostCompact` reports it as `refuge`.
>
> **Who adopts a refuge.** Its own conversation, into whichever session its next
> `checkpoint-write` or `SessionEnd` resolves. Anybody else only with `--code` on one of its candidates, and only
> when nobody else can claim it: it has no conversation, the invocation carries
> no id, or it is older than 24 hours. Adopting folds it into that session's
> `CHECKPOINT.md` and removes it. A refuge nobody can adopt any more — no active
> candidate, and no conversation or past the 24 hours — is swept on the next
> lifecycle write and listed in `refuges_swept`. The refuge names its
> conversation by the SHA-256 of the id, like the association registry.
> Per-host installation and transport belong to spec 010.

> **What the host hook enforces:** DB scripts-only via `sql-mutation-guard` (blocks DML/DDL over MCP). Branch, unit, custody and exact-path commit checks run at their flow boundaries.
>
> **Commands:** `agent-workflow hook sql-mutation-guard` is the `PreToolUse` target. The lifecycle hooks (`auto-compact-on-close`, `checkpoint-write`, `resume-summary`) are **top-level** runtime commands (`agent-workflow <cmd>`).
>
> **Portability (`SessionStart`).** The namespace-pin hook invokes the binary directly — `agent-workflow self namespace --pin workflow` — which writes `~/.config/agent-workflow/namespace` cross-platform via Node `fs` (no shell, no literal `$HOME`), the same portable-argv shape every other hook uses. It replaced the old `sh -c` + `$HOME` one-liner, which was the only hook that could not run on Windows.
