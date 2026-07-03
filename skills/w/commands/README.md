# w — Command map (Layer 1)

> README del namespace `/w:` (`w` = *workflow*): todo lo listado acá es lo **único que el usuario invoca** directamente. Los comandos son la **Capa 1** — single-pass o arrancan un loop; sin lógica de iteración.
>
> **Canon**: el modelo completo (3 capas + zona `docs/`, los 3 flujos, invariantes duros) vive en [`../SKILL.md`](../SKILL.md); el **motor de los loops** en [`../loops/CHASSIS.md`](../loops/CHASSIS.md). Este README es solo el índice de la carpeta.

---

## Bootstrap

[`/w:workspace-init`](workspace-init.md) convierte la carpeta actual en un **workspace** (`.workflow/` + `docs/` + bloque `WORKSPACE` + `.workflow/skills.toml`). Sin distinción project/hub; correr una vez antes de cualquier flujo.

## Index

| Command | Qué hace | Mode |
|---|---|---|
| [`workspace-init`](workspace-init.md) | Bootstrap del workspace | single-pass, interactivo |
| [`spec-new`](spec-new.md) | Genera el borrador de spec (`docs/specs/NNN-spec-<slug>.md`) | single-pass, sin loop |
| [`spec-refine`](spec-refine.md) | Refina el spec **in place** hasta desambiguarlo | arranca `spec-refine-loop` |
| [`plan-new`](plan-new.md) | Deriva el plan ejecutable (`docs/plans/PPP-plan-<slug>.md`) del spec | arranca `plan-new-loop` |
| [`plan-refine`](plan-refine.md) | Refina el plan **in place** antes de ejecutar (aux, opcional) | arranca `plan-refine-loop` |
| [`plan-exec`](plan-exec.md) | Ejecuta el plan (código/BD/git) y lo mantiene como living doc | arranca `plan-exec-loop` |
| [`quick`](quick.md) | Atajo liviano para trabajo acotado; no toca `docs/` | arranca `quick-loop` |
| [`status`](status.md) | Dashboard read-only del workspace | single-pass (transversal) |
| [`fix-git`](fix-git.md) | Resuelve un merge en curso, git-safe | single-pass (transversal) |
| [`export-scripts`](export-scripts.md) | Promueve migraciones SQL de sesiones a `docs/scripts/` | single-pass, read-only |
| [`export-manuals`](export-manuals.md) | Genera manuales en `docs/manuals/` | single-pass, read-only |
| [`export-diagrams`](export-diagrams.md) | Genera diagramas C4/mermaid en `docs/diagrams/` | single-pass, read-only |
| [`export-reports`](export-reports.md) | Genera informes en `docs/reports/` | single-pass, read-only |

> **Asimetría intencional:** en SPEC, `spec-new` genera el borrador en single-pass (sin loop) y el loop está en `spec-refine`; en PLAN, los 3 comandos arrancan loops. Total: **6 comandos de flow / 5 loops**.
>
> **Transversales (no flow):** `status` y `fix-git` no pertenecen a SPEC/PLAN/QUICK ni cuentan en 6/5. En el diseño son su propia categoría (`workflow-skills/`); acá se empaquetan bajo `commands/` para que `/w:` las invoque — ver [`../harness/SKILL.md`](../harness/SKILL.md) § *Command packaging*.

## Schema of each command file

Cada `<command>.md` de esta carpeta usa este frontmatter + estructura de cuerpo:

| Field | Description |
|---|---|
| `description:` | One line: what + when (drives discovery in `/`-picker) |
| `argument-hint:` | Argument signature for the user |
| `allowed-tools:` | YAML list (typically `Bash`/`Read`/`Write`/`Edit`). Loops/exports are **read-and-followed**, not invoked with `Skill:` — so `Skill` is **not** in `allowed-tools`. |
| Body | 1-3 orienting lines, then the invocation: **read-and-follow** the sibling loop/export `SKILL.md`, or call the `aw` CLI; then `## Plan mode`, `## Resources` |
