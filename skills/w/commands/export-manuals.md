---
description: Genera manuales de usuario/operación en docs/manuals/ consolidando sesiones, DECISION, plan-doc y código fuente. Single-pass, explícito.
argument-hint: [--sessions <ids>] [--audiencia <usuario|operacion>] [--dry-run]
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Skill",
  ]
---

# export-manuals — exportar manuales

Consolida sesiones + artefactos `DECISION` + plan-doc (`Final behavior`) + código fuente y genera documentación de usuario/operación en `docs/manuals/`. Single-pass, read-only sobre sesiones. Invoca el skill `export-manuals`.

```
Skill: export-manuals
args: $ARGUMENTS
```

## Qué produce

- `docs/manuals/`: manuales consolidados, cross-session, dedup.
- **No** muta sesiones ni abre/cierra loops.
- Solo escribe en `docs/manuals/`.

## Plan mode

Describe el alcance de los manuales que generaría (secciones, sesiones fuente) sin escribir archivos.

## Resources

- Export skill: `../exports/export-manuals/SKILL.md`
- Design reference: `docs/referencias/workflow-exports/README.md`
