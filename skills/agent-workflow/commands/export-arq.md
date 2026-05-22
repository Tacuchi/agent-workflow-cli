---
description: Genera documentación técnica de arquitectura (`.md` con diagramas C4 embebidos) consolidando sesiones del workspace + `docs/` (arq, especificaciones, decisiones): contexto, contenedores, componentes, integraciones, modelo de datos (si MCP), decisiones arquitectónicas y riesgos. Structurizr default; Mermaid y PlantUML opt-in. Read-only.
argument-hint: (opcional) --since sessionNNN | --source <alias> | --diagrams mermaid|structurizr|plantuml | --scope c4|integraciones|datos|decisiones|riesgos|todo | --dry-run
allowed-tools:
  [
    "Read",
    "Write",
    "Bash",
    "Grep",
    "Glob",
  ]
---

# Export Arq

Genera documentación técnica de arquitectura del workspace agregando fuentes declaradas + corpus de sesiones + MCP read-only cuando aplique. Delega al skill `export-arq` (`agent-workflow/skills/export-arq/SKILL.md`).

El skill **nunca** ejecuta commits, merges, push, SQL ni envía correos. Solo produce:

- `<docs>/arquitectura/NNN-export-arq-YYYY-MM-DD/arquitectura.md` — documento principal con Mermaid embebido.
- `<docs>/arquitectura/NNN-export-arq-YYYY-MM-DD/workspace.dsl` — opcional (`--diagrams structurizr`).
- `<docs>/arquitectura/NNN-export-arq-YYYY-MM-DD/arquitectura.puml` — opcional (`--diagrams plantuml`).
- `<docs>/arquitectura/NNN-export-arq-YYYY-MM-DD/README.md` — índice del dossier.

Donde `<docs>` es:
- `Path.cwd() / docs` por default (project mode o hub workspace base).
- `<source.path>/docs` si se pasa `--source <alias>` en hub mode.

Segundo comando de la familia `/agent-workflow:export-*` definida en `docs/conclusiones/007-export-commands-family.md`.

## Excepción session-aware

Esta skill (junto con `release`, `release-scripts`, `export-func`) requiere conocimiento del lifecycle pero las consume solo via CLI `agent-workflow`. No lee paths hardcodeados.

**Audiencia**: devs/arquitectos. Sin léxico ejecutivo (a diferencia de `/agent-workflow:export-func`). Términos técnicos del dominio (propuesta, MCP, C4, hook, skill) están autorizados.

**Argumentos:** $ARGUMENTS

### Argumentos soportados

- `--since sessionNNN` — filtra **sólo** la sección "Decisiones arquitectónicas". El snapshot del sistema vigente no se filtra.
- `--source <alias>` — en hub mode, limita el output a una sola fuente y sus integraciones internas.
- `--diagrams mermaid|structurizr|plantuml` — motor del render de C4 (default: `mermaid`).
- `--scope c4|integraciones|datos|decisiones|riesgos|todo` — qué secciones aparecen (default: `todo`).
- `--dry-run` — no escribir; reportar lo que se generaría.

Matriz completa y reglas en `skills/export-arq/SKILL.md` §"Entrada".

## Flujo

Antes de generar, el skill llama al CLI `agent-workflow`:

```
agent-workflow project-md-upsert --read           # workspace_mode, fuentes, integraciones declaradas
agent-workflow history-data                       # sesiones cerradas
agent-workflow decisiones-list --code <CODE>      # DEC-NNN cronológicas
agent-workflow next-number docs/arquitectura      # numeración determinística
```

Si `--scope` incluye `datos` y MCP `<mcp-cert>`/`<mcp-prod>` está configurado: consulta esquemas BD (`SELECT count(*)`, `\d`, `EXPLAIN`) respetando cost guard. Si MCP no disponible: sección "Modelo de datos" aparece con nota inline explícita (Patrón B de V4.a).

Luego renderiza `references/template-c4.md` aplicando léxico técnico mínimo + Mermaid C4 embebido (o Structurizr/PlantUML opt-in). Valida V1-V6 (`references/validations.md`) antes de escribir.

## Plan mode

Reglas generales en `skills/session/references/sandbox-readonly-rules.md`. Describir en el plan file: variante de diagrama + scope resuelto, fuentes a inspeccionar + integraciones declaradas, MCP queries propuestas (si `--scope datos`), hallazgos de V4 (Modelo de datos presente/omitido por MCP, Decisiones presente/omitido por count), warnings esperados (V5/V6).

## Recursos

- `skills/export-arq/SKILL.md` v1.0.0 — orquestador del comando.
- `skills/export-arq/references/template-c4.md` — plantilla canónica (Mermaid).
- `skills/export-arq/references/template-structurizr.dsl` — variante DSL opt-in.
- `skills/export-arq/references/template-plantuml.puml` — variante PUML opt-in.
- `skills/export-arq/references/lexico-tecnico.md` — léxico técnico mínimo + lista vetada V2.
- `skills/export-arq/references/validations.md` — V1-V6 detalladas (3 patrones de V4.a).
- `docs/conclusiones/007-export-commands-family.md` — Propuesta original de la familia `/agent-workflow:export-*`.
- `agent-workflow/skills/export-func/SKILL.md` — hermano (informe ejecutivo).
