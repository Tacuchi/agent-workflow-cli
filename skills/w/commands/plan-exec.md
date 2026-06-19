---
description: Inicia o retoma el loop de ejecución (plan-exec-loop) sobre un plan existente. Aquí ocurre el trabajo real: edición de código, scripts SQL propuestos, herramientas creadas. Git-safe.
argument-hint: <docs/plans/PPP-plan.md>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Skill",
  ]
---

# plan-exec — trampolín al loop de ejecución

Arranca o retoma `plan-exec-loop` (Layer 2), que ejecuta el trabajo real fase por fase. El plan (`docs/plans/PPP-plan.md`) es un documento vivo que el loop mantiene actualizado (estado de fases y tareas).

Invocar el skill:

```
Skill: plan-exec-loop
args: $ARGUMENTS
```

## Qué hace el loop (resumen)

- Lee y actualiza `docs/plans/PPP-plan.md` (living doc: estado de fases/tareas).
- Edita código en las fuentes del workspace (una sesión por fase).
- Escribe herramientas/utilidades reutilizables en `docs/tools/`.
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
