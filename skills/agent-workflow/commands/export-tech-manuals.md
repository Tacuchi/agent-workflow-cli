---
description: Genera o refresca manuales técnicos del workspace en `docs/manuales/` consolidando sesiones + `docs/` (manuales, decisiones, especificaciones). Dos modos: `complementar` (default, sobrescribe `INDEX.md`) y `regenerar` (produce dossier `NNN-export-tech-manuals-YYYY-MM-DD/`). Audiencia: operadores/soporte/onboarding. Read-only.
argument-hint: (opcional) --since sessionNNN | --source <alias> | --mode complementar|regenerar | --temas slug1,slug2 | --dry-run
allowed-tools:
  [
    "Read",
    "Write",
    "Bash",
    "Grep",
    "Glob",
  ]
---

# Export Tech Manuals

Genera y mantiene manuales técnicos del workspace desde el corpus de sesiones + manuales graduados. Delega al skill `export-tech-manuals` (`agent-workflow/skills/export-tech-manuals/SKILL.md`).

El skill **nunca** ejecuta commits, merges, push, SQL ni envía correos. Solo produce:

- **Modo `complementar`** (default): `<docs>/manuales/INDEX.md` — índice consolidado re-generable.
- **Modo `regenerar`**: `<docs>/manuales/NNN-export-tech-manuals-YYYY-MM-DD/` — dossier con N manuales sintetizados + README.md.

Donde `<docs>` es:
- `Path.cwd() / docs` por default (project mode o hub workspace base).
- `<source.path>/docs` si se pasa `--source <alias>` en hub mode.

Tercer comando de la familia `/agent-workflow:export-*` definida en `docs/conclusiones/007-export-commands-family.md`.

## Excepción session-aware

Esta skill (junto con `release`, `release-scripts`, `export-report`, `export-arq`) requiere conocimiento del lifecycle pero las consume sólo via CLI `agent-workflow`. No lee paths hardcodeados.

**Audiencia**: operadores / soporte / nuevos miembros del equipo. Sin léxico ejecutivo — léxico técnico mínimo (similar a export-arq). Cada manual debe ser ejecutable por alguien que no participó en el desarrollo.

**Argumentos:** $ARGUMENTS

### Argumentos soportados

- `--since sessionNNN` — limita el corpus a sesiones posteriores.
- `--source <alias>` — en hub mode, limita a una sola fuente.
- `--mode complementar|regenerar` — default `complementar`.
- `--temas slug1,slug2` — override explícito de la detección heurística de temas.
- `--dry-run` — no escribir; reportar lo que se generaría.

Detección de temas y reglas en `skills/export-tech-manuals/SKILL.md` §"Detección de temas".

## Flujo

```
agent-workflow project-md-upsert --read           # workspace_mode, fuentes
agent-workflow history-data                       # sesiones cerradas
agent-workflow session-artifacts --code <CODE>    # OBJECTIVE + CHECKPOINT + MANUAL.md por sesión
agent-workflow next-number docs/manuales          # sólo modo regenerar
```

Luego renderiza:
- Modo `complementar`: `references/template-index.md` → sobrescribe `INDEX.md`.
- Modo `regenerar`: `references/template-manual.md` por cada tema → escribe dossier.

Valida V1-V6 (`references/validations.md`) antes de escribir.

## Plan mode

Reglas en `skills/session/references/sandbox-readonly-rules.md`. Describir en el plan file: modo + plantilla + manuales graduados detectados + temas no-graduados detectables + estructura del INDEX (o lista de archivos del dossier) + warnings esperados (V5/V6).

## Recursos

- `skills/export-tech-manuals/SKILL.md` v1.0.0 — orquestador.
- `skills/export-tech-manuals/references/template-index.md` — modo complementar.
- `skills/export-tech-manuals/references/template-manual.md` — modo regenerar.
- `skills/export-tech-manuals/references/lexico-tecnico.md` — noise vetado V2.
- `skills/export-tech-manuals/references/validations.md` — V1-V6 con reglas por modo.
- `docs/conclusiones/007-export-commands-family.md` — Propuesta familia `/agent-workflow:export-*`.
- `agent-workflow/skills/export-arq/SKILL.md` — hermano (arquitectura).
- `agent-workflow/skills/export-report/SKILL.md` — hermano (informe ejecutivo).
