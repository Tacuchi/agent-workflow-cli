---
name: design-brief
description: Capta el brief inicial de una sesión de diseño y declara el `## Type` (project|system). Invocado desde la fase planning del lifecycle universal de agent-workflow cuando el OBJECTIVE menciona UI/UX/diseño/pantalla/mockup/wireframe. Produce OBJECTIVE.md con secciones Type, Brief, Context y Acceptance criteria. No produce código ni mocks aún — sólo capturar QUÉ y POR QUÉ.
version: 1.1.0
---

# design-brief — agent-workflow v1.0+

Specialty skill **design**: capta el brief y el tipo de sesión durante la fase `planning` del lifecycle universal.

## Cuándo se invoca

- Composición desde `agent-workflow:session` en `planning` cuando el OBJECTIVE menciona UI/UX/diseño/pantalla/mockup/wireframe/layout/forma.
- Devuelta por `agent-workflow specialty-choose --phase planning` si el OBJECTIVE incluye keywords de design.
- NL del usuario: "abrí una sesión de diseño", "vamos a diseñar X", "necesito un mock de Y".

## Pre-requisitos

1. Bloque AW-PROJECT presente. Si no → proponer `/agent-workflow:project-init`.
2. Sesión nueva (o existente sin OBJECTIVE completo).

## Acción

### 1. Pedir al usuario

| Campo | Tipo | Ejemplos |
|---|---|---|
| **Type** | `project` \| `system` (legacy ES: `proyecto`/`sistema`) | `project` = pantalla/mantenimiento concreto. `system` = tokens/componentes compartidos. |
| **Nombre** | slug-kebab ≤4 palabras | `mock-lista-negra`, `tokens-spacing`, `wizard-nuevo-cliente` |
| **Brief corto** | 1-3 oraciones | quién (rol/usuario), qué problema, constraints clave |
| **Acceptance criteria** | lista | cómo sabemos que la sesión cumple su objetivo |

Si el OBJECTIVE no declara `## Type`, **dispara `AskUserQuestion`** con spec de S1 (`agent-workflow:prompts-catalog#S1`). Header `design-type`, 2 opciones (Project / System). Si el usuario activa el Other auto, pedir clarificación libre y NO inferir el type desde el texto — la sesión queda sin type hasta que el usuario lo declare.

NO narrar la pregunta en texto plano (ej. "¿Esto es proyecto o sistema?" en chat es un anti-patrón).

### 2. Crear sesión

```
agent-workflow session-create \
    --name <slug> \
    --objetivo "<brief>" \
    --type <project|system>
```

Crea `.workflow/sessions/sessionNNN-design-<slug>/OBJECTIVE.md` con `## Type` + `## Brief` pre-cargados. Las flags legacy `--tipo proyecto|sistema` siguen aceptadas y se normalizan a EN.

### 3. Iterar el brief si hace falta

Si el brief es vago o ambiguo:
- 1-2 preguntas de clarificación (no más).
- Editar OBJECTIVE.md (legacy: OBJETIVO.md) con la versión refinada.
- Confirmar con el usuario antes de avanzar.

### 4. Hand-off a planning del lifecycle universal

Reportar al `agent-workflow:session` que el brief está cerrado y el plan structurado puede empezar (si auto-plan dice `full` o `lite`). Para `type=system`, plan suele ser `lite` (tareas predecibles); para `type=project`, suele ser `full` (criterios + variantes).

## Reglas

- **Spec-only**: NO escribir código. NO escribir mocks aún (eso es design-develop).
- **Type es obligatorio**: sin `Type` no se crea la sesión. Convención shared-contract §11.
- **Brief corto**: si el usuario quiere extender, hacerlo en `## Context` o en `DISCOVERY.md` (más adelante).
- **No asumir framework de UI**: el brief habla del problema, no de Angular/React/Bootstrap. Eso lo decide el flow=dev al implementar.

## Composición con otras skills

| Skill | Cuándo |
|---|---|
| `design-discover` | siguiente paso, en fase `execution` (investigación de usuarios/flows/sistema existente) |
| `design-develop` | divergencia/convergencia de soluciones, en `execution` |
| `design-deliver` | spec final, al cerrar `execution` antes de `validation` |
| `frontend-design` | reglas agnósticas de UI (form/list/modal/navigation/feedback) — referenciar pero no invocar acá |

## Sandbox read-only

Reglas universales en el canon (`sandbox-readonly-rules.md`). En plan mode esta skill describe en el plan file:

- Campos a pedir al usuario para capturar el brief: nombre/slug, Type (`project`|`system`; legacy ES aceptado), Brief, Context, Acceptance criteria, Inspiración.
- Que el OBJECTIVE.md se crearía a partir del template `objetivo-design.md` (interno del CLI) con esos campos.
- Que `agent-workflow session-create` se invocaría — pero NO se ejecuta hasta salir de plan mode.

NO ejecuta: `agent-workflow session-create`, `Write` sobre OBJECTIVE.md.

## Recursos

- shared-contract §11 — convención `## Type` (project|system; legacy ES `proyecto`/`sistema`).
- shared-contract §14 — fase planning del lifecycle universal.
- `agent-workflow:prompts-catalog#S1` — spec literal del prompt design-type (header, opciones, manejo del Other).
- skill `frontend-design` — principios de UI agnósticos del framework.
