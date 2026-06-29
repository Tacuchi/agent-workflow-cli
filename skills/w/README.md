# w — agent-workflow skill bundle

> The `w` bundle (`w` = *workflow*) hosts the agent-workflow harness as Claude Code skills + `/w:` slash commands. Runtime: [`@tacuchi/agent-workflow-cli`](../../README.md) (`agent-workflow` / `aw`).

This bundle implements the **stages + loops + artifacts** model. The design source of truth lives in `docs/referencias/` of the agent-workflow hub.

## The model — 3 layers + `docs/` zone

```
LAYER 1 · COMMANDS  (/w:* — the only thing the user invokes)
  SPEC   spec-new (single-pass) · spec-refine        EXPORTS  export-scripts · export-manuals
  PLAN   plan-new · plan-exec                                  export-diagrams · export-reports
  QUICK  quick                                        SETUP   workspace-init
        │ start                                              │ (single-pass, read-only)
        ▼                                                    │
LAYER 2 · LOOPS  (the AI runs them whole)                    │
  spec-refine-loop (chassis) · plan-new-loop ·                │
  plan-exec-loop · quick-loop                                 │
        │ create / manage                                     │
        ▼                                                     │
LAYER 3 · SESSIONS + ARTIFACTS  (.workflow/sessions/)  ───────┘ export-* read these
  refine · exec · quick   (research = capacidad inline, no un tipo de session)

ZONE docs/ — permanent, user-facing deliverables
  specs · plans   (flows)   ·   scripts · manuals · diagrams · reports   (export-*)   ·   tools (ambient)
```

## Folders

| Folder | Layer | Contains |
|---|---|---|
| [`commands/`](commands/) | 1 | The `/w:` slash commands the user invokes |
| [`loops/`](loops/) | 2 | The 4 loops (chassis `spec-refine-loop` + heirs) the AI runs |
| [`exports/`](exports/) | 1 | The `export-*` family — the only artifact→`docs/` promotion path |
| [`roles/`](roles/) | cross-cutting | Pluggable capability skills (built-in defaults; rebindable via `.workflow/skills.toml`) |
| [`harness/`](harness/SKILL.md) | cross-cutting | Capability→harness-mechanism binding (agnostic across Claude Code / Codex / opencode / Gemini) |
| [`artifacts/`](artifacts/) | 3 | Session artifact templates the loops manage |
| [`hooks/`](hooks/) | — | Host hook template (branch-check, sql-mutation-guard, checkpoint, …) |
| [`SKILL.md`](SKILL.md) | overview | The `workflow` orientation skill (whole-model guide) |

## Flows

| Flow | Commands | `docs/` owned | Loops |
|---|---|---|---|
| **SPEC** | `spec-new` *(single-pass)* · `spec-refine` | `docs/specs` | `spec-refine-loop` |
| **PLAN** | `plan-new` · `plan-exec` | `docs/plans` | `plan-new-loop` · `plan-exec-loop` |
| **QUICK** | `quick` | — | `quick-loop` |

SPEC defines the **what** → PLAN the **how** and executes it → QUICK is the lightweight shortcut. Promotion to `docs/` (scripts/manuals/diagrams/reports) is **always** a separate step via `export-*`.

> **Transversal commands** (no flow, not counted in 5/4): `/w:status` (read-only workspace dashboard) · `/w:fix-git` (resolve an in-progress merge conflict, git-safe — works on any repo). Setup: `/w:workspace-init`.

## Bootstrap

Run [`/w:workspace-init`](commands/workspace-init.md) once to turn a folder into a workspace (`.workflow/` + `docs/` taxonomy + `WORKSPACE` block + `.workflow/skills.toml`). No project/hub distinction — a workspace has 1+ sources.

## Invariants (hard rules)

1. **No auto-export** — loops never promote artifacts to `docs/`; only `export-*` does, explicitly.
2. **Folder ownership** — SPEC→`specs`; PLAN→`plans`; QUICK→none; the rest→`export-*`. (`docs/tools` is ambient — written by the `creating-tools` skill, not a flow.)
3. **spec & plan are documents** (`docs/`), not artifacts.
4. **DB scripts-only** — the AI never executes DML/DDL; migrations land in `SCRIPTS.sql` and ship via `export-scripts`; reads are read-only via MCP.
5. **Git-safe** — verify the expected branch before editing; propose commits per source; never `push`/`--amend`/`--no-verify`.
6. **All loops** — gap-driven convergent; one session per run (research inline); **structured-choice** (capability — see [`harness/`](harness/SKILL.md); on Claude Code: `AskUserQuestion`) with ≤3 content questions + 1 always-present `flow` control (`Compactar`/`Cerrar`); a **convergence gate** before saving; compact/resume; artifacts as a live log (`CHECKPOINT` always; `BACKLOG` only when deferring).

## Pluggable capabilities

Loops compose **capability roles** (e.g. `ui-design`), not concrete skills. The binding is resolved via `.workflow/skills.toml` (cascade: built-in default → `~/.workflow/skills.toml` global → `.workflow/skills.toml` workspace; `off` disables; may point to a third-party skill). Inspect resolved bindings with `aw skills`. See [`roles/`](roles/).
