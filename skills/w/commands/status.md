---
description: Use when the user asks "what's the state", "what got done", or "where are we". Read-only workspace dashboard — what got done / what is missing / what was discarded, with dates humanized in the user's language, optionally enriched with host context when the host exposes cheap memory. Backed by `aw status`. Transversal command (not a flow); writes nothing.
argument-hint: (no arguments)
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# status — workspace state (read-only)

Shows, simple and direct, the workspace state grouped as **Done / Missing / Discarded**. Single-pass, read-only: no loop, no sessions, writes nothing in `docs/` or `.workflow/`. **Transversal** command (belongs to no flow). When the host exposes cheap memory it *opportunistically* adds a host-context section — additive, never blocking, never asked.

## Run

1. Run `aw status` (returns JSON; backed by `status-service`).
2. Render a readable summary from the JSON — do **not** show the raw JSON. Use the `relative` field verbatim (it comes pre-humanized in the user's language — Spanish). Head it with `workspace.name`.
3. Group into three blocks (the dashboard is user-facing → render it in the user's language; the canonical Spanish labels below):
   - `▸ HECHO` — specs whose `status` is `ready-for-plan` (the JSON keeps `refined: true` as its boolean mirror); plans whose `plan_state` is `done`, with their progress (`tasks_done`/`tasks_total`, `progress_pct`) **and** their validated phases (`phases_validated`/`phases_total`); `closed` sessions.
   - `▸ FALTA` — `active` sessions; plans whose `plan_state` is `open` (pending tasks `tasks_total − tasks_done`, phases still to validate `phases_total − phases_validated`, or a final validation that never ran); plans whose `plan_state` is `inconsistent`, **naming the contradiction**; specs whose `status` is `draft` or `refining`; specs with `open_questions > 0`.
   - `▸ DESCARTÓ` — every item in `discarded[]` (`kind: deferred` = deferred in BACKLOG; `kind: excluded` = excluded in CHECKPOINT), with its `text`.
4. Every line ends with its relative date after ` · ` (e.g. `· ayer en la mañana`). An empty section shows `— (nada)`. Never invent data not present in the JSON.
5. **Say what blocks a phase.** Every entry of `blocked_phases[]` is rendered with its `number`, its `name` and its `blocker` — `• F3 — Persistencia real — bloqueada: falta aplicar la migración`. A `blocker: null` is a legacy block that stated no reason: render it as `bloqueada` with `motivo no declarado`, never a guess.
6. If `workspace.initialized` is `false` and everything is empty → say the folder is not an agent-workflow workspace (no `.workflow/`) and suggest `/w:workspace-init`.
7. **Host context (opportunistic, read-only).** After the dashboard, if the host exposes *cheap* host-memory (see [`../harness/HARNESS.md`](../harness/HARNESS.md) § *host-memory* — e.g. the auto-memory `MEMORY.md` on Claude Code), append a `▸ CONTEXTO DEL HOST` section with a few signals of recent focus relevant to this workspace. If there is no cheap host memory, **omit the section silently**. Never run an expensive transcript scan here and **never ask** — this is a read-only dashboard; the enrichment is additive and must not slow the default output.

> **Three axes, none of them a substitute for another.** A task completed answers *what work was done* (`tasks_done`/`tasks_total`); a phase validated answers *what functional state was demonstrated* (`phases_validated`/`phases_total`); a plan closed answers *whether the whole solution was validated* (`plan_state`). `progress_pct` stays checkbox-derived — it never reads the phase marks. A plan at 100% with `phases_validated: 0` is **work implemented, not validated**: report it in both blocks and say so. `phases_total: 0` means a legacy plan with no phase marks — show only its checkbox progress, never a `0/0`.

> **`plan_state` is derived, never declared alone.** `open` (or nothing declared) keeps the plan in `▸ FALTA`, **including** a plan whose every box is ticked and every phase validated: that one carries `final_validation_pending: true` and is reported as `validación final pendiente` — the work is complete, the final validation never ran. `done` reaches `▸ HECHO` only when the counters back the declaration. `inconsistent` means the document declares `done` while tasks or phases stay open, or declares a value nobody can read: it belongs in `▸ FALTA` **with the contradiction named** (`declara done con 2 tareas abiertas`), because only a human repairs it.

> **A blocked phase says what it waits on.** A `bloqueada` phase is the implemented-not-validated gap made explicit — every box ticked, its verification still pending — and belongs in both blocks: the work under `▸ HECHO`, the phase under `▸ FALTA` with its `> Bloqueo:` reason, so the reader knows the next action instead of only the state.

> **The frontmatter governs spec maturity.** The spec's `status` (`draft` | `refining` | `ready-for-plan`) is the primary source, and readiness is never inferred from a section the spec happens to carry. A `status` that is absent, empty or unknown reads `draft` and the spec is reported as pending; only a spec with **no frontmatter at all** falls back to the two legacy marks (`## Refinement decisions`, `## Q&A traceability`).

Suggested format (plain text; user-facing labels in Spanish):

```
Workspace: <name>

▸ HECHO
  • plan <slug> — cerrado · <done>/<total> tareas (<pct>%) · <validadas>/<fases> fases validadas · <relative>
  • spec <slug> — lista para plan · <relative>
  • <folder> (<type>) — cerrada · <relative>

▸ FALTA
  • <folder> (<type>) — activa · <relative>
  • plan <slug> — <pendientes> tareas pendientes · <sin validar> fases sin validar
  • plan <slug> — validación final pendiente (todo validado, sin cierre)
  • plan <slug> — inconsistente: declara done con <n> tareas abiertas
  • F3 — Persistencia real — bloqueada: falta aplicar la migración
  • spec <slug> — borrador · <relative>
  • spec <slug> — <n> preguntas abiertas

▸ DESCARTÓ
  • <text> (<kind>) · <relative>

▸ CONTEXTO DEL HOST   (solo si hay memoria barata; se omite si no)
  • <foco reciente / hilo relevante>
```

## Plan mode

Same as execution: run `aw status` (read-only) and show the summary. There are no changes to apply.

## Resources

- CLI: `aw status` (service `status-service`; dates via `humanize-es`)
- Capability: `host-memory` ([`../harness/HARNESS.md`](../harness/HARNESS.md)) — cheap tier only, opportunistic, silent-omit, never asks
- Design reference: `docs/referencias/workflow-skills/status.md`

> **Note:** the host-context section is an opportunistic addendum — originally `/status` was a pure `aw status` dashboard. It composes the `host-memory` capability and is purely additive (the fast dashboard is unchanged).
