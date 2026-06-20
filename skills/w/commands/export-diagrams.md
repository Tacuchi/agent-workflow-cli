---
description: Genera diagramas C4/mermaid en docs/diagrams/ a partir del código fuente y el plan-doc (AS-IS/TO-BE). Single-pass, explícito.
argument-hint: [--tipo <c4|mermaid|ambos>] [--sesiones <ids>] [--dry-run]
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
  ]
---

# export-diagrams — exportar diagramas

Lee el código de las fuentes del workspace + el plan-doc (secciones `AS-IS`/`TO-BE`) y genera diagramas C4 / mermaid en `docs/diagrams/`. Single-pass, read-only sobre sesiones.

Para ejecutar: **leé** `../exports/export-diagrams/SKILL.md` y **seguí** sus instrucciones con `$ARGUMENTS` como input. No intentes `Skill: export-diagrams` (no está registrada por nombre); el SKILL.md hermano es el cuerpo de este export.

## Qué produce

- `docs/diagrams/`: diagramas C4 y/o mermaid, numerados, cross-session.
- **No** muta sesiones ni abre/cierra loops.
- Solo escribe en `docs/diagrams/`.

## Plan mode

Describe los diagramas que generaría (tipo, componentes cubiertos) sin escribir archivos.

## Resources

- Export skill: `../exports/export-diagrams/SKILL.md`
- Design reference: `docs/referencias/workflow-exports/README.md`
