---
name: w
description: >-
  Orientation skill for the whole agent-workflow harness — built-in default for the
  `overview` role. Load this to understand the model end-to-end: the 3-layer
  architecture (commands → loops → sessions/artifacts) plus the docs/ zone, the 3
  flows (SPEC / PLAN / QUICK), the `/w:` commands, the 5 loops and their chassis, the
  `export-*` family, the composable capability skills + `.workflow/skills.toml`
  binding cascade, and the 6 hard invariants. Use whenever an agent (or human) needs
  to know how the pieces fit, where a deliverable should land, or which command/loop/
  skill to reach for.
---

# w — agent-workflow overview

## Role

`overview` — built-in default. The orientation skill for the whole bundle. Rebindable in `.workflow/skills.toml`, but rarely is.

## Purpose

Explain the **complete model** of agent-workflow so an agent knows: what the user invokes, what the AI runs, where every deliverable lands, and which rules never break. This is the map; the fine detail lives in each loop/command/export/role.

## Composed by

Anyone needing orientation — a loop at start, a new agent in the workspace, or the user asking "how does this work?".

## Knowledge

### Workspace (no modes)

A single concept: **workspace**. There is no project/hub split. The folder where the agent starts becomes a workspace with `/w:workspace-init` (minimal scaffold: `.workflow/sessions/` + `.workflow/skills.toml` + the `WORKSPACE` block in CLAUDE.md + the CLI-owned `.gitignore`; each `docs/<cat>` folder is born on demand at `aw next-number`). It has 1+ sources (repos); "standalone" = a single source.

### The 3-layer architecture + `docs/` zone

```
USER invokes
  LAYER 1 · COMMANDS (the only thing the user invokes)
    FLOWS:   spec-new · spec-refine · plan-new · plan-refine · plan-exec · quick
    EXPORTS: export-scripts · export-manuals · export-diagrams · export-reports
        │ starts / delegates
        ▼
  LAYER 2 · LOOPS (the AI runs them, gap-driven; engine: loops/CHASSIS.md)
    spec-refine-loop · plan-new-loop · plan-refine-loop · plan-exec-loop · quick-loop
        │ creates / reads / writes
        ▼
  LAYER 3 · SESSIONS + ARTIFACTS (.workflow/sessions/ — ephemeral, internal)
        │ the export-* read the artifacts
        ▼
  docs/ ZONE — permanent, user-facing documents
    specs · plans (flows) · scripts · manuals · diagrams · reports (export-*) · tools (ambient)
```

- **Layer 1** — high level. Single-pass or starts a loop. No iteration logic.
- **Layer 2** — the AI iterates end to end until convergence. No direct human invocation.
- **Layer 3** — ephemeral, internal, process-only. Nobody invokes it by hand.

### The 3 flows

| Flow | Commands | Own docs/ | Loops |
|---|---|---|---|
| **SPEC** (the *what*) | `spec-new` *(single-pass)* · `spec-refine` | `docs/specs` | `spec-refine-loop` |
| **PLAN** (the *how* + execute) | `plan-new` · `plan-refine` *(aux, optional)* · `plan-exec` | `docs/plans` | `plan-new-loop` · `plan-refine-loop` · `plan-exec-loop` |
| **QUICK** (lightweight shortcut) | `quick` | — | `quick-loop` |

Typical chain: prompt → `spec-new` generates `docs/specs/NNN-spec-<slug>.md` → `spec-refine` runs the loop and refines **that same spec in place** → `plan-new` → `docs/plans/PPP-plan-<slug>.md` → *(optional)* `plan-refine` adjusts **that same plan in place** if changes arise before executing → `plan-exec` executes and updates the plan (living doc) + artifacts in sessions. Promoting anything else to `docs/` is **always** a separate step via `export-*`.

QUICK can **escalate live to SPEC** when the objective exceeds a quick (entry size gate) or the task grows mid-loop: with consent via structured-choice, the work line moves to the SPEC flow (draft via the `spec-new` procedure + `spec-refine-loop` directly); escalation to PLAN stays **deferred** (seed + pointer). See `loops/quick-loop/LOOP.md` § *QUICK delta*.

### Operating context — where everything lands

Before any loop, the AI resolves its **operating context** on **every prompt** with two detections: **workspace?** (`.<ns>/sessions/` exists) + **session to continue?** (an active one, or a recent one this prompt continues). That decides the behavior and **where artifacts land** (SQL, scripts, decisions, …):

| Workspace? | Trigger | → Behavior + routing |
|---|---|---|
| **Yes** | **flow command** (`quick`·`spec-*`·`plan-*`) | **new work line** → creates a **new** session (except re-running the same flow over the same input: `create_or_resume` reopens the existing one), starts the loop → artifacts go to **that** session (`SCRIPTS.sql`, …) |
| **Yes** | **prompt with no command** (related) | **continues/reopens the most recent session** → scripts edit **its** `SCRIPTS.sql` (no new session) |
| **Yes** | **prompt with no command** (unrelated / no session) | **no flow**: direct work → writes into `docs/` by convention + numbering (`aw next-number`) |
| **No** | anything | **vanilla** — no workspace, no flow; the AI is free (native) |

**Continuity rule** (single source — the chassis and the loops reference here):

1. **Flow command** = **new work line** → new session.
2. **Exception — re-run:** the same command over the **same input** (e.g. `/w:spec-refine` over the same spec) does **not** open another line: `create_or_resume` locates that flow's session (descriptor + `## Origin`) and **resumes or reopens** it (removes `.closed`), never duplicating it.
3. **Consented exception — escalation:** an **accepted escalation** inside a loop (e.g. quick → SPEC) opens a **new work line without a command**; the signal is the user's **explicit consent** in the structured-choice, equivalent to having invoked the destination flow's command.
4. **Prompt with no command** = "same line" → continue/reopen the **most recent** session (the *last started*).
5. Only if the prompt is clearly **unrelated**: offer choosing (`continuar NNN` | `trabajo nuevo`) or fall to "no flow".
6. **Convergence closes** the session; a later related prompt **reopens** it (resume removes `.closed`).

It is the **inter-turn** face of the *persistent objective* (same `CHECKPOINT`+resume, applied to the next prompt) — agnostic doctrine, not a host hook. It applies to **every artifact** (`SCRIPTS.sql` is the worked example; QUICK case: `loops/quick-loop/LOOP.md`).

### The commands (`/w:` namespace)

- `/w:workspace-init` — initializes the workspace.
- `/w:spec-new` — generates an initial spec (single-pass, no loop).
- `/w:spec-refine` — starts `spec-refine-loop` to refine the spec.
- `/w:plan-new` — starts `plan-new-loop` to derive an executable plan from the refined spec.
- `/w:plan-refine` — starts `plan-refine-loop` to refine the plan in place (auxiliary, **not mandatory**) before executing.
- `/w:plan-exec` — starts `plan-exec-loop` to execute and maintain the plan.
- `/w:quick` — starts `quick-loop` (shortcut, no `docs/`; escalates live to SPEC when the objective exceeds a quick).
- `/w:export-scripts` · `/w:export-manuals` · `/w:export-diagrams` · `/w:export-reports` — promote artifacts to `docs/`.

### Transversal skills (no flow) — `/w:status` · `/w:fix-git`

**Flow-independent invocable** skills: triggered with `/w:` like any command, but they do **not** belong to SPEC/PLAN/QUICK, do **not** manage `docs/`, and do **not** count in **6 flow commands / 5 loops**. *(In the bundle they are packaged under `commands/` so `/w:` can invoke them; in the design they are the `workflow-skills/` category.)*

- `/w:status` — read-only workspace dashboard (Done/Missing/Discarded, dates humanized in the user's language). Writes nothing; backed by `aw status`.
- `/w:fix-git` — resolves an in-progress merge's conflicts in any repo (identifies origin↔destination, analyzes intent, *structured-choice* on ambiguity). No session, never touches `docs/`; git-safe; backed by `aw merge-state`.

### The loops (Layer 2)

A loop is a skill that teaches the AI **how to iterate** to a deliverable: detect gaps, resolve them (human via structured-choice, inline research or a composed capability), integrate and repeat until convergence. The 5 loops run the same **common engine** — persistent objective + verification-first, gap-driven convergent, single session per run, structured-choice + `flow` control (`Compactar`/`Cerrar`), compact/resume, artifacts as a live log, convergence gate — whose canon lives in [`loops/CHASSIS.md`](loops/CHASSIS.md); each loop is an **heir** adding only its deltas.

The **code-editing** loops (`plan-exec-loop`, `quick-loop`) additionally apply the *code-editing loop policies*: safe git, DB scripts-only and the pre-commit **closing review gate** (nothing reaches a proposed commit unreviewed) — see [`loops/CODE-POLICIES.md`](loops/CODE-POLICIES.md) (the chassis' sibling doc; document loops do not load it).

`spec-new` has no loop (single-pass): **6 commands / 5 loops**.

### The `export-*` family (the only artifact → `docs/` path)

| Export | Reads | Produces |
|---|---|---|
| `export-scripts` | `SCRIPTS.sql` (migrations) from N sessions | `docs/scripts/` (numbered forwards + `00-ROLLBACK.sql`) |
| `export-manuals` | sessions + decisions + plan + code | `docs/manuals/` |
| `export-diagrams` | source code + plan (AS-IS/TO-BE) | `docs/diagrams/` (C4 / mermaid) |
| `export-reports` | session corpus + plan + `docs/` | `docs/reports/` (executive/functional report) |

Common: Layer 1, explicit (user-invoked, never by a loop) · single-pass, read-only over sessions · cross-session (consolidate N sessions + `docs/`) · no loop, no internal sessions (options via args).

### Capability skills + `.workflow/skills.toml`

A loop does **not** compose a concrete skill; it composes a **capability by its role** (e.g. `ui-design`). Which skill fulfills the role is decided by config, never by the loop. Swapping implementations = one config line.

```toml
[skills]
ui-design        = "ui-spec"          # built-in default
sql              = "sql"
git              = "git"
research         = "research"
# diagrams       = "off"              # ← capability disabled
# ui-design      = "acme/figma-spec"  # ← third-party skill (via skills.sh)
```

**Resolution cascade**: built-in default → `~/.workflow/skills.toml` (global, machine) → `.workflow/skills.toml` (workspace). Workspace overrides global; global overrides default. Unbound role → built-in default. `off` → disabled (the loop continues without it; if it was needed, it says so or asks).

Role catalog and defaults:

| Role | Default | Tier | Composed by |
|---|---|---|---|
| `ui-design` | `ui-spec` | must | `spec-refine-loop` (UI) · `plan-new-loop` / `plan-refine-loop` (design SPECs) |
| `sql` | `sql` | must | research · `plan-exec-loop` · `quick-loop` · `export-scripts` |
| `git` | `git` | must | `plan-exec-loop` · `quick-loop` |
| `research` | `research` | should | every loop (inline capability) |
| `diagrams` | `diagrams` | should | `export-diagrams` |
| `overview` | `w` | should | anyone (orientation) |

> **Ambient conventions (not roles):** code/testing/writing standards and `creating-tools` are standalone skills the host auto-discovers by `description` — the workflow neither binds nor depends on them. Full doctrine: [roles/README.md](roles/README.md).

The **loop chassis** is NOT bound: it is the common engine of the 5 loops ([`loops/CHASSIS.md`](loops/CHASSIS.md), a referenced doc), not a pluggable capability.

### Harness (harness-agnostic)

The doctrine names abstract **capabilities**, never a concrete harness tool. A single doc —`harness/HARNESS.md`— binds each capability to each harness's mechanism (Claude Code, Codex, Gemini/Antigravity, OpenCode, Crush, Warp, generic). Two principles: **capability-not-tool** (loops/commands reference the capability by name) and **progressive-enhancement** (use the harness's richest mechanism; degrade to a universal fallback when it does not exist).

Key capabilities:

- **structured-choice** — ask the human ≤3 content questions + 1 `flow` control. Claude Code: `AskUserQuestion`. Fallback: numbered markdown.
- **compaction** — shrink the context without losing the thread. Claude Code: `/compact`. Fallback: `CHECKPOINT` + resume.
- **command-invocation** · **procedure-loading** · **subagent-dispatch** (opt.) · **persistent-context** · **external-data** (MCP) · **dry-run/preview**.

The only `must` capabilities for a loop's cycle are **structured-choice** and **compaction**, and both degrade to text → any harness with chat + files runs the full model. Detail, binding matrix and distribution (canonical `AGENTS.md` + `CLAUDE.md` symlink): see `harness/HARNESS.md`.

### Language policy (per surface)

One language per plane — never mix them:

| Surface | Language |
|---|---|
| Doctrine (this bundle: chassis, loops, commands, roles, exports, harness) | **English** |
| **Section headings** of artifacts and docs (`## Requirement`, `## Completed`, …) | **English** (parse contract) |
| Everything **user-facing**: structured-choice questions, reports, dashboards, the **content** the AI writes into artifacts and `docs/` deliverables, commit messages | **the user's language** (this product: Spanish) |
| Literal option labels (`Compactar`, `Cerrar`, `Guardar plan`, …) | canonical product strings — use them **verbatim** |
| Domain terms (class/route/table names, e.g. the QTC fleet) | the domain's ubiquitous language (Spanish) — never translated |

### The 6 hard invariants

1. **No auto-export** — loops never graduate/export to `docs/`. Only `export-*` does, explicitly.
2. **Each flow touches only its `docs/` folders** — SPEC→`specs` · PLAN→`plans` · QUICK→none · rest→`export-*`. (`docs/tools` belongs to no flow: the ambient skill `creating-tools` writes it.)
3. **The spec and the plan are documents** (`docs/`), not session artifacts. *(Not to be confused with the **design SPECs** `NNN-SPEC-<SLUG>.md`: **per-screen** UI design artifacts that PLAN sessions produce via the `ui-design` capability when the plan includes UI — see `artifacts/artifacts-design/` — they are not the requirement-spec.)*
4. **DB scripts-only** — the AI never executes DML/DDL; migrations stay in `SCRIPTS.sql` and the user applies them. Only read-only reads via MCP.
5. **Safe git** — expected branch verified before editing; proposed commits per source; never `push`/`--amend`/`--no-verify`.
6. **Loop chassis** — the 5 loops run the same **common engine**; each loop is an heir adding only its deltas, nothing of the engine is re-declared. Detail: `loops/CHASSIS.md`.

> **Scope of #1/#2:** they govern the **session → `docs/`** plane (only `export-*` crosses it). *Direct no-flow authoring* (see § *Operating context*) is **another plane**: with no active session, `docs/` is the only managed surface → the AI writes there by convention + numbering. It is not auto-export (there is no session to graduate from).

## Output

None. Pure orientation: it writes no documents or artifacts.

## Source

Authored from the design model (`docs/referencias/`): architecture README (3 layers + 6 invariants), `workflow-commands/`, `workflow-loops/`, `workflow-artifacts/`, `workflow-exports/`, `workflow-roles/`, `workflow-skills/`, `workflow-harness/`. Current, deployed model. (Compat: replaces the legacy `session` bundle orientation + dev/design/analyze flows.)
