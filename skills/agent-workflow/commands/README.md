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

Estado post-v7.0.1 (T7 hotfix): 17 commands con nombre canónico sin prefijo (el namespace del plugin "agent-workflow" lo provee). Invocación: `/agent-workflow:<filename>` (ej. `/agent-workflow:session`). Lista actual:

- `session.md`, `compact.md`, `resume.md`
- `export-plan.md`, `export-scripts.md`, `export-conclusions.md`
- `export-report.md`, `export-arq.md`, `export-tech-manuals.md`
- `export-qa-note.md`, `export-requirement.md`, `export-tech-note.md`
- `project-init.md`, `hub-init.md`, `doctor.md`
- `migrate.md`, `rules.md`

**Distribución como slash commands**: el repo `agent-workflow-cli` expone `.claude-plugin/plugin.json` en la raíz declarando este directorio como `commands` slot. El plugin se publica via `qtc-plugins-marketplace` (entry `agent-workflow`). `self install --target <host>` instala el SKILL pero NO registra los slash commands — el plugin debe instalarse por separado via `/plugin install agent-workflow@<marketplace>`.
