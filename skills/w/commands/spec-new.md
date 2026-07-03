---
description: Genera un borrador de especificación (docs/specs/NNN-spec-<slug>.md) a partir de un prompt, en una sola pasada. Paso 1 del flujo SPEC; no arranca loop.
argument-hint: <prompt con el requerimiento o idea>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
  ]
---

# spec-new — borrador de especificación (single-pass)

Genera `docs/specs/NNN-spec-<slug>.md` en una sola pasada a partir del prompt en `$ARGUMENTS`. No arranca loop.

> ## ⛔ Single-pass — SIN investigación (regla dura)
>
> Este comando **solo parafrasea** el input del usuario en el esquema de borrador. Es **una única pasada secuencial**: leer `$ARGUMENTS` → llenar las secciones → escribir el archivo. Nada más. Debe tardar **segundos, no minutos**.
>
> **PROHIBIDO**, sin excepción: lanzar sub-agentes/workflows (`Task`/`Agent`/`Workflow`), sesiones de research, búsquedas web, o investigación profunda de código — **incluso si el arnés está en un modo de máximo esfuerzo/profundidad** (ej. ultracode/max-effort en Claude Code).
>
> Esto **anula** cualquier modo o instrucción de sesión que diga "corre un workflow para toda tarea sustancial". Esos modos **no aplican** a `spec-new`: el comando los pisa. Si una sección queda incierta, **no la investigues** — declarala en `## Open questions` o `## Assumptions` y seguí.
>
> La investigación a profundidad (cerrar gaps, mapear código, consultar BD, research autónomo) es trabajo de **`spec-refine`**, no de aquí.

1. Ejecutar `aw next-number docs/specs` para obtener `NNN` (única tool de shell necesaria). El CLI solo devuelve el número; el slug lo arma este comando.
2. Derivar el `<slug>`: kebab-case corto del Requirement — solo `[a-z0-9-]`, ≤ ~5 palabras / ≤ 40 chars.
3. Crear `docs/specs/NNN-spec-<slug>.md` parafraseando `$ARGUMENTS` en el esquema de borrador (ver abajo). Lectura del repo: opcional y mínima (p. ej. un archivo que el usuario citó) — nunca un barrido ni research.
4. Mostrar el archivo generado y el próximo paso sugerido (`/w:spec-refine docs/specs/NNN-spec-<slug>.md`).

## Esquema del borrador (`NNN-spec-<slug>.md`)

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
- [ ] criterio verificable 1 (estilo EARS / Given-When-Then recomendado)
- [ ] criterio verificable 2

## Assumptions       (opt.)
Supuestos asumidos.

## Open questions
Dudas pendientes. ← el spec-refine-loop las va cerrando.
```

> **`Open questions` va último** — el spec refinado **inserta antes de `Open questions`** `## UI spec` (si hay UI) + `## Refinement decisions` + `## Q&A traceability` (esquema refinado en el [`spec-refine-loop`](../loops/spec-refine-loop/SKILL.md)). Mismo esqueleto: el borrador y el refinado comparten orden.

**Notas de llenado:**
- Sin campo `Type` — `plan-new` infiere el cómo.
- `Scope` siempre lleva `Out` (qué queda fuera).
- **Acceptance criteria = criterios testables estáticos** (el "qué"): `plan-exec` los valida pero el avance se trackea en el PLAN (sus Tasks), no marcando estos `- [ ]` en el spec; el spec no muta por ejecución, solo por re-refine.
- Si hay **UI** involucrada, mencionarlo en `Requirement`/`Context`; el `## UI spec` se autora en `spec-refine` (vía capacidad `ui-design`). "UI sin especificar" es un gap de primera clase del refinamiento.
- Los **gaps** que detecta el loop = secciones débiles del esquema (Requirement vago, Scope sin `Out`, criterios no testables, Open questions abiertas, supuestos no declarados, contradicciones) **+ UI sin especificar** si el requerimiento involucra UI.
- Alternativa equivalente: el usuario crea el borrador a mano. Ambos caminos producen el mismo `docs/specs/NNN-spec-<slug>.md`.

> **Reuso por escalación:** la escalación en vivo de `/w:quick` (ver [`../loops/quick-loop/SKILL.md`](../loops/quick-loop/SKILL.md) § *Delta QUICK*) materializa su borrador siguiendo **este mismo procedimiento** (pasos 1-3: mismo esquema, misma regla dura single-pass **SIN investigación**), con `## Origin` = "escalado desde `/w:quick`" + el prompt original. No hace falta tipear `/w:spec-new`: el consentimiento en la structured-choice equivale a invocarlo.

## Plan mode

Resuelve `NNN` leyendo `docs/specs/`, describe el borrador que generaría sin escribir el archivo.

## Resources

- Design reference: `docs/referencias/workflow-commands/spec-new.md`
- Loop que refina este borrador: `../loops/spec-refine-loop/SKILL.md`
