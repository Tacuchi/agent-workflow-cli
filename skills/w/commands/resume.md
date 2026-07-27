---
description: Use when the user asks to resume or pick up pending work — a half-done session, a spec to refine, a plan mid-execution, or work with no Workline flow at all. Composes /w:status and proposes how to continue via structured-choice routed to the right command; an artifact argument (spec, plan or session) skips the survey and gets its exact re-entry route. Transversal (not a flow), read-only; never touches docs/ or .workflow/. Backed by aw status + aw resume-summary.
argument-hint: "[docs/specs/… | docs/plans/… | session NNN]"
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# resume — pick up pending work (transversal)

Summarizes what is pending in the workspace and proposes how to continue. Single-pass, **read-only**: no loop, no session, writes nothing in `docs/` or `.workflow/`. **Transversal** command (belongs to no SPEC/PLAN/QUICK flow). The **actionable sibling of `/w:status`**: it composes the `/w:status` summary and adds a proposal layer. With an **argument** (a spec, plan or session) it skips the survey and proposes the exact re-entry route for that artifact (§ *Directed resume*). User-facing output in the user's language.

> **Not `aw session-resume` / `aw resume-summary` / `create_or_resume`.** Those are internal session mechanics (reopen a session, the PostCompact payload, loop resume). `/w:resume` is the **user-facing** command that *summarizes + proposes*; it never runs the pending work — it routes to the command that does.

> **Hard floor — applies even if you read nothing beyond this file:**
>
> 1. **Read-only** — never execute the pending work and never write `docs/` or `.workflow/`, **with or without an argument**. Routing means handing off to the target command; the user drives it.
> 2. **Summary always, question only when pending** — without an argument, show the prioritized summary every time and ask **only** when there is at least one pending item; with an argument, the directed route (§ *Directed resume*) replaces the survey.
> 3. **Ask via structured-choice** — the proposal is a structured-choice with the top ≤3 concrete options, recommendation first. Never route silently.
> 4. **Language** — headings in English (parse contract); user-facing output in the **user's language**.

## Directed resume (optional argument)

`$ARGUMENTS` may name an artifact: a spec (`docs/specs/NNN-spec-<slug>.md`), a plan (`docs/plans/PPP-plan-<slug>.md`) or a session (`NNN` code or `NNN-<slug>-<flow>` folder). Empty → the survey flow below (`## Run`). With an argument:

1. **Derive the slug** from the artifact name (session code `NNN` → resolve the folder via `aw sessions --state all`).
2. **Locate the candidate sessions**: `aw sessions --state all` (and `aw resume-summary --include-recent-closed` for checkpoint detail) filtered by that slug.
3. **Confirm by `## Origin`**: read the candidates' `SESSION.md` — the `## Origin` names the spec/plan the session came from; it, not the slug match, decides the association.
4. **Propose the exact route** via structured-choice, per the `## Routing` table with the artifact's path filled in (`Retomar` recommended, `Descartar`/`Cerrar` secondary). No candidate session and no clear stage → say so and fall back to the survey flow.

Same hard floor: this mode **proposes** the route — it never starts the target command itself.

## Run

1. **Workline level — compose `/w:status`.** Read-and-follow [`status.md`](status.md) to produce the prioritized summary (it already renders `aw status` and, when available, the host-context section). Do **not** re-implement the summary. For deeper session detail, `aw resume-summary [--include-recent-closed]` gives the primary session's CHECKPOINT state, and `aw session-resume --code <NNN>` the full checkpoint of any other active or closed session.
2. **Interpret the stage marks.** Map each signal to its stage: the spec's `status` (`draft`/`refining` = SPEC work still open · `ready-for-plan` = it can go to PLAN) + `open_questions`; plan progress on **all three axes** — checkboxes (`tasks_done` / `tasks_total`), validated phases (`phases_validated` / `phases_total`) and closure (`plan_state`, with `final_validation_pending` and `blocked_phases[]`); session `checkpoint_present`. A `status` that is absent, empty or unknown reads `draft`: that work stays in SPEC and never routes to PLAN on an unreadable mark. Associate a session to its plan or spec by **slug** — there is no linkage field in the `aw status` output, so infer it from `folder` / `slug`; when precision matters, confirm by the session's `## Origin` (§ *Directed resume*).
3. **Build the prioritized pending list** — fixed order: **session with CHECKPOINT > plan half-done > spec not ready > host context**.
4. **Host level (second source).** If the workline level does not explain the pending work (or no Workline flow was used), rely on the host-context already surfaced by `/w:status`; escalate it to a proposal and, only if needed, use the host-memory *deep* tier or ask the user (universal fallback: git / `docs/` signals + a question). See [`../harness/HARNESS.md`](../harness/HARNESS.md) § *host-memory*.
5. **Propose (only when ≥1 pending).** One structured-choice with the top ≤3 options by the priority order; each option **routes** to its command (table below). Every proposal carries `Retomar` (recommended) and `Descartar` / `Cerrar` (secondary).
6. **Nothing pending.** Show the `/w:status` summary and state clearly that there is nothing pending — **do not ask**.

## Routing (stage → command)

Priority: **session+CHECKPOINT > plan half-done > spec not ready > host context**.

> **Every box ticked is not a finished plan.** A plan with `phases_validated` below `phases_total` still has functional state to reach — work implemented, not validated — so it counts as half-done and routes to `/w:plan-exec`, which re-enters at the first phase that is not `validada`. A phase left `bloqueada` routes the same way: `/w:plan-exec` re-enters **through it** to run the validation still pending, and the plan stays open until that phase reads `validada`. A plan with `phases_total: 0` is a legacy plan (no phase marks) and is judged by its checkboxes alone.

> **`plan_state` decides whether a plan is resumable at all.** Only `done` is finished; everything else routes back to `/w:plan-exec` with a different re-entry point. `final_validation_pending: true` means the phases are green but the final validation never ran — the plan re-enters **at that validation**, not at a phase. `inconsistent` means the document contradicts itself (`done` declared over open work, or an unreadable value): the re-entry is **repairing the state first**, and the proposal says so instead of pretending there is work to implement.

| Pending detected | `Retomar` (recommended) | Secondary |
|---|---|---|
| spec not ready (`draft` / `refining`, or a `status` absent or unreadable) | `/w:spec-refine` | `Descartar` |
| spec `ready-for-plan`, no plan | `/w:plan-new` | `Descartar` |
| plan `open` — open checkboxes **or** phases not `validada` | `/w:plan-exec` | `Cerrar` |
| plan `open` with `final_validation_pending` — everything validated, no closure | `/w:plan-exec`, from the final validation | `Cerrar` |
| plan `inconsistent` — `done` over open work, or an unreadable value | `/w:plan-exec`, repairing the state first | `Cerrar` |
| plan `done` | — not resumed automatically | — |
| active session with CHECKPOINT | continue / reopen (`aw session-resume --reopen`) | `Cerrar` |
| host context only (no workline) | best next step for what was found | `Descartar` |

Reuses the continuity rule of [`../SKILL.md`](../SKILL.md) § *Operating context* — it synthesizes the route from the `/w:status` summary + that rule; it does not re-implement it.

## Plan mode

Read-only already: compose `/w:status`, describe the prioritized summary and the proposal it would offer (top ≤3 routed options; with an argument, the exact route it would propose), without asking or writing.

## Resources

- Composes: [`status.md`](status.md) (the summary) · Capability: `host-memory` ([`../harness/HARNESS.md`](../harness/HARNESS.md))
- CLI: `aw status` · `aw resume-summary [--include-recent-closed]` · `aw session-resume --code <NNN> [--reopen]`
- Continuity rule: [`../SKILL.md`](../SKILL.md) § *Operating context*
- Design reference: `docs/referencias/workflow-skills/resume.md`
