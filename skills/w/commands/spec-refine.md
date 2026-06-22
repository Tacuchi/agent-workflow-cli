---
description: Inicia o retoma el loop de refinamiento de una especificación (spec-refine-loop). Input: docs/specs/NNN-spec-<slug>.md (borrador). Actualiza docs/specs/NNN-spec-<slug>.md in place.
argument-hint: <docs/specs/NNN-spec-<slug>.md>
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

El skill detecta el estado previo antes de arrancar, **keyando off el `CHECKPOINT`** (no la existencia de un archivo "refined"):

1. Busca la sesión de refinamiento del spec en `.workflow/sessions/` y su `CHECKPOINT.md`.
2. **En curso** (existe CHECKPOINT) → continúa desde el avance previo (gaps resueltos, Q&A).
3. **Sin avance** (sin CHECKPOINT y el spec **no** tiene `## Refinement decisions`/`## Q&A traceability`) → arranca desde cero leyendo el spec (`NNN-spec*.md`).
4. **Ya refinado** (sin CHECKPOINT abierto pero el spec **ya tiene** `## Refinement decisions`/`## Q&A traceability`) → re-refinamiento incremental leyendo el **spec mismo**; al `Guardar`, edita in place con confirmación.

> **Compat (legacy):** el glob `NNN-spec*.md` también captura specs viejos `NNN-spec.md` / `NNN-spec-refined.md`. Re-correr spec-refine los edita in place de ahí en adelante.

## Plan mode

El skill resuelve el estado y describe las acciones que ejecutaría el loop (gaps que cerraría, preguntas que haría), sin arrancar la iteración.

## Resources

- Loop skill: `../loops/spec-refine-loop/SKILL.md`
- Design reference: `docs/referencias/workflow-commands/spec-refine.md`
