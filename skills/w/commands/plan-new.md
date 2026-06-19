---
description: Inicia o retoma el loop de planificación (plan-new-loop) a partir de un spec refinado. Convierte el "qué" (spec) en el "cómo" (plan). Input ideal: docs/specs/NNN-spec-refined.md.
argument-hint: <docs/specs/NNN-spec-refined.md | docs/specs/NNN-spec.md | prompt>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Skill",
  ]
---

# plan-new — trampolín al loop de planificación

Puente SPEC → PLANIFICATION. Convierte el "qué" (spec refinado) en el "cómo" (plan). Delega a `plan-new-loop` (Layer 2).

## Resolución de input

El skill evalúa `$ARGUMENTS`:

1. **`docs/specs/NNN-spec-refined.md`** → ideal. Procede directamente a `plan-new-loop`.
2. **`docs/specs/NNN-spec.md`** (borrador sin refinar) → propone correr `/w:spec-refine` primero; planificar sobre un spec sólido produce mejores planes.
3. **prompt** (sin spec referenciado) → propone usar el flujo SPEC; **por default lanza `/w:spec-new`** con ese prompt para crear el borrador, y desde ahí continúa el flujo natural.

Invocar el skill:

```
Skill: plan-new-loop
args: $ARGUMENTS
```

## Notas de numeración

El plan toma su propio número `PPP` en `docs/plans/`. **No hereda el `NNN` del spec**. El vínculo al spec se establece por referencia (`## Origin` / "Derivado de") en el plan, no por número.

## Plan mode

El skill resuelve el input según las 3 reglas de arriba y describe las acciones del loop que ejecutaría, sin arrancar la iteración.

## Resources

- Loop skill: `../loops/plan-new-loop/SKILL.md`
- Design reference: `docs/referencias/workflow-commands/plan-new.md`
