# commands/

Slash commands `/agent-workflow:*` registrables por el host (Claude Code, Codex, Warp, OZ).

Contenido esperado (T2 PR2):

- `session.md` — entry point unificado: create / resume / close / list.
- `resume.md` — atajo a session resume.
- `export-plan.md` … `export-diagrams.md` — 7 comandos export-*.
- `rules.md` — carga doctrine/* on-demand.
- `migrate.md` — migración inter-empresa via `profile.migrate_legacy_rules[]`.
- `doctor.md` — diagnóstico end-to-end.
- `project-init.md` / `hub-init.md` — inicializadores de workspace.

Naming final: `/agent-workflow:<comando>` (decidido en D1 session082). Los aliases legacy de empresas existentes (e.g., `/qtc:*` en el caso de QTC) viven en el plugin hijo de la empresa correspondiente bajo `legacy-aliases/` por 2 sprints después del cutover (T5 del plan migración).

Estado post-T2 (PR2): 17 commands migrados con prefijo `agent-workflow-` y todas las refs `/qtc:` reescritas a `/agent-workflow:`. Lista actual:

- `agent-workflow-session.md`, `agent-workflow-compact.md`, `agent-workflow-resume.md`
- `agent-workflow-export-plan.md`, `agent-workflow-export-scripts.md`, `agent-workflow-export-conclusions.md`
- `agent-workflow-export-report.md`, `agent-workflow-export-arq.md`, `agent-workflow-export-tech-manuals.md`
- `agent-workflow-export-qa-note.md`, `agent-workflow-export-requirement.md`, `agent-workflow-export-tech-note.md`
- `agent-workflow-project-init.md`, `agent-workflow-hub-init.md`, `agent-workflow-doctor.md`
- `agent-workflow-migrate.md`, `agent-workflow-rules.md`
