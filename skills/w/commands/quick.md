---
description: Atajo liviano para trabajo acotado (fix, ajuste, chore) que no amerita spec ni plan. Inicia quick-loop. No toca docs/. Escala a SPEC/PLAN si la tarea crece.
argument-hint: <prompt con la tarea acotada>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Skill",
  ]
---

# quick — trampolín al loop liviano

Para tareas acotadas y directas que no justifican pasar por SPEC ni PLANIFICATION. Siempre crea una sesión ligera (trazabilidad + resume). Delega a `quick-loop` (Layer 2).

Invocar el skill:

```
Skill: quick-loop
args: $ARGUMENTS
```

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
