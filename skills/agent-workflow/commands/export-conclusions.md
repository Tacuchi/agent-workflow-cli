---
description: Consolida N sesiones del workspace (con CONCLUSIONS.md presente) + `docs/conclusiones/` ya graduadas en un documento curado bajo `docs/conclusiones/NNN-export-conclusions-YYYY-MM-DD.md`. Sintetiza Resumen ejecutivo + C-items por sesión + R-items deduplicados cross-session + Roadmap derivado opcional. Aplica dedup por slug + cross-slug similarity opcional + conflict resolution. Complementa graduate --kind conclusion (single-session). Read-only. Séptimo comando de la familia /agent-workflow:export-*.
argument-hint: (opcional) --sessions NNN[,NNN] | --since sessionNNN | --source <alias> | --slug <kebab> | --dry-run
allowed-tools:
  [
    "Read",
    "Write",
    "Bash",
    "Grep",
    "Glob",
  ]
---

# Export Conclusions

Consolida N sesiones que tengan `CONCLUSIONS.md` presente en un documento curado bajo `docs/conclusiones/NNN-export-conclusions-YYYY-MM-DD.md`. Delega al skill `export-conclusions` (`agent-workflow/skills/export-conclusions/SKILL.md`).

El skill **nunca** ejecuta commits, merges, push, SQL ni envía correos. Solo produce:

- `<docs>/conclusiones/NNN-<slug>-YYYY-MM-DD.md` — documento único MD con Resumen ejecutivo + Sesiones consolidadas + C-items por sesión + R-items deduplicados + Roadmap derivado opcional + Refs.

Donde `<docs>` es:
- `Path.cwd() / docs` por default (project mode o hub workspace base).
- `<source.path>/docs` si se pasa `--source <alias>` en hub mode.

Séptimo comando de la familia `/agent-workflow:export-*` definida en `docs/conclusiones/008-roadmap-export-plan-lifecycle.md` (F-B). Bundle plugin v2.10.0 junto con `/agent-workflow:export-plan` (F-A).

## Excepción session-aware

Este skill requiere conocimiento del lifecycle pero lo consume sólo vía CLI `agent-workflow`. No lee paths hardcodeados.

**Audiencia**: PMs / leads / arquitectos. Términos del dominio (`CONCLUSIONS`, `R-items`, `roadmap`, `dedup`, `NNN`, `hub`) autorizados.

**Argumentos:** $ARGUMENTS

### Argumentos soportados

- `--sessions NNN[,NNN]` — filtro discreto por código. Precede a `--since`.
- `--since sessionNNN` — incluye sólo sesiones posteriores a NNN (inclusive). Ignorado si `--sessions` presente.
- `--source <alias>` — en hub mode, limita a una fuente específica.
- `--slug <kebab>` — override del slug del filename (default: `export-conclusions`).
- `--dry-run` — reporte propositivo sin escribir.

Sin args: incluye todas las sesiones del workspace con `CONCLUSIONS.md` presente.

Ejemplo: `/agent-workflow:export-conclusions --sessions 049,051,062 --slug runtime-evolution-roadmap`.

## Flujo

Antes de generar, el skill llama al CLI `agent-workflow`:

```
agent-workflow release-data --include-graduated [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
agent-workflow session-artifacts --code <CODE>    # verificar CONCLUSIONS.md presence
agent-workflow next-number docs/conclusiones      # numeración (coexiste con graduate)
```

Filtra el corpus descartando sesiones sin `CONCLUSIONS.md`. Si el filtro queda vacío → abortar con mensaje claro.

Luego aplica el algoritmo de dedup (`references/dedup-rules.md`) sobre R-items y sintetiza Roadmap derivado si hay ≥3 R-items consolidados.

## Plan mode

Reglas generales en `skills/session/references/sandbox-readonly-rules.md`. Describir en el plan file: NNN resuelto + sesiones del corpus (post-filtro) + R-items consolidados esperados + conflicts detectados + estructura final del MD.

## Relación con `graduate --kind conclusion`

`graduate --kind conclusion --session NNN` sigue siendo el path canónico para **promover una sesión single al canon** (copia `CONCLUSIONS.md` tal cual a `docs/conclusiones/NNN-<slug>.md`).

`export-conclusions` es **complementario**: aplica cuando hay valor en consolidación cross-session (dedup + roadmap + trazabilidad multi-origen). Coexisten bajo el mismo counter `next-number docs/conclusiones`.

## Recursos

- `skills/export-conclusions/SKILL.md` v1.0.0 — orquestador del comando.
- `skills/export-conclusions/references/template-conclusions.md` — plantilla canónica + ejemplo single-session.
- `skills/export-conclusions/references/dedup-rules.md` — algoritmo de dedup R-NNN + casos edge.
- `docs/conclusiones/008-roadmap-export-plan-lifecycle.md` — diseño F-B.
- Siblings: `commands/export-plan.md` (F-A), `commands/export-scripts.md`, `commands/export-arq.md`, `commands/export-tech-manuals.md`, `commands/export-report.md`.
