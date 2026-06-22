# w — Command map (Layer 1)

> This is the **bundle README** for the `/w:` slash-command namespace. Every command listed here is something the **user** invokes directly.
> Related layers: [`../loops/`](../loops/) (Layer 2, AI-driven) · artifacts live in `.workflow/sessions/` (Layer 3) · permanent deliverables in `docs/`.
>
> **Namespace:** all commands are under `w:` (`w` = *workflow*): `/w:spec-new`, `/w:spec-refine`, `/w:plan-new`, `/w:plan-exec`, `/w:quick`, `/w:workspace-init`, `/w:status` (transversal), `/w:fix-git` (transversal), `/w:export-*`.

---

## 3-layer model + docs/ zone

```
┌─ LAYER 1 · COMMANDS (this dir) — the only thing the user invokes ──────┐
│   workspace-init                                                        │
│   spec-new · spec-refine · plan-new · plan-exec · quick                │
│   export-scripts · export-manuals · export-diagrams · export-reports   │
│   High-level. Single-pass or starts a loop. No iteration logic here.   │
└───────────────────────────┬────────────────────────────────────────────┘
                            │ starts / delegates to
                            ▼
┌─ LAYER 2 · LOOPS (../loops/) — AI runs these end-to-end ───────────────┐
│   spec-refine-loop · plan-new-loop · plan-exec-loop · quick-loop        │
│   Gap-driven · structured-choice: ≤3 content questions + 1 `flow`     │
│   (Compactar / Cerrar always present) · compact/resume support.        │
└───────────────────────────┬────────────────────────────────────────────┘
                            │ creates / reads / writes
                            ▼
┌─ LAYER 3 · SESSIONS + ARTIFACTS (.workflow/sessions/) ─────────────────┐
│   Ephemeral, internal. No one invokes this by hand. Process-only.      │
│   (schema in ../workflow-artifacts/)                                   │
└────────────────────────────────────────────────────────────────────────┘

╔═ docs/ ZONE — PERMANENT documents, user-facing ════════════════════════╗
║  specs · plans · tools          ← written by flows directly            ║
║  scripts · manuals · diagrams · reports   ← written by export-* only  ║
╚════════════════════════════════════════════════════════════════════════╝
```

## Bootstrap

[`/w:workspace-init`](workspace-init.md) converts the current folder into an agent-workflow **workspace** (scaffolds `.workflow/` + `docs/` + `WORKSPACE` block + `.workflow/skills.toml`). Replaces the old `hub-init` + `project-init` — **no project/hub distinction**. A workspace has 1+ sources; "standalone" is just a single-source workspace. Run once before any flow.

## Flows & commands

| Flow | docs/ target | Entry command | Advance command | Loops involved |
|---|---|---|---|---|
| **SPEC** | `docs/specs/` | `spec-new` *(single-pass)* | `spec-refine` | `spec-refine-loop` |
| **PLAN** | `docs/plans/` + `docs/tools/` | `plan-new` | `plan-exec` | `plan-new-loop`, `plan-exec-loop` |
| **QUICK** | — *(no doc)* | `quick` | — | `quick-loop` |

> **Intentional asymmetry:** in SPEC, `spec-new` generates the draft in a **single pass** (no loop) and the loop is in `spec-refine`. In PLAN, **both** commands start loops. Total: **5 flow commands / 4 loops**.

> **Transversal (no flow):** [`/w:status`](status.md) is a read-only dashboard of the whole workspace — what's done / pending / discarded, with friendly Spanish dates. It leans on `aw status`, writes nothing, and belongs to no flow.
>
> **Transversal (no flow):** [`/w:fix-git`](fix-git.md) resolves an **in-progress merge conflict** for any repo — identify origin↔destination, analyze both sides' intent, resolve (structured-choice on ambiguity), propose the merge commit (git-safe). Leans on `aw merge-state`; writes no `docs/`; works without a workspace. Neither transversal is counted in **5 flow / 4 loops**.

## Pipeline

```mermaid
flowchart LR
    prompt(["user prompt"]) --> sn["/w:spec-new"]
    sn -->|generates| spec["docs/specs/NNN-spec-&lt;slug&gt;.md"]
    spec -.->|optional manual edit| spec
    spec --> sr["/w:spec-refine"]
    sr -->|starts| srl(["spec-refine-loop"])
    srl -->|refines IN PLACE| spec

    spec --> pn["/w:plan-new"]
    pn -->|starts| pnl(["plan-new-loop"])
    pnl -->|generates| plan["docs/plans/PPP-plan-&lt;slug&gt;.md"]

    plan --> pe["/w:plan-exec"]
    pe -->|starts| pel(["plan-exec-loop"])
    pel -->|read/update| plan
    pel -->|writes tools| tools["docs/tools/"]
    pel -->|artifacts| sess[".workflow/sessions/\nSCRIPTS.sql · DECISION"]
    sess -.->|export-* (separate step)| outd["docs/scripts · manuals · diagrams · reports"]

    promptq(["prompt"]) --> q["/w:quick"]
    q -->|starts| ql(["quick-loop"])
```

**Pipeline reading:** SPEC defines *what* (refined spec) → PLAN defines *how* (plan) and *executes it* → QUICK is a lightweight shortcut for scoped work that does not warrant spec or plan.

> **`docs/` boundary:** each flow only touches its own folders — **SPEC** → `docs/specs`; **PLAN** → `docs/plans` + `docs/tools`. The rest of `docs/` (`scripts`, `manuals`, `diagrams`, `reports`) is written **only** by `export-*` skills (a separate, never-automatic step). See [`../loops/`](../loops/) and workflow-exports reference.

## Schema of each command file

Each `<command>.md` in this bundle uses this frontmatter + body structure:

| Field | Description |
|---|---|
| `description:` | One line: what + when (drives discovery in `/`-picker) |
| `argument-hint:` | Argument signature for the user |
| `allowed-tools:` | YAML list; always includes `Skill` when a loop/export skill is invoked |
| Body | 1-3 orienting lines, then the invocation (Skill tool or `aw` CLI), `## Plan mode`, `## Resources` |

## 6 Hard invariants (never violate)

1. **No auto-export**: loops **never** graduate/export to `docs/`. Only `export-*` does, explicitly.
2. **Each flow touches only its `docs/` folders**: SPEC→`specs`; PLAN→`plans`+`tools`; QUICK→none; rest→`export-*`.
3. **Spec and plan are documents** (`docs/`), not artifacts.
4. **DB scripts-only**: AI **never executes DML/DDL**; migrations live in `SCRIPTS.sql` (type B) and are delivered via `export-scripts`. Only read-only queries via MCP.
5. **Git-safe**: verify branch before editing; **propose** commits by source; never `push`/`--amend`/`--no-verify`.
6. **All loops**: gap-driven convergent · one session per run (research inline) · *structured-choice* (capacidad del arnés — ver [`../harness/SKILL.md`](../harness/SKILL.md); en **Claude Code** es `AskUserQuestion`) con **≤3 preguntas de contenido + 1 control `flow`** (`Compactar`/`Cerrar`) siempre · compact/resume · artifacts as a live log (`CHECKPOINT` always; `BACKLOG` only when deferring).

## Index

| Command | File | Mode |
|---|---|---|
| `workspace-init` | [`workspace-init.md`](workspace-init.md) | single-pass, interactive (bootstrap) |
| `spec-new` | [`spec-new.md`](spec-new.md) | single-pass |
| `spec-refine` | [`spec-refine.md`](spec-refine.md) | starts `spec-refine-loop` |
| `plan-new` | [`plan-new.md`](plan-new.md) | starts `plan-new-loop` |
| `plan-exec` | [`plan-exec.md`](plan-exec.md) | starts `plan-exec-loop` |
| `quick` | [`quick.md`](quick.md) | starts `quick-loop` |
| `status` | [`status.md`](status.md) | single-pass, read-only (transversal) |
| `fix-git` | [`fix-git.md`](fix-git.md) | single-pass, read/edit working tree (transversal) |
| `export-scripts` | [`export-scripts.md`](export-scripts.md) | single-pass, read-only |
| `export-manuals` | [`export-manuals.md`](export-manuals.md) | single-pass, read-only |
| `export-diagrams` | [`export-diagrams.md`](export-diagrams.md) | single-pass, read-only |
| `export-reports` | [`export-reports.md`](export-reports.md) | single-pass, read-only |
