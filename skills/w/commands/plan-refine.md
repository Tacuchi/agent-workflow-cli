---
description: Inicia o retoma el loop de refinamiento de un plan (plan-refine-loop). Paso auxiliar y NO obligatorio del flujo PLAN — refina un plan existente in place antes de ejecutarlo. Input ideal: docs/plans/PPP-plan-<slug>.md ya generado por plan-new.
argument-hint: <docs/plans/PPP-plan-<slug>.md>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# plan-refine — trampolín al loop de refinamiento del plan

Paso **auxiliar y NO obligatorio** del flujo PLAN: el gemelo de `spec-refine`, pero sobre el **plan**. `plan-new` ya produce un plan a partir del spec refinado; `plan-refine` existe para cuando —**antes de ejecutar**— surgen cambios (nuevos requerimientos, ajustes de alcance, deps o riesgos que aparecen al releer el plan) que conviene incorporar sin re-generar el plan desde cero.

Este comando no refina el plan él mismo: delega al loop `plan-refine-loop` (Layer 2), que itera, cierra gaps y edita el plan **in place**.

> **No obligatorio.** `plan-exec` corre **cualquier** plan, refinado o no — no hay gate que exija pasar por aquí. Usalo solo cuando el plan necesite ajustes antes de ejecutar.

## Resolución de input

El skill evalúa `$ARGUMENTS` (los planes viven in place — `docs/plans/PPP-plan-<slug>.md`; localizar vía glob `docs/plans/PPP-plan-*.md` o la ruta exacta):

1. **Plan existente** (`docs/plans/PPP-plan-<slug>.md`) → procede a `plan-refine-loop`.
2. **Sin plan** (el arg no referencia un plan, o no hay ninguno) → **soft-suggest** correr `/w:plan-new` primero (no hay nada que refinar todavía); el usuario decide.

## Ejecutar el loop

`plan-refine-loop` **no** es una skill invocable por nombre — es el manual de operación de este comando (un doc hermano del bundle). **Cargalo y ejecutalo de punta a punta**:

1. **Leé** `../loops/plan-refine-loop/SKILL.md` (ruta relativa a este archivo).
2. **Seguí** sus instrucciones tomando `$ARGUMENTS` como input: detecta estado/resume, corre el motor gap-driven, crea y maneja sessions, converge y reporta.

> No intentes `Skill: plan-refine-loop` — no está registrada como skill. El comando **es** la entrada; el loop es su cuerpo.

## Resolución de estado (resumable)

El skill detecta el estado previo antes de arrancar, **keyando off el `CHECKPOINT`** (no un archivo "refined"):

1. Busca la sesión de refinamiento del plan en `.workflow/sessions/` (descriptor `<slug>-plan-refine` + `## Origin`) y su `CHECKPOINT.md`.
2. **En curso** (existe CHECKPOINT) → continúa desde el avance previo (gaps resueltos, Q&A).
3. **Sin avance** (sin CHECKPOINT y el plan **no** tiene `## Refinement decisions`/`## Q&A traceability`) → arranca desde cero leyendo el plan (`PPP-plan-*.md`).
4. **Ya refinado / re-refine a demanda** (sin CHECKPOINT abierto pero el plan **ya tiene** `## Refinement decisions`/`## Q&A traceability`) → **soportado de primera clase**: mientras el flujo siga en PLAN podés re-correr `/w:plan-refine` sobre el mismo plan **las veces que haga falta** (nuevos requerimientos, cambios de scope, re-lectura). El loop hace `create_or_resume` — localiza la refine session existente (aunque esté cerrada) y la **reabre** en vez de duplicarla — y re-refina leyendo el **plan mismo**; al `Guardar`, edita in place con confirmación.

## Plan mode

El skill resuelve el estado y describe las acciones que ejecutaría el loop (gaps que cerraría, preguntas que haría), sin arrancar la iteración.

## Resources

- Loop skill: `../loops/plan-refine-loop/SKILL.md`
- Design reference: `docs/referencias/workflow-commands/plan-refine.md`
