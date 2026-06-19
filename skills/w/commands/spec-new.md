---
description: Genera un borrador de especificación (docs/specs/NNN-spec.md) a partir de un prompt, en una sola pasada. Paso 1 del flujo SPEC; no arranca loop.
argument-hint: <prompt con el requerimiento o idea>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
  ]
---

# spec-new — borrador de especificación (single-pass)

Genera `docs/specs/NNN-spec.md` en una sola pasada a partir del prompt en `$ARGUMENTS`. No arranca loop.

1. Ejecutar `aw next-number docs/specs` para obtener `NNN`.
2. Crear `docs/specs/NNN-spec.md` con el esquema de borrador (ver abajo).
3. Mostrar el archivo generado y el próximo paso sugerido (`/w:spec-refine docs/specs/NNN-spec.md`).

## Esquema del borrador (`NNN-spec.md`)

```markdown
# Spec NNN — <slug>

## Origin            (opt.)
Prompt original / doc previo / referencia que originó el spec.

## Requirement
El qué se necesita + por qué (breve). En lenguaje del usuario.

## Context           (opt.)
Sistemas / componentes / fuentes involucradas. Restricciones conocidas.

## Scope
- In:  qué entra
- Out: qué NO entra

## Acceptance criteria
- [ ] criterio verificable 1
- [ ] criterio verificable 2

## Open questions
Dudas pendientes. ← el spec-refine-loop las va cerrando.

## Assumptions       (opt.)
Supuestos asumidos.
```

**Notas de llenado:**
- Sin campo `Type` — `plan-new` infiere el cómo.
- `Scope` siempre lleva `Out` (qué queda fuera).
- Los criterios de aceptación deben ser verificables (testeables).
- Si hay UI involucrada, mencionarlo en `Requirement`/`Context`; el spec UI se autora en `spec-refine` (via capacidad `ui-design`).
- Alternativa equivalente: el usuario crea el borrador a mano. Ambos caminos producen el mismo `docs/specs/NNN-spec.md`.

## Plan mode

Resuelve `NNN` leyendo `docs/specs/`, describe el borrador que generaría sin escribir el archivo.

## Resources

- Design reference: `docs/referencias/workflow-commands/spec-new.md`
- Loop que refina este borrador: `../loops/spec-refine-loop/SKILL.md`
