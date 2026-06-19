# Objective — session003-analyze-harness-flow-analysis

## Modality
technical

## Question
Analizar el flujo total de la herramienta/harnes @tacuchi/agent-workflow-cli y su ecosistema. Documentar cada flujo posible: lifecycle de 4 fases (planning->execution->validation->closure); flows core/dev/design/analyze; las 11 familias de comandos del CLI (43 subcomandos); catalogo de skills (session, patch, doctor, compact, resume, rules, hub-init, project-init, migrate, export-*). Por cada flujo: artefactos producidos/consumidos, pasos, modos (project/hub, lite, plan-mode) y puntos de graduacion. Entregable: reporte tecnico comprensivo en docs/ con diagramas Mermaid (flowcharts, sequence, state) de todos los workflows. Trabajo directo en main.

## Context
- Sujeto: el repo `agent-workflow-cli` (CLI v11.0.1) + su SKILL universal bundleada (`skills/agent-workflow/`, SKILL v1.2.0) + el plugin wrapper (`.claude-plugin/plugin.json` v7.0.1). El harness está consolidado dentro de la SKILL bundleada (desde v2.0.0 los flows no son repos separados).
- Fuera de alcance: los repos hermanos (`core/developer/design/analyze-workflow-plugin`, `agent-workflow-manager`) como bases de código independientes — se mencionan solo como forma de distribución/legado.
- Restricciones: análisis read-only salvo el entregable en `docs/`; diagramas en Mermaid; trabajo directo en `main`; reconciliar con `MANUAL-TECNICO.md` / `MANUAL-FUNCIONAL.md` existentes.

## Success criteria
- [x] Lifecycle de 4 fases con diagrama de estados (loop planning↔execution, modo lite, closure).
- [x] Los 4 flows (core/dev/design/analyze) y su composición de especialidades por fase.
- [x] Catálogo de comandos del CLI con rol en el flujo (mutate vs read-only).
- [x] Catálogo de slash-commands/skills (session, patch, doctor, compact, resume, rules, hub-init, project-init, migrate, 9× export-*).
- [x] Modelo de artefactos + modelo de graduación (6 kinds + export-*).
- [x] Modos project/hub, plan-mode sandbox, hooks (branch-check, sql-mutation-guard).
- [x] Diagramas Mermaid: state (lifecycle), flowcharts (intent/create/closure/graduación), sequence (sesión dev end-to-end), arquitectura hexagonal.
- [x] Reporte en `docs/agent-workflow-flujos.md`; reconciliado con manuales (§13 Hallazgos).
