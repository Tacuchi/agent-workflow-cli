---
description: Atajo liviano para trabajo acotado (fix, ajuste, chore) que no amerita spec ni plan. Inicia quick-loop. No toca docs/. Si el objetivo excede un quick o la tarea crece, escala: a SPEC en vivo (con consentimiento), a PLAN diferido.
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

Para tareas acotadas y directas que no justifican pasar por SPEC ni PLAN. Crea una sesión ligera (trazabilidad + resume) — salvo que el **gate de tamaño a la entrada** escale a SPEC antes de empezar. Delega a `quick-loop` (Layer 2).

## Ejecutar el loop

`quick-loop` **no** es una skill invocable por nombre — es el manual de operación de este comando (un doc hermano del bundle). **Cargalo y ejecutalo de punta a punta**:

1. **Leé** `../loops/quick-loop/SKILL.md` (dentro de la skill `w` instalada — p. ej. `~/.claude/skills/w/loops/…`).
2. **Seguí** sus instrucciones tomando `$ARGUMENTS` como la tarea: evalúa el gate de tamaño, crea la session ligera, trabaja con ceremonia mínima (git-safe), escala si excede o crece (SPEC en vivo / PLAN diferido), y reporta.

> No intentes `Skill: quick-loop` — no está registrada como skill. El comando **es** la entrada; el loop es su cuerpo.

## Qué hace el loop

- Edita código en las fuentes del workspace.
- Artefactos mínimos en la sesión (DECISION lazy, commit propuesto).
- **Gate de revisión de cierre proporcional** antes de proponer el único commit: re-lee el diff aplicando las convenciones ambientes instaladas y corrige o difiere (ver `../loops/quick-loop/SKILL.md` § *Sequence*).
- **No toca `docs/`** ni exporta nada.
- **Escala** si emerge complejidad — **gate de tamaño a la entrada** (antes de crear la session) y mid-loop (muchos archivos, ≥2 fuentes, necesita arquitectura, o el cambio es feature/refactor). Aceptar **SPEC** = transición **en vivo** al flujo SPEC (borrador vía procedimiento spec-new + spec-refine-loop); **PLAN** queda sembrado para retomar. Ver `../loops/quick-loop/SKILL.md` § *Delta QUICK*.

## Plan mode

El skill describe los cambios que aplicaría y los archivos que tocaría, sin ejecutarlos. Incluye la escalación: si el gate (de entrada o mid-loop) dispararía, la describe (opciones + spec que materializaría) sin escribir `docs/` ni arrancar loops.

## Resources

- Loop skill: `../loops/quick-loop/SKILL.md`
- Design reference: `docs/referencias/workflow-commands/quick.md`
