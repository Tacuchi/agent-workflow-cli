---
name: design-workflow
description: Workflow especializado design (especialidad UX/UI spec-only), antes en qtc-design. Consumido por /agent-workflow:session cuando flow=design para orquestar el lifecycle universal con composición design-específica (Double Diamond → 4 fases v4.0).
version: 2.2.0
flow: design
workflow_schema: 1.0
---

# Design Workflow

Workflow declarativo del flow=design. Define dos modos:

- **Standalone** (`/agent-workflow:use`): produce specs UI puntuales sin sesión.
- **Orchestrated** (consumido por `/agent-workflow:session` con flow=design): orquesta Double Diamond → 4 fases v4.0.

## Brief

**flow=design** es la especialidad UX/UI **spec-only** del plugin qtc. No edita código de framework; produce specs (`DELIVERY.md`) consumibles por flow=dev vía handoff.

**Política de commits**: ver `agent-workflow:commits-policy` (canónico). Cualquier commit que el usuario solicite — closure auto-disparado o solicitud explícita — pasa por el flujo M1 propose-then-execute (Regla 3 universal).

**Política sin fallback al CLI (transversal al flow=design)**: si `agent-workflow <subcmd>` falla (no está en PATH, comando no reconocido, exit code != 0), **cortá la acción y reportá al usuario**: pedile que verifique `npm install -g @tacuchi/agent-workflow-cli`. No hay flujo alternativo Python.

Skills disponibles:
- **design-brief**: captura contexto y restricciones del diseño.
- **design-discover**: exploración visual + research.
- **design-develop**: iteración de propuestas.
- **design-deliver**: spec final DELIVERY.md (type: project | system).
- **frontend-design**: patterns UX agnósticos (single-slot, máster-slave, validación inline) — exportada cross-flow.

Diferencia clave de **type** (metadato interno del documento — la carpeta destino NO depende del type):
- `project` (legacy: `proyecto`): pantalla/feature concreta. Spec DELIVERY.md describe la pantalla.
- `system` (legacy: `sistema`): tokens, componentes, design system. Spec DELIVERY.md describe los CAMBIOS al DS (delta + migration).

**Ambos types gradúan a `docs/especificaciones/NNN-<slug>/`** (kind=`especificacion`, modelo nuevo DEC-003). El `## Type` queda como metadato dentro del archivo, no afecta el routing.

## Standalone (use) — DEPRECADO (session096)

> `/agent-workflow:use` nunca se materializó como comando. Para diseño con trazabilidad usá `/agent-workflow:session --flow design`. El micro-lifecycle `/agent-workflow:patch` es para tareas dev con cambio (no aplica a diseño). Esta sección queda como histórico read-only; no describe un comando activo.

## Session integration

Cuando agent-workflow:session consume este workflow durante `/agent-workflow:session create` con flow=design:

### Args al crear sesión

- type: project|system (obligatorio; queda como metadato `## Type` interno del documento; **no** determina graduación — todo va a `docs/especificaciones/`). Legacy ES `proyecto|sistema` aceptado.

### Artefactos por fase

- planning: OBJECTIVE.md, BRIEF.md, TASKS.md
- execution: DISCOVERY.md, PROBLEM.md, IDEAS.md, DELIVERY.md, opcional lectura de `<workspace-root>/docs/referencias/` (carpeta transversal, material del usuario)
- validation: feedback en TASKS, marcado de criterios
- closure: graduación a `docs/especificaciones/` (kind=`especificacion`)

### Skills por fase

- planning: design-brief, analyze-synthesize (cross-flow, sugerir)
- execution: design-discover, design-develop, design-deliver, frontend-design
- validation: design-deliver (review final)
- closure: graduate `--kind especificacion` (a `docs/especificaciones/NNN-<slug>/`)

### Refs HISTORY

- especificacion: docs/especificaciones/{val}/

### Conteos resume

- discovery: DISCOVERY.md presente
- problem: PROBLEM.md presente
- ideas: IDEAS.md presente
- delivery: DELIVERY.md presente
- referencias: docs/referencias/ count (carpeta transversal manual del usuario, lazy — DEC-004 v2)

## Sandbox read-only

Standalone: en plan mode describir qué type se elegiría, qué artefactos se sugieren, qué paths. No escribir.

Orchestrated: ver `agent-workflow:session` plan mode rules.
