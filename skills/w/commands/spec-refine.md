---
description: Inicia o retoma el loop de refinamiento de una especificación (spec-refine-loop). Input: docs/specs/NNN-spec.md (borrador). Output: docs/specs/NNN-spec-refined.md.
argument-hint: <docs/specs/NNN-spec.md>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Skill",
  ]
---

# spec-refine — trampolín al loop de refinamiento

Este comando no refina el spec él mismo: delega al loop `spec-refine-loop` (Layer 2), que es quien itera, cierra gaps y produce el spec refinado.

Invocar el skill:

```
Skill: spec-refine-loop
args: $ARGUMENTS
```

## Resolución de estado (resumable)

El skill detecta el estado previo antes de arrancar:

1. Busca la sesión de refinamiento del spec en `.workflow/sessions/` y su `CHECKPOINT.md`.
2. **En curso** (existe CHECKPOINT) → continúa desde el avance previo (gaps resueltos, Q&A).
3. **Sin avance** (sin CHECKPOINT ni refined) → arranca desde cero leyendo `NNN-spec.md`.
4. **Ya completado** (existe `NNN-spec-refined.md`, sin CHECKPOINT abierto) → re-refinamiento incremental: lee el **refined** como input (NO el borrador stale); al `Guardar`, sobrescribe con confirmación.

## Plan mode

El skill resuelve el estado y describe las acciones que ejecutaría el loop (gaps que cerraría, preguntas que haría), sin arrancar la iteración.

## Resources

- Loop skill: `../loops/spec-refine-loop/SKILL.md`
- Design reference: `docs/referencias/workflow-commands/spec-refine.md`
