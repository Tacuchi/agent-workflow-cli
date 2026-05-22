---
description: Genera un informe ejecutivo (`.md`) consolidando el corpus de sesiones del workspace y `docs/`, dirigido a gerencia/jefatura/comité. Variante B default (≤760 palabras), A (400w compacto) y C (1620w extenso) derivadas vía `--audiencia`. Read-only.
argument-hint: (opcional) --since sessionNNN | --source <alias> | --period last-quarter|last-month|YYYY-MM..YYYY-MM | --audiencia gerencia|jefatura|comite | --mode resumen|analisis|draft | --dry-run
allowed-tools:
  [
    "Read",
    "Write",
    "Bash",
    "Grep",
    "Glob",
  ]
---

# Export Report

Genera un informe funcional ejecutivo `.md` agregando las sesiones cerradas del workspace **y la documentación graduada en `docs/`**, para gerencia / jefatura / comité de seguimiento. Delega al skill `export-report` (`agent-workflow/skills/export-report/SKILL.md`).

> Renombrado: `export-func` (session057) → `export-functional-specs` (session059) → `export-functional-report` (session060) → `export-report` (session081, **hard rename sin alias legacy** — DEC-003). El nombre corto "report" refleja que el deliverable es un informe ejecutivo, no una especificación técnica. v1.7 (session081) extiende el corpus a `docs/` además de sesiones (DEC-002).

El skill **nunca** ejecuta commits, merges, push, SQL ni envía correos. Solo produce:

- `<docs>/funcional/NNN-export-report-YYYY-MM-DD.md` — informe ejecutivo único.

Donde `<docs>` es:
- `Path.cwd() / docs` por default (project mode o hub workspace base).
- `<source.path>/docs` si se pasa `--source <alias>` en hub mode.

Primer comando de la familia `/agent-workflow:export-*` definida en `docs/conclusiones/007-export-commands-family.md`. Spec autoritativa del formato: `docs/especificaciones/001-export-report-format/DELIVERY.md`. Contrato de corpus canónico (sesiones + `docs/`): `agent-workflow/docs/shared-contract/export-corpus-sources.md`.

## Excepción session-aware

Esta skill, junto con `release` y `release-scripts`, requiere conocimiento del lifecycle pero las consume solo via CLI `agent-workflow`. No lee paths hardcodeados.

**Sesiones legacy** abortan con mensaje claro — migrar primero con `/agent-workflow:migrate --upgrade-topology`.

**Argumentos:** $ARGUMENTS

### Argumentos soportados

- `--since sessionNNN` — solo incluir sesiones posteriores a la indicada.
- `--source <alias>` — en hub mode, limitar el corpus a una sola fuente.
- `--period last-quarter|last-month|YYYY-MM..YYYY-MM` — ventana temporal del corpus.
- `--audiencia gerencia|jefatura|comite` — modula variante (gerencia → A, jefatura → B default, comite → C).
- `--mode resumen|analisis|draft` — modula variante (resumen → A, analisis → B default, draft → C).
- `--dry-run` — no escribir archivo; reportar lo que se generaría.

Matriz completa `audiencia × mode` y reglas de conflicto en `skills/export-report/SKILL.md` §"Entrada".

## Flujo

Antes de generar, el skill llama al CLI `agent-workflow`:

```
agent-workflow project-md-upsert --read           # workspace_mode, fuentes
agent-workflow history-data                       # lista de sesiones
agent-workflow session-artifacts --code <CODE>    # por sesión filtrada
agent-workflow objetivo-data --code <CODE>        # tipo, criterios, fuentes
agent-workflow decisiones-list --code <CODE>      # DEC-NNN
agent-workflow next-number docs/funcional         # numeración determinística
```

Luego renderiza la plantilla `references/template-<variante>.md` aplicando la tabla de traducción técnico→ejecutivo `references/lexico.md` y valida con V1-V6 (`references/validations.md`) antes de escribir.

## Plan mode

Reglas generales en `skills/session/references/sandbox-readonly-rules.md`. Describir en el plan file: variante resuelta + plantilla a cargar, sesiones del corpus tras filtros, subcarpetas de `docs/` que se consultarían, length estimada, secciones que aparecerían (incluyendo la condición de "Oportunidades de mejora" — V4), warnings esperados.

## Recursos

- `skills/export-report/SKILL.md` v1.7.0 — orquestador del comando.
- `skills/export-report/references/template-b.md` — plantilla default Variante B (760w).
- `skills/export-report/references/template-a.md` — plantilla compacta Variante A (400w).
- `skills/export-report/references/template-c.md` — plantilla extensa Variante C (1620w).
- `skills/export-report/references/lexico.md` — tabla técnico→ejecutivo + lista vetada V2.
- `skills/export-report/references/validations.md` — V1-V6 detalladas.
- `docs/especificaciones/001-export-report-format/DELIVERY.md` — spec autoritativa del formato.
- `docs/conclusiones/007-export-commands-family.md` — Propuesta original de la familia `/agent-workflow:export-*`.
- `docs/shared-contract/export-corpus-sources.md` — contrato canónico de corpus (sesiones + `docs/`).
