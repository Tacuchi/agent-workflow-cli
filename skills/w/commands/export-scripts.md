---
description: Exporta scripts de BD (SCRIPTS.sql tipo-B) de N sesiones a docs/scripts/ como forwards numerados + rollback. Paso explícito y aparte — nunca automático.
argument-hint: [--sessions <ids>] [--dry-run]
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
  ]
---

# export-scripts — exportar scripts de BD

Promueve los artefactos `SCRIPTS.sql` (tipo B — migraciones) de N sesiones de `.workflow/sessions/` a `docs/scripts/`. Single-pass, read-only sobre sesiones.

Para ejecutar: **leé** `../exports/export-scripts/SKILL.md` y **seguí** sus instrucciones con `$ARGUMENTS` como input. No intentes `Skill: export-scripts` (no está registrada por nombre); el SKILL.md hermano es el cuerpo de este export.

## Qué produce

- `docs/scripts/`: forwards numerados de forma continua (cross-session, dedup) + `00-ROLLBACK.sql`.
- **No** muta sesiones ni abre/cierra loops.
- La IA **nunca ejecuta** los scripts — solo los consolida y entrega.

## Plan mode

Describe los scripts que consolidaría y la estructura de `docs/scripts/` que generaría, sin escribir archivos.

## Resources

- Export skill: `../exports/export-scripts/SKILL.md`
- Design reference: `docs/referencias/workflow-exports/README.md`
