# exports/

Familia `/agent-workflow:export-*`: consolida N sesiones cerradas en un artefacto final bajo `docs/<carpeta>/`.

Contenido esperado (T2 PR2):

- `export-plan.md` — plan ejecutable a `docs/planes/`.
- `export-conclusions.md` — conclusiones a `docs/conclusiones/`.
- `export-functional-report.md` — reporte funcional a `docs/funcionales/`.
- `export-arq.md` — arquitectura a `docs/arquitectura/`.
- `export-tech-manuals.md` — manuales técnicos a `docs/manuales/`.
- `export-scripts.md` — scripts SQL consolidados a `docs/scripts/`.
- `export-diagrams.md` — diagramas mermaid a `docs/diagramas/`.

Todos session-aware: leen lifecycle vía CLI `agent-workflow release-data` + `session-artifacts`, nunca paths hard-coded.
