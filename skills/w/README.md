# w — agent-workflow skill bundle

> El bundle `w` (`w` = *workflow*) empaqueta el arnés agent-workflow como skills de Claude Code + slash commands `/w:`. Runtime: [`@tacuchi/agent-workflow-cli`](../../README.md) (`agent-workflow` / `aw`).

Implementa el modelo **stages + loops + artifacts**. La fuente de diseño vive en `docs/referencias/` del hub de agent-workflow. Este README es el índice del bundle; la normativa vive en sus docs canónicos:

- **Modelo completo** — 3 capas + zona `docs/`, los 3 flujos (SPEC/PLAN/QUICK), comandos, capacidades componibles y los 6 invariantes duros: [`SKILL.md`](SKILL.md) (la skill de orientación `workflow`).
- **Motor de los loops** — objetivo persistente + verification-first, gap-driven, sessions, structured-choice, compact/resume, políticas git/BD/gate de revisión: [`loops/CHASSIS.md`](loops/CHASSIS.md) (los 5 loops son heirs).
- **Binding capacidad→arnés** (Claude Code / Codex / Gemini-Antigravity / OpenCode / Crush / Warp): [`harness/SKILL.md`](harness/SKILL.md).

## Folders

| Folder | Layer | Contains |
|---|---|---|
| [`commands/`](commands/) | 1 | Los slash commands `/w:` que invoca el usuario |
| [`loops/`](loops/) | 2 | [`CHASSIS.md`](loops/CHASSIS.md) (el motor) + los 5 loop heirs que corre la IA |
| [`exports/`](exports/) | 1 | La familia `export-*` — única vía artefacto→`docs/` |
| [`roles/`](roles/) | cross-cutting | Capacidades enchufables (defaults built-in; rebindeables vía `.workflow/skills.toml`) |
| [`harness/`](harness/SKILL.md) | cross-cutting | Binding capacidad→mecanismo por arnés |
| [`artifacts/`](artifacts/) | 3 | Plantillas de artefactos de session que manejan los loops |
| [`hooks/`](hooks/) | — | Plantilla de hooks del host (branch-check, sql-mutation-guard, checkpoint, …) |
| [`SKILL.md`](SKILL.md) | overview | La skill de orientación `workflow` (guía del modelo completo) |

## Bootstrap

Correr [`/w:workspace-init`](commands/workspace-init.md) una vez para convertir una carpeta en workspace (`.workflow/` + taxonomía `docs/` + bloque `WORKSPACE` + `.workflow/skills.toml`). Sin distinción project/hub — un workspace tiene 1+ fuentes.
