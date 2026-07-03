# w — Command map (Layer 1)

> README of the `/w:` namespace (`w` = *workflow*): everything listed here is the **only thing the user invokes** directly. Commands are **Layer 1** — single-pass or they start a loop; no iteration logic.
>
> **Canon**: the full model (3 layers + `docs/` zone, the 3 flows, hard invariants) lives in [`../SKILL.md`](../SKILL.md); the **loop engine** in [`../loops/CHASSIS.md`](../loops/CHASSIS.md). This README is only the folder index.

---

## Bootstrap

[`/w:workspace-init`](workspace-init.md) turns the current folder into a **workspace** (`.workflow/` + `docs/` + `WORKSPACE` block + `.workflow/skills.toml`). No project/hub distinction; run once before any flow.

## Index

| Command | What it does | Mode |
|---|---|---|
| [`workspace-init`](workspace-init.md) | Workspace bootstrap | single-pass, interactive |
| [`spec-new`](spec-new.md) | Generates the spec draft (`docs/specs/NNN-spec-<slug>.md`) | single-pass, no loop |
| [`spec-refine`](spec-refine.md) | Refines the spec **in place** until unambiguous | starts `spec-refine-loop` |
| [`plan-new`](plan-new.md) | Derives the executable plan (`docs/plans/PPP-plan-<slug>.md`) from the spec | starts `plan-new-loop` |
| [`plan-refine`](plan-refine.md) | Refines the plan **in place** before executing (aux, optional) | starts `plan-refine-loop` |
| [`plan-exec`](plan-exec.md) | Executes the plan (code/DB/git) and maintains it as a living doc | starts `plan-exec-loop` |
| [`quick`](quick.md) | Lightweight shortcut for scoped work; never touches `docs/` | starts `quick-loop` |
| [`status`](status.md) | Read-only workspace dashboard | single-pass (transversal) |
| [`fix-git`](fix-git.md) | Resolves an in-progress merge, git-safe | single-pass (transversal) |
| [`export-scripts`](export-scripts.md) | Promotes session SQL migrations to `docs/scripts/` | single-pass, read-only |
| [`export-manuals`](export-manuals.md) | Generates manuals in `docs/manuals/` | single-pass, read-only |
| [`export-diagrams`](export-diagrams.md) | Generates C4/mermaid diagrams in `docs/diagrams/` | single-pass, read-only |
| [`export-reports`](export-reports.md) | Generates reports in `docs/reports/` | single-pass, read-only |

> **Intentional asymmetry:** in SPEC, `spec-new` generates the draft single-pass (no loop) and the loop lives in `spec-refine`; in PLAN, all 3 commands start loops. Total: **6 flow commands / 5 loops**.
>
> **Transversal (no flow):** `status` and `fix-git` belong to no SPEC/PLAN/QUICK flow and do not count in 6/5. In the design they are their own category (`workflow-skills/`); here they are packaged under `commands/` so `/w:` can invoke them — see [`../harness/SKILL.md`](../harness/SKILL.md) § *Command packaging*.

## Schema of each command file

Every `<command>.md` in this folder uses this frontmatter + body structure — the schema (including `allowed-tools:` and the `Skill` tool) is the **Claude Code binding**; other harnesses wrap the same contract in their format (see [`../harness/SKILL.md`](../harness/SKILL.md) § *Command packaging*):

| Field | Description |
|---|---|
| `description:` | One line: what + when (drives discovery in the `/`-picker) |
| `argument-hint:` | Argument signature for the user |
| `allowed-tools:` | YAML list (typically `Bash`/`Read`/`Write`/`Edit`). Loops/exports are **read-and-followed**, not invoked with `Skill:` — so `Skill` is **not** in `allowed-tools`. |
| Body | 1-3 orienting lines, then the invocation: **read-and-follow** the sibling loop/export `SKILL.md`, or call the `aw` CLI; then `## Plan mode`, `## Resources` |
