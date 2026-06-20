---
description: Inicia o retoma el loop de refinamiento de una especificación (spec-refine-loop). Input: docs/specs/NNN-spec.md (borrador). Output: docs/specs/NNN-spec-refined.md.
argument-hint: <docs/specs/NNN-spec.md>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# spec-refine — trampolín al loop de refinamiento

Este comando no refina el spec él mismo: delega al loop `spec-refine-loop` (Layer 2), que es quien itera, cierra gaps y produce el spec refinado.

## Ejecutar el loop

`spec-refine-loop` **no** es una skill invocable por nombre — es el manual de operación de este comando (un doc hermano del bundle). **Cargalo y ejecutalo de punta a punta**:

1. **Leé** `../loops/spec-refine-loop/SKILL.md` (ruta relativa a este archivo).
2. **Seguí** sus instrucciones tomando `$ARGUMENTS` como input: detecta estado/resume, corre el motor gap-driven, crea y maneja sessions, converge y reporta.

> No intentes `Skill: spec-refine-loop` — no está registrada como skill. El comando **es** la entrada; el loop es su cuerpo.

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
