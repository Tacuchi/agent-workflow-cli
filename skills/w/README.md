# w — Workline skill bundle

> The `w` bundle (`w` = *workline*) packages **Workline** — the stages + loops + artifacts system for agent work — as Claude Code skills + `/w:` slash commands. Runtime: [`@tacuchi/agent-workflow-cli`](../../README.md) (`agent-workflow` / `aw`).

It implements the **stages + loops + artifacts** model. The design source lives under `docs/referencias/` in the agent-workflow hub. This README is the bundle index; the normative text lives in its canonical docs:

- **Full model** — 3 layers + `docs/` zone, the 3 flows (SPEC/PLAN/QUICK), commands, composable capabilities and the 6 hard invariants: [`SKILL.md`](SKILL.md) (the `w` orientation skill).
- **Loop engine** — persistent objective + verification-first, gap-driven, sessions, structured-choice, compact/resume, git/DB/review-gate policies: [`loops/CHASSIS.md`](loops/CHASSIS.md) (the 5 loops are heirs) + [`loops/CODE-POLICIES.md`](loops/CODE-POLICIES.md).
- **Capability→harness binding** (Claude Code / Codex / Gemini-Antigravity / OpenCode / Crush / Warp): [`harness/HARNESS.md`](harness/HARNESS.md).

## Folders

| Folder | Layer | Contains |
|---|---|---|
| [`commands/`](commands/) | 1 | The `/w:` slash commands the user invokes |
| [`loops/`](loops/) | 2 | [`CHASSIS.md`](loops/CHASSIS.md) (the engine) + the 5 loop heirs the AI runs |
| [`exports/`](exports/) | 1 | The `export-*` family — the only artifact→`docs/` path |
| [`roles/`](roles/) | cross-cutting | Pluggable capabilities (built-in defaults; rebindable via `.workflow/skills.toml`) |
| [`harness/`](harness/HARNESS.md) | cross-cutting | Capability→mechanism binding per harness |
| [`artifacts/`](artifacts/) | 3 | Session artifact templates the loops manage |
| [`hooks/`](hooks/) | — | Host hook template (branch-check, sql-mutation-guard, checkpoint, …) |
| [`SKILL.md`](SKILL.md) | overview | The `w` orientation skill (guide to the full model) |

## Workspace

Every invoked directory is a usable implicit workspace. The closest `.<namespace>/sessions/` ancestor supplies its root; with none, the invoked directory itself is the root. [`/w:workspace-init`](commands/workspace-init.md) is optional: it materializes the small runtime early, or configures explicit sources and overrides.
