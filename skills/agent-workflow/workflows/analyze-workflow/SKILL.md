---
name: analyze-workflow
description: Workflow especializado analyze (especialidad investigación read-only), antes en qtc-analyze. Consumido por /agent-workflow:session cuando flow=analyze para orquestar el lifecycle universal con composición analyze-específica según modalidad.
version: 2.1.0
flow: analyze
workflow_schema: 1.0
---

# Analyze Workflow

Workflow declarativo del flow=analyze. Define dos modos:

- **Standalone** (`/agent-workflow:use`): investigación puntual sin sesión.
- **Orchestrated** (consumido por `/agent-workflow:session` con flow=analyze): orquesta investigación + síntesis + recomendación según modalidad.

## Brief

**flow=analyze** es la especialidad de investigación **read-only** del plugin qtc. No edita código ni muta BD. Produce `CONCLUSIONS.md` consumible por flow=dev vía handoff.

**Política de commits**: ver `agent-workflow:commits-policy` (canónico). El flow=analyze es read-only por construcción; cuando el usuario solicita un commit (típicamente al cierre, pero puede ser en otra fase si edita artefactos), aplica Regla 3 propose-then-execute universal con M1.

**Política sin fallback al CLI (transversal al flow=analyze)**: si `agent-workflow <subcmd>` falla (no está en PATH, comando no reconocido, exit code != 0), **cortá la acción y reportá al usuario**: pedile que verifique `npm install -g @tacuchi/agent-workflow-cli`. No hay flujo alternativo Python.

### Rama base (canon v3.5+)

Las sesiones `flow=analyze` resuelven la rama esperada de cada fuente como `main_branch` (default `certificacion`) cuando NO se declaran branches en la sesión. Razón: el análisis necesita reflejar producción, no una rama de feature.

- Si el repo de la fuente está en otra rama, el lifecycle dispara el flujo proactivo de verificación (Caso A o B según `dirty`) y bloquea avance hasta resolver.
- Si durante la investigación el usuario decide **editar** código, se aplica **Caso C** (`agent-workflow/skills/session/references/branch-verification.md`): preguntar nombre de la rama de trabajo, ofrecer `checkout` (existe) o `checkout -b` desde `main_branch` (no existe), y registrar en AW-PROJECT.Status. El skill `analyze-workflow` no edita por sí mismo; la decisión de editar implica un handoff o cambio de flow.
- Override explícito al crear la sesión: `--branches alias:rama` declarado gana sobre el default `main_branch`. Útil cuando se quiere analizar contra una rama puntual (ej. una feature en validación).

Skills disponibles:
- **analyze-synthesize**: estructura información en plan/hallazgos (exportada cross-flow, **clave** invocada por agent-workflow:session en planning).
- **analyze-investigate**: recolección de evidencia divergente con cost guard (exportada).
- **analyze-conclude**: cierre del análisis con `CONCLUSIONS.md` modulado por `## Modality` (technical/incident/data). Una sola skill, una sola estructura.

Diferencia clave de **modalidad** (embebida como `## Modality` en CONCLUSIONS.md):
- `technical` (legacy: `tecnica`): pregunta arquitectónica/diseño → cuerpo modulado como propuesta (opciones consideradas + decisión recomendada).
- `data` (legacy: `datos`): análisis cuantitativo → cuerpo modulado como informe (hallazgos numéricos + interpretación + acciones sugeridas).
- `incident` (legacy: `incidente`): post-mortem retrospectivo → cuerpo modulado con timeline + causa raíz + impacto + acciones preventivas.

CONCLUSIONS.md vive en la sesión por default. Gradúa opt-in con `kind=conclusion` a `docs/conclusiones/`.

## Standalone (use) — DEPRECADO (session096)

> `/agent-workflow:use` nunca se materializó como comando. Para investigación read-only con trazabilidad usá `/agent-workflow:session --flow analyze`. El micro-lifecycle `/agent-workflow:patch` es para tareas dev con cambio (no aplica a investigación). Esta sección queda como histórico read-only; no describe un comando activo.

## Session integration

Cuando agent-workflow:session consume este workflow durante `/agent-workflow:session create` con flow=analyze:

### Args al crear sesión

- modality: technical|data|incident (obligatorio; determina graduación + template). Legacy ES `tecnica|datos|incidente` se acepta y normaliza.

### Artefactos por fase

- planning: OBJECTIVE.md, TASKS.md
- execution: EVIDENCE.md, FINDINGS.md, queries/, CONCLUSIONS.md
- validation: review de CONCLUSIONS
- closure: opt-in graduación de CONCLUSIONS.md a `docs/conclusiones/` (default: queda en sesión)

### Skills por fase

- planning: analyze-synthesize (estructurar plan)
- execution: analyze-investigate (recolectar evidencia), analyze-synthesize (sintetizar findings)
- closure: analyze-conclude (produce CONCLUSIONS.md modulado por modalidad)

### Refs HISTORY

- conclusion: docs/conclusiones/{val}.md (cuando se gradúa opt-in)

### Conteos resume

- evidence: EVIDENCE.md presente
- findings: FINDINGS.md presente
- conclusions: CONCLUSIONS.md presente
- queries: queries/*.sql count

## Sandbox read-only

Standalone: en plan mode describir modalidad, scope, paths sugeridos. No ejecutar queries ni leer BD.

Orchestrated: ver `agent-workflow:session` plan mode rules.
