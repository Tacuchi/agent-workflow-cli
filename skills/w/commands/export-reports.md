---
description: Genera un informe ejecutivo/funcional en docs/reports/ consolidando el corpus de sesiones (spec, CONCLUSIONS, DECISION), el plan-doc y el estado de docs/. Single-pass, explícito.
argument-hint: [--sesiones <ids>] [--tipo <ejecutivo|funcional>] [--dry-run]
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
  ]
---

# export-reports — exportar informes

Consolida el corpus completo de sesiones (`CONCLUSIONS`, `DECISION`, spec) + plan-doc (estado) + `docs/` y genera un informe ejecutivo o funcional en `docs/reports/`. Single-pass, read-only sobre sesiones.

Para ejecutar: **leé** `../exports/export-reports/SKILL.md` y **seguí** sus instrucciones con `$ARGUMENTS` como input. No intentes `Skill: export-reports` (no está registrada por nombre); el SKILL.md hermano es el cuerpo de este export.

## Qué produce

- `docs/reports/`: informe consolidado, cross-session, con dedup y estado de avance.
- **No** muta sesiones ni abre/cierra loops.
- Solo escribe en `docs/reports/`.

## Plan mode

Describe el alcance e índice del informe que generaría (secciones, sesiones fuente, estado de avance) sin escribir archivos.

## Resources

- Export skill: `../exports/export-reports/SKILL.md`
- Design reference: `docs/referencias/workflow-exports/README.md`
