---
description: Consolida N sesiones del workspace + `docs/scripts/` ya graduados en un paquete de paso a producción bajo `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`. Genera manifest.md (informe + checklist + acciones manuales + git state + code-scan), por-sesion/ (bundle SQL organizado), por-tema/ (vista opt-in), rollback-global.sql y ORDER.md. Read-only. Refactor de /agent-workflow:release + /agent-workflow:release-scripts.
argument-hint: (opcional) --since sessionNNN | --source <alias> | --themes slug1,slug2|infer | --keep-parts | --skip-code-scan | --dry-run
allowed-tools:
  [
    "Read",
    "Write",
    "Bash",
    "Grep",
    "Glob",
  ]
---

# Export Scripts

Consolida N sesiones cerradas (más opcionalmente activas) en un paquete único de paso a producción. Delega al skill `export-scripts` (`agent-workflow/skills/export-scripts/SKILL.md`).

El skill **nunca** ejecuta commits, merges, push, SQL ni envía correos. Solo produce:

- `<docs>/scripts/NNN-export-scripts-YYYY-MM-DD/manifest.md` — informe consolidado (sesiones, acciones manuales, BD, hallazgos code-scan, git, checklist).
- `<docs>/scripts/NNN-export-scripts-YYYY-MM-DD/README.md` — índice + mapeo sesión↔tema↔scripts.
- `<docs>/scripts/NNN-export-scripts-YYYY-MM-DD/ORDER.md` — secuencia ejecutable.
- `<docs>/scripts/NNN-export-scripts-YYYY-MM-DD/rollback-global.sql` — rollback encadenado inverso.
- `<docs>/scripts/NNN-export-scripts-YYYY-MM-DD/por-sesion/` — bundle SQL por sesión (organizado 01→04).
- `<docs>/scripts/NNN-export-scripts-YYYY-MM-DD/por-tema/` — bundle consolidado por tema (opt-in).

Donde `<docs>` es:
- `Path.cwd() / docs` por default (project mode o hub workspace base).
- `<source.path>/docs` si se pasa `--source <alias>` en hub mode.

Último comando de la familia `/agent-workflow:export-*` definida en `docs/conclusiones/007-export-commands-family.md`. Refactor que consolida `/agent-workflow:release` v2.0.0 + `/agent-workflow:release-scripts` v2.0.0.

## Excepción session-aware

Este skill (junto con `release`, `release-scripts`, `export-report`, `export-arq`, `export-tech-manuals`) requiere conocimiento del lifecycle pero lo consume solo vía CLI `agent-workflow`. No lee paths hardcodeados.

**Audiencia**: devs / DBAs / release managers. Términos técnicos del dominio (NNN, DDL, DML, rollback, hub, branch) autorizados.

**Argumentos:** $ARGUMENTS

### Argumentos soportados

- `--since sessionNNN` — incluye sólo sesiones posteriores a NNN (inclusive).
- `--source <alias>` — en hub mode, limita a una fuente específica.
- `--themes slug1,slug2` — genera `por-tema/` con los slugs declarados.
- `--themes infer` — inferencia LLM de temas (mismo flujo que release-scripts legacy).
- `--keep-parts` — preserva `por-tema/<slug>/parts/<categoria>/*.sql`.
- `--skip-code-scan` — omite el escaneo de código fuente.
- `--dry-run` — reporte propositivo sin escribir archivos.

Sin args: incluye todas las sesiones cerradas, sin vista `por-tema/`, escanea todo el código.

## Flujo

Antes de generar, el skill llama al CLI `agent-workflow`:

```
agent-workflow release-data --include-graduated [--since sessionNNN] [--source <alias>]
agent-workflow code-scan                          # con built-in patterns + override
agent-workflow next-number docs/scripts           # numeración determinística
agent-workflow session-artifacts --code <CODE>    # lazy read de OBJECTIVE/TASKS/DECISIONS/scripts
```

Luego delega a `sql-script-organizer` (clasificación 01→04 cross-session) y `sql-rollback-generator` (rollback acoplado + global). Si hay temas declarados o `--themes infer`: aplica algoritmo de consolidación por tema (port adaptado de release-scripts legacy).

Valida V1-V6 (`references/validations.md`) antes de escribir el bundle al filesystem.

## Plan mode

Reglas generales en `skills/session/references/sandbox-readonly-rules.md`. Describir en el plan file: NNN resuelto + sesiones incluidas + scripts por sesión, vista `por-tema/` activación (lectura de `## Temas` o flag), hallazgos esperados del code-scan, acciones manuales detectadas, advertencias bloqueantes (sesiones abiertas, rollback ausente, irreversibles).

## Relación con `/agent-workflow:release` y `/agent-workflow:release-scripts`

Este comando los reemplaza. Plan de deprecación Fase 1 (plugin v2.8.0):
- Ambos legacy siguen funcionando sin cambios.
- Banner deprecation visible al cargar SKILL.md y commands/*.md de cada uno.
- Workspaces que ya invocaron `release` mantienen `docs/release/` como histórico.

Detalle del plan: `skills/export-scripts/references/deprecation-plan.md`.

## Recursos

- `skills/export-scripts/SKILL.md` v1.0.0 — orquestador del comando.
- `skills/export-scripts/references/manifest-template.md` — plantilla canónica del informe consolidado.
- `skills/export-scripts/references/readme-template.md` — plantilla del README del bundle.
- `skills/export-scripts/references/lexico-tecnico.md` — léxico vetado V2.
- `skills/export-scripts/references/validations.md` — V1-V6 detalladas.
- `skills/export-scripts/references/code-scan-recommendations.md` — catálogo extendido de patrones.
- `skills/export-scripts/references/theme-handling.md` — algoritmo de detección/consolidación por tema.
- `skills/export-scripts/references/deprecation-plan.md` — plan de fases 1-2.
- `docs/conclusiones/007-export-commands-family.md` — Propuesta original de la familia `/agent-workflow:export-*`.
- `agent-workflow/skills/release/SKILL.md`, `release-scripts/SKILL.md` — legacy en deprecation Fase 1.
