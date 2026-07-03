# workflow-artifacts — Artifact catalog (Layer 3)

> Reference for the agent-workflow model (current, deployed). This folder contains the **artifact templates**: process files managed by **sessions** inside `.workflow/sessions/`.
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
| Examples | `CHECKPOINT`, `ANALYSIS-FILE`, `CONCLUSIONS`, `SCRIPTS.sql`, `TASKS`, `DECISION`, `NNN-SPEC-<SLUG>.md` | `specs`, `plans`, `manuals`, `scripts`, `diagrams`, `reports` |

> An artifact may be **promoted** to a `docs/` document (e.g. `SCRIPTS.sql` → `docs/scripts/`) — but **only via dedicated `export-*` skills**, **never** automatically by the loops. The spec and the plan **are not** artifacts: they are documents.

> **Routing by operating context** (canonical rules: [`../SKILL.md`](../SKILL.md) § *Contexto operativo*): inside a flow → the **active/continued** session (a prompt with no command edits the most recent session's artifacts); workspace without flow → `docs/` by convention + numbering; no workspace → vanilla. Session→`docs/` promotion is still **only** via `export-*`.

---

## Sessions & their artifacts

Sessions are created by the loops as needed — **one session per run**. The session types loops create are `refine`, `exec`, `quick`:

| Session type | Created by | Artifacts | Notes |
|---|---|---|---|
| **refine** | `spec-refine-loop` · `plan-new-loop` · `plan-refine-loop` | `SESSION` · `CHECKPOINT` · `BACKLOG` (on close, if any) · `NNN-SPEC-<SLUG>.md` (PLAN sessions with UI) | Owns the loop run (spec-refine, plan-new, plan-refine). |
| **exec** | `plan-exec-loop` | `SESSION` · `CHECKPOINT` · `BACKLOG` (on close, if any) · `DECISION` · `SCRIPTS.sql` | A single per-run exec session (**not** one per phase). No `TECHNICAL-NOTE` or own `TASKS` — detail lives in the plan-doc (living). `TASKS` is optional for internal breakdown. |
| **quick** | `quick-loop` | `SESSION` · `CHECKPOINT` · `BACKLOG` (on close, if any) · `DECISION` · `SCRIPTS.sql` | Single session, single commit. |

> **Inline research (any session):** research is **not** a session type. When any session (`refine`/`exec`/`quick`) needs to investigate, it produces research artifacts **inline**: `ANALYSIS-FILE` (optional scratchpad), `CONCLUSIONS`, and read-only `SCRIPTS.sql` (if DB). These are written into the active session — there is no separate research session.

> **Inline design (PLAN sessions):** when the plan **includes UI**, `plan-new-loop`/`plan-refine-loop` compose the **`ui-design`** capability and produce **design SPECs** — `NNN-SPEC-<SLUG>.md`, one **per screen** (`001-SPEC-MODAL-EXPORT.md`, `002-SPEC-ADMIN-DASHBOARD.md`), numbering local to the session — inside their own session. The plan-doc **references** them (UI Tasks) and `plan-exec-loop` reads them as the design reference. They are **not** the requirement-spec (invariant 3): they are process artifacts. See [`artifacts-design/`](artifacts-design/).

> **PLAN note (rich plan):** the plan-doc (`docs/plans/PPP-plan.md`) absorbs inline the `TECHNICAL-NOTE` level (Solution/Impacted/AS-IS/TO-BE/Validations…) **and** the `Phases`/`Tasks`. Therefore exec sessions do **not** carry a `TECHNICAL-NOTE` or own `TASKS` artifact: the technical detail and progress live in the plan-doc (living). `TASKS` remains as an optional artifact for sessions that need their own internal breakdown.

---

## Common artifacts (any session)

`SESSION` (descriptor: Objective / Origin / Type / **Success criteria** — the verification-first done-condition; the convergence gate flips them green) · `CHECKPOINT` (resume — **fixed headings, updated in place, never duplicated**; see its contract) · `SCRIPTS.sql` (read-only queries **executable** + DDL/DML migrations **deliverable**, not executed) · `TASKS` · `BACKLOG` (only when there's something to defer).

---

## Index (folders)

| Folder | Role | Contains |
|---|---|---|
| [`artifacts-core/`](artifacts-core/) | common to any session | `SESSION` · `TASKS` · `CHECKPOINT` · `BACKLOG` · `SCRIPTS.sql` |
| [`artifacts-research/`](artifacts-research/) | inline research (any session) | `ANALYSIS-FILE` · `CONCLUSIONS` |
| [`artifacts-design/`](artifacts-design/) | inline design (PLAN sessions with UI) | `NNN-SPEC-<SLUG>.md` (design SPEC, one per screen) |
| [`artifacts-exec/`](artifacts-exec/) | `exec` / `quick` session | `DECISION` · `TECHNICAL-NOTE` (schema reference; absorbed by the plan-doc) |

---

## Invariants (hard rules — canonical list: [`../SKILL.md`](../SKILL.md) § *The 6 hard invariants*)

1. **No auto-export**: only `export-*` promotes to `docs/`, explicitly.
2. **Each flow touches only its `docs/` folders**: SPEC→`specs` · PLAN→`plans` · QUICK→none.
3. **Spec and plan are documents**, never session artifacts. *(Design SPECs `NNN-SPEC-<SLUG>.md` are a different thing: per-screen UI artifacts of PLAN sessions — [`artifacts-design/`](artifacts-design/).)*
4. **DB scripts-only**: never execute DML/DDL; migrations (type B) stay in `SCRIPTS.sql` and ship via `export-scripts`; only read-only queries (type A) run via MCP.
