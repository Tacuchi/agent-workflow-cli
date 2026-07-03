# CODE-POLICIES — políticas de loops que editan código

Aplican a **`plan-exec-loop`** (por fase del plan) y **`quick-loop`** (la única tarea; gate en versión **proporcional**): cada uno lo manda leer desde su `## Inherits`, **junto con el chasis** ([`CHASSIS.md`](CHASSIS.md)). Los loops de documento (spec-refine, plan-new, plan-refine) no editan código y **no cargan este doc** — por eso vive aparte del chasis. Estas políticas materializan los invariantes **BD solo-scripts** y **git seguro** — que además quedan resumidos **inline** (1-2 líneas) en el `SKILL.md` de cada loop que edita código, porque los hosts advisory no siguen Reads; el texto normativo completo vive acá.

## Git seguro — rama verificada + commits propuestos

- **Antes de editar** archivos de una fuente: verifica rama actual = rama esperada de esa fuente (`aw check-branch --source <alias>`; ver rol `git`). Si no coincide → **pausa y resuelve con el humano**; nunca `stash`/`reset --hard`/`checkout -- .`/`clean` sin confirmación por fuente.
- **Commits propuestos** (propose-then-execute, aprobar antes): **tras pasar el gate de revisión de cierre** (abajo), propone commits **por fuente** — en plan-exec al cerrar cada fase (o al `Cerrar`); en quick, **un solo commit** al final si hubo cambios de código. Nunca `push`/`--amend`/`--no-verify`. Nada llega a un commit propuesto sin revisar.
- **Commit rechazado**: los cambios **quedan en el working tree** (no se revierten). Se permite reproponer / editar mensaje. Se registra en `CHECKPOINT` + `BACKLOG` que la fase/tarea quedó **sin commitear** (reanudable).
- **Precondición entre fases** (plan-exec): `branch-check` valida *identidad* de rama, **no** *limpieza* del working tree. Antes de iniciar la siguiente fase, el working tree de cada fuente debe estar **limpio** (committeado) o explícitamente **reconocido** como "cambios sin commitear de la fase N" — para no co-mezclar dos fases en un mismo commit.

## BD solo-scripts — la IA nunca ejecuta DML/DDL

Distinción por **ejecución**, no por archivo (ver el esquema [`SCRIPTS.sql`](../artifacts/artifacts-core/SCRIPTS.sql)):

- **Consultas read-only** (diagnóstico/validación) → `SCRIPTS.sql` (artefacto de la session); la IA **sí** las ejecuta read-only vía MCP (`sql-mutation-guard`).
- **Migraciones DDL/DML** (cambios de esquema/datos) → la IA las **redacta en `SCRIPTS.sql`** (artefacto de la session) pero **NUNCA las ejecuta**.

> El SQL mutante **queda en la session**, no se mueve a `docs/`. Su promoción a `docs/scripts/` (forward + rollback) la hace un `export-*` **aparte**, no el loop.

## Gate de revisión de cierre (convenciones, pre-commit)

Tras la validación (de la fase en plan-exec; de la tarea en quick, proporcional) y **antes de proponer sus commits** (también en un `Cerrar` anticipado, antes de proponer los commits pendientes), el diff pasa un **gate de revisión de cierre**:

- **Re-lectura independiente** del diff (subagente o re-lectura limpia — la *verificación independiente* del motor: no asume correcta la implementación; *only command output counts*).
- **Aplica las convenciones ambientes instaladas** relevantes al stack tocado (estándares de código/stack, seguridad, revisión de diffs, familias propias del workspace) — el host las **auto-descubre por su `description`**. El workflow **no nombra ni bindea** skills concretas: **crea el momento; las skills instaladas lo llenan** (por eso la revisión **no es un rol** — ver [`../roles/README.md`](../roles/README.md)). Sin skills de convenciones instaladas → checklist genérico mínimo: SOLID/early-return, nombres claros, DRY, errores no silenciados, sin secrets/PII, SQL parametrizado, sin código muerto, + las `Validations` del plan (si las hay).
- **Hallazgos**: se **corrigen** en el working tree y se **re-corre la validación** (el gate no reemplaza los tests: los re-verifica tras corregir), o se **difieren justificados** (→ `Open questions` del plan + `BACKLOG`; en quick, `BACKLOG`); lo no obvio → `DECISION`. Integridad del gate (ver [`CHASSIS.md`](CHASSIS.md) § *Verification-first*): nunca se debilita un check ni se baja una convención para pasar.
- **Artifact-first + verification-first**: `CHECKPOINT.Next = "review <fase/tarea>"` antes de la pasada; `SESSION.Success criteria` incluye desde el inicio "el diff pasó el gate de revisión antes de sus commits".

Recién con el gate en verde se proponen los commits.

## Localización

Igual que el chasis: los loops que editan código lo referencian como `../CODE-POLICIES.md` (instalación normal, árbol `w/loops/`); en instalaciones **aplanadas** (p. ej. Warp/Oz) puede estar como `CODE-POLICIES.md` **junto al `SKILL.md` del loop**.
