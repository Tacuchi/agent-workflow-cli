---
description: Consolida N sesiones del workspace + `docs/planes/` ya graduados + `docs/decisiones/` / `docs/conclusiones/` para referencias en un plan ejecutable bajo `docs/planes/NNN-export-plan-YYYY-MM-DD.md`. Lee OBJECTIVE/TASKS/CONCLUSIONS de las sesiones fuente y deriva Resumen + Fases + Tasks (con dependencias) + Riesgos + Refs. Frontmatter YAML con state (draft/active/done/archived). Read-only. Sexto comando de la familia /agent-workflow:export-*.
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

# Export Plan

Consolida N sesiones (cerradas o activas con artefactos completos) en un plan ejecutable bajo `docs/planes/NNN-export-plan-YYYY-MM-DD.md`. Delega al skill `export-plan` (`agent-workflow/skills/export-plan/SKILL.md`).

El skill **nunca** ejecuta commits, merges, push, SQL ni envía correos. Solo produce:

- `<docs>/planes/NNN-<slug>-YYYY-MM-DD.md` — plan único MD con frontmatter YAML (`state: draft`).

Donde `<docs>` es:
- `Path.cwd() / docs` por default (project mode o hub workspace base).
- `<source.path>/docs` si se pasa `--source <alias>` en hub mode.

Sexto comando de la familia `/agent-workflow:export-*` definida en `docs/conclusiones/008-roadmap-export-plan-lifecycle.md` (F-A). Bundle plugin v2.10.0.

## Excepción session-aware

Este skill (junto con `release`, `release-scripts`, `export-scripts`, `export-report`, `export-arq`, `export-tech-manuals`) requiere conocimiento del lifecycle pero lo consume sólo vía CLI `agent-workflow`. No lee paths hardcodeados.

**Audiencia**: devs / PMs / leads. Términos técnicos del dominio (`OBJECTIVE`, `TASKS`, `flow`, `phase`, `NNN`, `hub`) autorizados.

**Argumentos:** $ARGUMENTS

### Argumentos soportados

- `--sessions NNN[,NNN]` — filtro discreto por código. Precede a `--since`.
- `--since sessionNNN` — incluye sólo sesiones posteriores a NNN (inclusive). Ignorado si `--sessions` presente.
- `--source <alias>` — en hub mode, limita a una fuente específica.
- `--slug <kebab>` — override del slug del filename (default: `export-plan`).
- `--dry-run` — reporte propositivo sin escribir el plan.

Sin args: incluye todas las sesiones cerradas + activas con artefactos completos.

Ejemplo: `/agent-workflow:export-plan --sessions 055,061 --slug runtime-evolution`.

## Flujo

Antes de generar, el skill llama al CLI `agent-workflow`:

```
agent-workflow release-data --include-graduated [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
agent-workflow session-artifacts --code <CODE>    # lazy read por sesión
agent-workflow next-number docs/planes            # numeración determinística
```

Luego sintetiza Resumen + Fases + Tasks + Dependencias + Riesgos + Refs siguiendo la plantilla `references/template-plan.md`. Estado inicial: `draft`. Transiciones futuras: ver `references/state-transitions.md`.

## Plan mode

Reglas generales en `skills/session/references/sandbox-readonly-rules.md`. Describir en el plan file: NNN resuelto + sesiones incluidas + sección por sección del plan generado + frontmatter YAML preview.

## Relación con `/agent-workflow:session --from-plan`

Cuando F-E.3 esté operativo (Sprint 4 del roadmap), `agent-workflow session-create --from-plan <NNN>` consumirá el plan generado por este comando y transicionará `state: draft → active`. Hoy: F-E.3 no está implementado todavía; el plan queda en `draft` hasta que el usuario inicie la sesión manualmente.

## Recursos

- `skills/export-plan/SKILL.md` v1.0.0 — orquestador del comando.
- `skills/export-plan/references/template-plan.md` — plantilla canónica del plan.
- `skills/export-plan/references/state-transitions.md` — árbol de decisión G3 + spec `AskUserQuestion plan-state`.
- `docs/conclusiones/008-roadmap-export-plan-lifecycle.md` — diseño F-A.
- Siblings: `commands/export-scripts.md`, `commands/export-arq.md`, `commands/export-tech-manuals.md`, `commands/export-report.md`.
