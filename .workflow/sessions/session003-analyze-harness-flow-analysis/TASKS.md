# Tasks — session003-analyze-harness-flow-analysis

> Plan analyze/technical. Entregable: reporte técnico en `docs/` con diagramas Mermaid.
> Scope confirmado: **referencia comprensiva** (lifecycle + 4 flows + 11 familias/43 cmds + catálogo de skills).

## Phase 1 — Exploración (gather)
- [x] T1.1 — Leer el spine de doctrina (session SKILL, lifecycle-deep, graduacion-routing, specialty-decision-tree, 3 workflows, 2 manuales).
- [x] T1.2 — Mapear arquitectura del CLI (src/ hexagonal: domain/ports/adapters/application, CliContext, runtime, dispatch). [agente]
- [x] T1.3 — Catalogar las 11 familias / 43 subcomandos con rol en el flujo (mutate vs read-only). [agente] → 48 registrados / 43 archivos.
- [x] T1.4 — Catalogar graduación (6 kinds) + familia export-* (9) + standards SQL. [agente] → 6 active + 3 stubs.
- [x] T1.5 — Catalogar hooks + modos (project/hub) + 17 slash-commands + doctrina restante. [agente]

## Phase 2 — Síntesis (write)
- [x] T2.1 — Definir estructura del reporte (índice navegable, secciones).
- [x] T2.2 — Redactar secciones: overview, arquitectura, lifecycle, flows, artefactos, graduación, modos, hooks, catálogos.
- [x] T2.3 — Producir diagramas Mermaid (19 diagramas: state lifecycle, flowcharts intent/create/closure/graduación, sequence end-to-end, arquitectura).

## Phase 3 — Validación
- [x] T3.1 — Verificar criterios de aceptación, validar sintaxis Mermaid (19 bloques, balance OK), reconciliar con MANUAL-TECNICO/FUNCIONAL (§13 Hallazgos).

## Entregables
- `docs/agent-workflow-flujos.md` — reporte técnico comprensivo con 19 diagramas Mermaid.
- `docs/guia-artefactos.md` — guía de **todos** los artefactos de sesión (mapa + planning + transversales + por flow): estructura, semántica, ejemplos.
