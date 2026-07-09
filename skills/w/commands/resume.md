---
description: Use when the user asks to resume or pick up pending work — a half-done session, a spec to refine, a plan mid-execution, or work with no Workline flow at all. Composes /w:status for the prioritized summary, then proposes how to continue via structured-choice routed to the right command. Transversal (not a flow), read-only; never touches docs/ or .workflow/. Backed by aw status + aw resume-summary.
argument-hint: (no arguments)
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# resume — pick up pending work (transversal)

Summarizes what is pending in the workspace and proposes how to continue. Single-pass, **read-only**: no loop, no session, writes nothing in `docs/` or `.workflow/`. **Transversal** command (belongs to no SPEC/PLAN/QUICK flow). The **actionable sibling of `/w:status`**: it composes the `/w:status` summary and adds a proposal layer. User-facing output in the user's language.

> **Not `aw session-resume` / `aw resume-summary` / `create_or_resume`.** Those are internal session mechanics (reopen a session, the PostCompact payload, loop resume). `/w:resume` is the **user-facing** command that *summarizes + proposes*; it never runs the pending work — it routes to the command that does.

> **Hard floor — applies even if you read nothing beyond this file:**
>
> 1. **Read-only** — never execute the pending work and never write `docs/` or `.workflow/`. Routing means handing off to the target command; the user drives it.
> 2. **Summary always, question only when pending** — show the prioritized summary every time; ask **only** when there is at least one pending item.
> 3. **Ask via structured-choice** — the proposal is a structured-choice with the top ≤3 concrete options, recommendation first. Never route silently.
> 4. **Language** — headings in English (parse contract); user-facing output in the **user's language**.

## Run

1. **Workline level — compose `/w:status`.** Read-and-follow [`status.md`](status.md) to produce the prioritized summary (it already renders `aw status` and, when available, the host-context section). Do **not** re-implement the summary. For deeper session detail, `aw resume-summary [--include-recent-closed]` gives the primary session's CHECKPOINT state, and `aw session-resume --code <NNN>` the full checkpoint of any other active or closed session.
2. **Interpret the stage marks.** Map each signal to its stage: spec `refined` / `open_questions`; plan checkbox progress (`tasks_done` / `tasks_total`); session `checkpoint_present` / `status`. Associate a session to its plan or spec by **slug** — there is no linkage field, so infer it from `folder` / `slug`.
3. **Build the prioritized pending list** — fixed order: **session with CHECKPOINT > plan half-done > spec unrefined > host context**.
4. **Host level (second source).** If the workline level does not explain the pending work (or no Workline flow was used), rely on the host-context already surfaced by `/w:status`; escalate it to a proposal and, only if needed, use the host-memory *deep* tier or ask the user (universal fallback: git / `docs/` signals + a question). See [`../harness/HARNESS.md`](../harness/HARNESS.md) § *host-memory*.
5. **Propose (only when ≥1 pending).** One structured-choice with the top ≤3 options by the priority order; each option **routes** to its command (table below). Every proposal carries `Retomar` (recommended) and `Descartar` / `Cerrar` (secondary).
6. **Nothing pending.** Show the `/w:status` summary and state clearly that there is nothing pending — **do not ask**.

## Routing (stage → command)

Priority: **session+CHECKPOINT > plan half-done > spec unrefined > host context**.

| Pending detected | `Retomar` (recommended) | Secondary |
|---|---|---|
| spec unrefined | `/w:spec-refine` | `Descartar` |
| spec refined, no plan | `/w:plan-new` | `Descartar` |
| plan half-done (checkboxes) | `/w:plan-exec` | `Cerrar` |
| active session with CHECKPOINT | continue / reopen (`aw session-resume --reopen`) | `Cerrar` |
| host context only (no workline) | best next step for what was found | `Descartar` |

Reuses the continuity rule of [`../SKILL.md`](../SKILL.md) § *Operating context* — it synthesizes the route from the `/w:status` summary + that rule; it does not re-implement it.

## Plan mode

Read-only already: compose `/w:status`, describe the prioritized summary and the proposal it would offer (top ≤3 routed options), without asking or writing.

## Resources

- Composes: [`status.md`](status.md) (the summary) · Capability: `host-memory` ([`../harness/HARNESS.md`](../harness/HARNESS.md))
- CLI: `aw status` · `aw resume-summary [--include-recent-closed]` · `aw session-resume --code <NNN> [--reopen]`
- Continuity rule: [`../SKILL.md`](../SKILL.md) § *Operating context*
- Design reference: `docs/referencias/workflow-skills/resume.md`
