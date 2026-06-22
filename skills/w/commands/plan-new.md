---
description: Inicia o retoma el loop de planificación (plan-new-loop) a partir de un spec. Convierte el "qué" (spec) en el "cómo" (plan). Input ideal: docs/specs/NNN-spec-<slug>.md ya refinado.
argument-hint: <docs/specs/NNN-spec-<slug>.md | prompt>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# plan-new — trampolín al loop de planificación

Puente SPEC → PLANIFICATION. Convierte el "qué" (spec refinado) en el "cómo" (plan). Delega a `plan-new-loop` (Layer 2).

## Resolución de input

El skill evalúa `$ARGUMENTS` (los specs viven in place — `docs/specs/NNN-spec-<slug>.md`; localizar vía glob `docs/specs/NNN-spec-*.md` o la ruta exacta):

1. **Spec refinado** (`docs/specs/NNN-spec-<slug>.md` que **ya tiene** `## Refinement decisions` / `## Q&A traceability`) → ideal. Procede directamente a `plan-new-loop`.
2. **Spec borrador** (mismo archivo, pero **sin** esas dos secciones) → **soft-suggest** correr `/w:spec-refine` primero; planificar sobre un spec sólido produce mejores planes (el usuario puede proceder igual).
3. **prompt** (sin spec referenciado) → propone usar el flujo SPEC; **por default lanza `/w:spec-new`** con ese prompt para crear el borrador, y desde ahí continúa el flujo natural.

> **Refinado vs borrador** se distingue por la **presencia** de `## Refinement decisions` / `## Q&A traceability` en el spec, no por el nombre del archivo (ya no hay `-refined`).

## Ejecutar el loop

`plan-new-loop` **no** es una skill invocable por nombre — es el manual de operación de este comando (un doc hermano del bundle). **Cargalo y ejecutalo de punta a punta**:

1. **Leé** `../loops/plan-new-loop/SKILL.md` (ruta relativa a este archivo).
2. **Seguí** sus instrucciones tomando `$ARGUMENTS` como input (resuelto según las 3 reglas de arriba): detecta estado/resume, corre el motor gap-driven, crea y maneja sessions, converge y reporta.

> No intentes `Skill: plan-new-loop` — no está registrada como skill. El comando **es** la entrada; el loop es su cuerpo.

## Notas de numeración

El plan se nombra `docs/plans/PPP-plan-<slug>.md`. El CLI solo devuelve el número `PPP`; el loop arma el nombre completo (slug = kebab-case corto del Requirement: `[a-z0-9-]`, ≤ ~5 palabras / ≤ 40 chars). **No hereda el `NNN` del spec**. El vínculo al spec se establece por referencia (`## Origin` / "Derivado de") en el plan, no por número.

## Plan mode

El skill resuelve el input según las 3 reglas de arriba y describe las acciones del loop que ejecutaría, sin arrancar la iteración.

## Resources

- Loop skill: `../loops/plan-new-loop/SKILL.md`
- Design reference: `docs/referencias/workflow-commands/plan-new.md`
