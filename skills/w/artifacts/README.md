# workflow-artifacts — Artifact catalog (Layer 3)

> Reference for the **new agent-workflow model**. This folder contains the **artifact templates**: process files managed by **sessions** inside `.workflow/sessions/`.
> Siblings: [`../commands/`](../commands/) (Layer 1) · [`../loops/`](../loops/) (Layer 2) · [`../roles/`](../roles/) (pluggable skills).

---

## Artifact vs `docs/` document

Central distinction of the model:

| | **Artifact** (this catalog) | **`docs/` document** |
|---|---|---|
| Nature | Process, ephemeral | Deliverable, permanent |
| Location | `.workflow/sessions/NNN-…/` | `docs/<category>/` |
| Who manages it | a **loop**, through a **session** | produced by a loop/command at "save" time |
| User-facing | No (internal) | Yes |
| Examples | `CHECKPOINT`, `ANALYSIS-FILE`, `CONCLUSIONS`, `SCRIPTS.sql`, `TASKS`, `DECISION` | `specs`, `plans`, `manuals`, `scripts`, `tools`, `diagrams`, `reports` |

> An artifact may be **promoted** to a `docs/` document (e.g. `SCRIPTS.sql` → `docs/scripts/`) — but **only via dedicated `export-*` skills**, **never** automatically by the loops. The spec and the plan **are not** artifacts: they are documents.

---

## Sessions & their artifacts

Sessions are created by the loops as needed. Each session type manages a set of artifacts:

| Session type | Created by | Artifacts | Notes |
|---|---|---|---|
| **research** | all loops, on-demand | `SESSION` · `ANALYSIS-FILE` · `CONCLUSIONS` · `SCRIPTS.sql` (if DB) | On-demand, **not resumable** (run-and-close). No own `CHECKPOINT`/`BACKLOG` — those live in the owning `refine/control` session. |
| **refine / control** | `spec-refine-loop` · `plan-new-loop` · `plan-exec-loop` | `SESSION` · `CHECKPOINT` · `BACKLOG` (on close) | Owns the loop run. Tracks open research sessions. |
| **exec** (one per phase) | `plan-exec-loop` | `SESSION` · `DECISION` · `SCRIPTS.sql` · `CHECKPOINT` | No `TECHNICAL-NOTE` or own `TASKS` — detail lives in the plan-doc (living). `TASKS` is optional for internal breakdown. |
| **quick** (one, lightweight) | `quick-loop` | `SESSION` · `DECISION` · `SCRIPTS.sql` · `CHECKPOINT` · `BACKLOG` (on close) | Single session, single commit. |

> **PLAN note (rich plan):** the plan-doc (`docs/plans/PPP-plan.md`) absorbs inline the `TECHNICAL-NOTE` level (Solution/Impacted/AS-IS/TO-BE/Validations…) **and** the `Phases`/`Tasks`. Therefore exec sessions do **not** carry a `TECHNICAL-NOTE` or own `TASKS` artifact: the technical detail and progress live in the plan-doc (living). `TASKS` remains as an optional artifact for sessions that need their own internal breakdown.

---

## Common artifacts (any session)

`SESSION` (descriptor) · `CHECKPOINT` (resume) · `SCRIPTS.sql` (read-only queries **executable** + DDL/DML migrations **deliverable**, not executed) · `TASKS` · `BACKLOG`.

---

## Index (folders)

| Folder | Role | Contains |
|---|---|---|
| [`artifacts-core/`](artifacts-core/) | common to any session | `SESSION` · `TASKS` · `CHECKPOINT` · `BACKLOG` · `SCRIPTS.sql` |
| [`artifacts-research/`](artifacts-research/) | `research` session | `ANALYSIS-FILE` · `CONCLUSIONS` |
| [`artifacts-dev/`](artifacts-dev/) | `exec` session | `DECISION` · `TECHNICAL-NOTE` |

---

## Invariants (hard rules — do not break)

1. **No auto-export**: loops **never** graduate/export to `docs/`. Only `export-*` does, explicitly.
2. **Each flow touches only its `docs/` folders**: SPEC→`specs` · PLAN→`plans`+`tools` · QUICK→none · rest→`export-*`.
3. **Spec and plan are documents** (`docs/`), not artifacts — they never live inside a session.
4. **DB write-only scripts**: the AI **never executes DML/DDL**; migrations stay in `SCRIPTS.sql` (type B) and are delivered via `export-scripts`. Only read-only queries (type A) are executed via MCP.
