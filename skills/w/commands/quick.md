---
description: Atajo liviano para trabajo acotado (fix, ajuste, chore) que no amerita spec ni plan. Inicia quick-loop. No toca docs/. Escala a SPEC/PLAN si la tarea crece.
argument-hint: <prompt con la tarea acotada>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# quick — trampolín al loop liviano

Para tareas acotadas y directas que no justifican pasar por SPEC ni PLANIFICATION. Siempre crea una sesión ligera (trazabilidad + resume). Delega a `quick-loop` (Layer 2).

## Ejecutar el loop

`quick-loop` **no** es una skill invocable por nombre — es el manual de operación de este comando (un doc hermano del bundle). **Cargalo y ejecutalo de punta a punta**:

1. **Leé** `../loops/quick-loop/SKILL.md` (ruta relativa a este archivo).
2. **Seguí** sus instrucciones tomando `$ARGUMENTS` como la tarea: crea la session ligera, trabaja con ceremonia mínima (git-safe), escala a SPEC/PLAN si crece, y reporta.

> No intentes `Skill: quick-loop` — no está registrada como skill. El comando **es** la entrada; el loop es su cuerpo.

## Qué hace el loop

- Edita código en las fuentes del workspace.
- Artefactos mínimos en la sesión (DECISION lazy, commit propuesto).
- **No toca `docs/`** ni exporta nada.
- **Escala** a SPEC/PLAN si emerge complejidad (muchos archivos, ≥2 fuentes, necesita arquitectura, o el cambio es feature/refactor).

## Plan mode

El skill describe los cambios que aplicaría y los archivos que tocaría, sin ejecutarlos.

## Resources

- Loop skill: `../loops/quick-loop/SKILL.md`
- Design reference: `docs/referencias/workflow-commands/quick.md`
