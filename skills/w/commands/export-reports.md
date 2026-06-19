---
description: Genera un informe ejecutivo/funcional en docs/reports/ consolidando el corpus de sesiones (spec, CONCLUSIONS, DECISION), el plan-doc y el estado de docs/. Single-pass, explícito.
argument-hint: [--sesiones <ids>] [--tipo <ejecutivo|funcional>] [--dry-run]
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Skill",
  ]
---

# export-reports — exportar informes

Consolida el corpus completo de sesiones (`CONCLUSIONS`, `DECISION`, spec) + plan-doc (estado) + `docs/` y genera un informe ejecutivo o funcional en `docs/reports/`. Single-pass, read-only sobre sesiones. Invoca el skill `export-reports`.

```
Skill: export-reports
args: $ARGUMENTS
```

## Qué produce

- `docs/reports/`: informe consolidado, cross-session, con dedup y estado de avance.
- **No** muta sesiones ni abre/cierra loops.
- Solo escribe en `docs/reports/`.

## Plan mode

Describe el alcance e índice del informe que generaría (secciones, sesiones fuente, estado de avance) sin escribir archivos.

## Resources

- Export skill: `../exports/export-reports/SKILL.md`
- Design reference: `docs/referencias/workflow-exports/README.md`
