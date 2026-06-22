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

Sessions are created by the loops as needed — **one session per run**. The session types loops create are `refine`, `exec`, `quick`:

| Session type | Created by | Artifacts | Notes |
|---|---|---|---|
| **refine** | `spec-refine-loop` · `plan-new-loop` | `SESSION` · `CHECKPOINT` · `BACKLOG` (on close, if any) | Owns the loop run (spec-refine, plan-new). |
| **exec** | `plan-exec-loop` | `SESSION` · `CHECKPOINT` · `BACKLOG` (on close, if any) · `DECISION` · `SCRIPTS.sql` | A single per-run exec session (**not** one per phase). No `TECHNICAL-NOTE` or own `TASKS` — detail lives in the plan-doc (living). `TASKS` is optional for internal breakdown. |
| **quick** | `quick-loop` | `SESSION` · `CHECKPOINT` · `BACKLOG` (on close, if any) · `DECISION` · `SCRIPTS.sql` | Single session, single commit. |

> **Inline research (any session):** research is **not** a session type. When any session (`refine`/`exec`/`quick`) needs to investigate, it produces research artifacts **inline**: `ANALYSIS-FILE` (optional scratchpad), `CONCLUSIONS`, and read-only `SCRIPTS.sql` (if DB). These are written into the active session — there is no separate research session.

> **PLAN note (rich plan):** the plan-doc (`docs/plans/PPP-plan.md`) absorbs inline the `TECHNICAL-NOTE` level (Solution/Impacted/AS-IS/TO-BE/Validations…) **and** the `Phases`/`Tasks`. Therefore exec sessions do **not** carry a `TECHNICAL-NOTE` or own `TASKS` artifact: the technical detail and progress live in the plan-doc (living). `TASKS` remains as an optional artifact for sessions that need their own internal breakdown.

---

## Common artifacts (any session)

`SESSION` (descriptor: Objective / Origin / Type; + research-only Success criteria) · `CHECKPOINT` (resume) · `SCRIPTS.sql` (read-only queries **executable** + DDL/DML migrations **deliverable**, not executed) · `TASKS` · `BACKLOG` (only when there's something to defer).

---

## Index (folders)

| Folder | Role | Contains |
|---|---|---|
| [`artifacts-core/`](artifacts-core/) | common to any session | `SESSION` · `TASKS` · `CHECKPOINT` · `BACKLOG` · `SCRIPTS.sql` |
| [`artifacts-research/`](artifacts-research/) | inline research (any session) | `ANALYSIS-FILE` · `CONCLUSIONS` |
| [`artifacts-dev/`](artifacts-dev/) | `exec` session | `DECISION` · `TECHNICAL-NOTE` |

---

## Invariants (hard rules — do not break)

1. **No auto-export**: loops **never** graduate/export to `docs/`. Only `export-*` does, explicitly.
2. **Each flow touches only its `docs/` folders**: SPEC→`specs` · PLAN→`plans`+`tools` · QUICK→none · rest→`export-*`.
3. **Spec and plan are documents** (`docs/`), not artifacts — they never live inside a session.
4. **DB write-only scripts**: the AI **never executes DML/DDL**; migrations stay in `SCRIPTS.sql` (type B) and are delivered via `export-scripts`. Only read-only queries (type A) are executed via MCP.
