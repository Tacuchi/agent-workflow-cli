---
description: Use when the user asks "what's the state", "what got done", or "where are we". Read-only workspace dashboard — the pending pipeline by default, the full history under detail — optionally enriched with host context when the host exposes cheap memory. Backed by `aw status`. Transversal command (not a flow); writes nothing.
argument-hint: (no arguments — pass `detalle` for the full inventory)
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# status — workspace state (read-only)

Single-pass, read-only: no loop, no sessions, writes nothing in `docs/` or `.workflow/`. **Transversal** command (belongs to no flow).

## Run

1. Run `aw status --format human` — add `--detail` when the user asked for the full inventory ("detalle", "todo", "historial").
2. **Relay its output verbatim.** The CLI already selects, filters, groups and humanizes the dates; re-rendering it here is what made the two drift apart. Do not paraphrase it, do not re-sort it, do not add or drop a line.
3. **Host context (opportunistic, read-only).** After the dashboard, if the host exposes *cheap* host-memory (see [`../harness/HARNESS.md`](../harness/HARNESS.md) § *host-memory* — e.g. the auto-memory `MEMORY.md` on Claude Code), append a `▸ CONTEXTO DEL HOST` section with a few signals of recent focus relevant to this workspace. No cheap host memory → **omit the section silently**. Never run an expensive transcript scan and **never ask**.

> **The default view is what is LEFT TO DO** — unrefined specs, refined specs with no plan, plans not `done`. Finished history, sessions and discarded items are still in the model; `--detail` brings them back. If the user asks about something the default hides, re-run with `--detail` instead of explaining its absence.

> **Automation reads JSON.** Through a pipe, and with `--json` or `--format json`, `aw status` emits the same machine-readable envelope it always has. `--detail` belongs to the human projection only.

Uninitialized workspace (`initialized: false`, everything empty) → say the folder is not an agent-workflow workspace and suggest `/w:workspace-init`.

## Plan mode

Same as execution: `aw status --format human` is read-only. There are no changes to apply.

## Resources

- CLI: `aw status` (index `workline-index-service`, projection `status-service`; dates via `humanize-es`)
- Sibling: `aw resume` — what to pick up next, from the same index
- Capability: `host-memory` ([`../harness/HARNESS.md`](../harness/HARNESS.md)) — cheap tier only, opportunistic, silent-omit, never asks
- Design reference: `docs/referencias/workflow-skills/status.md`
