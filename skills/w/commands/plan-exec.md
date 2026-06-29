---
description: Inicia o retoma el loop de ejecución (plan-exec-loop) sobre un plan existente. Aquí ocurre el trabajo real: edición de código, scripts SQL propuestos, herramientas creadas. Git-safe.
argument-hint: <docs/plans/PPP-plan-<slug>.md>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# plan-exec — trampolín al loop de ejecución

Arranca o retoma `plan-exec-loop` (Layer 2), que ejecuta el trabajo real fase por fase. El plan (`docs/plans/PPP-plan-<slug>.md`) es un documento vivo que el loop mantiene actualizado (estado de fases y tareas).

## Ejecutar el loop

`plan-exec-loop` **no** es una skill invocable por nombre — es el manual de operación de este comando (un doc hermano del bundle). **Cargalo y ejecutalo de punta a punta**:

1. **Leé** `../loops/plan-exec-loop/SKILL.md` (ruta relativa a este archivo).
2. **Seguí** sus instrucciones tomando `$ARGUMENTS` como input: detecta CHECKPOINT/resume, ejecuta fase por fase (git-safe, BD solo-scripts), mantiene el plan vivo y reporta.

> No intentes `Skill: plan-exec-loop` — no está registrada como skill. El comando **es** la entrada; el loop es su cuerpo.

## Qué hace el loop (resumen)

- Lee y actualiza `docs/plans/PPP-plan-<slug>.md` (living doc: estado de fases/tareas).
- Edita código en las fuentes del workspace (una sola sesión de ejecución para el run; la ejecución sigue siendo fase por fase, solo que no hay sesión por fase).
- Si crea una herramienta/utilidad, la documenta la skill ambiente `creating-tools` en `docs/tools/` (auto-descubierta; el workflow no la bindea).
- Propone commits por fuente (git-safe: verifica rama, propone, nunca push/--amend/--no-verify).
- Genera artefactos de sesión (`DECISION`, `SCRIPTS.sql`) en `.workflow/sessions/`.
- **No exporta** a `docs/scripts`, `docs/manuals`, `docs/diagrams`, `docs/reports` — eso lo hacen los `export-*` como paso aparte.
- Scripts de BD (migraciones) van a `SCRIPTS.sql` tipo B; la IA **nunca ejecuta DML/DDL**, solo lecturas read-only vía MCP.

## Resumable

Mismo patrón que los demás loops: detecta CHECKPOINT existente y continúa desde ahí.

## Plan mode

El skill describe fase por fase lo que ejecutaría, qué archivos tocaría, y qué commits propondría, sin aplicar cambios.

## Resources

- Loop skill: `../loops/plan-exec-loop/SKILL.md`
- Design reference: `docs/referencias/workflow-commands/plan-exec.md`
