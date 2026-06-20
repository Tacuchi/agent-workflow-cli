---
description: Genera manuales de usuario/operación en docs/manuals/ consolidando sesiones, DECISION, plan-doc y código fuente. Single-pass, explícito.
argument-hint: [--sessions <ids>] [--audiencia <usuario|operacion>] [--dry-run]
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
  ]
---

# export-manuals — exportar manuales

Consolida sesiones + artefactos `DECISION` + plan-doc (`Final behavior`) + código fuente y genera documentación de usuario/operación en `docs/manuals/`. Single-pass, read-only sobre sesiones.

Para ejecutar: **leé** `../exports/export-manuals/SKILL.md` y **seguí** sus instrucciones con `$ARGUMENTS` como input. No intentes `Skill: export-manuals` (no está registrada por nombre); el SKILL.md hermano es el cuerpo de este export.

## Qué produce

- `docs/manuals/`: manuales consolidados, cross-session, dedup.
- **No** muta sesiones ni abre/cierra loops.
- Solo escribe en `docs/manuals/`.

## Plan mode

Describe el alcance de los manuales que generaría (secciones, sesiones fuente) sin escribir archivos.

## Resources

- Export skill: `../exports/export-manuals/SKILL.md`
- Design reference: `docs/referencias/workflow-exports/README.md`
