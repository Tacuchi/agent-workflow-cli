---
description: Consolida N sesiones del workspace + `docs/scripts/` ya graduados en un paquete de paso a producción bajo `docs/scripts/NNN-export-scripts-YYYY-MM-DD/` (v4.0.0 — session093). Layout plano cross-session al root del bundle: 00-ROLLBACK.sql + 01-DDL-TABLES.sql + 02-DDL-FUNCTIONS.sql + 03-DML.sql + 04-INSERTS.sql + README.md único. Sin por-sesion/, sin companions .rollback.sql, sin per-sesión rollback. `--themes` opt-in genera por-tema/ como capa adicional. Read-only. Reemplaza /agent-workflow:release + /agent-workflow:release-scripts (deprecation Fase 1).
argument-hint: (opcional) --sessions NNN[,NNN] | --since sessionNNN | --source <alias> | --themes slug1,slug2|infer | --keep-parts | --skip-code-scan | --dry-run
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

El skill **nunca** ejecuta commits, merges, push, SQL ni envía correos. Layout v4.0.0 del bundle (cross-session al root):

```
<docs>/scripts/NNN-export-scripts-YYYY-MM-DD/
├── 00-ROLLBACK.sql              # único rollback cross-session (encadenado 04→01)
├── 01-DDL-TABLES.sql            # CREATE/ALTER TABLE cross-session (skip si vacío)
├── 02-DDL-FUNCTIONS.sql         # CREATE OR REPLACE FUNCTION cross-session (skip si vacío)
├── 03-DML.sql                   # UPDATE/DELETE/migración cross-session (skip si vacío)
├── 04-INSERTS.sql               # INSERT/seed cross-session (skip si vacío)
├── README.md                    # único informe + índice + how-to-execute
├── _queries/                    # opcional: queries de soporte por sesión
│   └── sessionXXX/...
└── por-tema/                    # opt-in (capa adicional encima del root plano)
    ├── tema-<slug>/
    │   ├── 01-DDL-TABLES.sql
    │   ├── 02-DDL-FUNCTIONS.sql
    │   ├── 03-DML.sql
    │   ├── 04-INSERTS.sql
    │   └── parts/               # si --keep-parts
    └── tema-<otro>/...
```

Donde `<docs>` es:
- `Path.cwd() / docs` por default (project mode o hub workspace base).
- `<source.path>/docs` si se pasa `--source <alias>` en hub mode.

**No se generan** (eliminados desde v4.0.0): `manifest.md` separado, `ORDER.md`, `rollback-global.sql`, `por-sesion/`, `<file>.rollback.sql` companions, `<session>/rollback/`. El histórico v3.x (`docs/scripts/001-002-003-*` ya generados) queda como histórico — no se migra.

Último comando de la familia `/agent-workflow:export-*` definida en `docs/conclusiones/007-export-commands-family.md`. Refactor que consolida `/agent-workflow:release` v2.0.0 + `/agent-workflow:release-scripts` v2.0.0.

## Excepción session-aware

Este skill (junto con `release`, `release-scripts`, `export-report`, `export-arq`, `export-tech-manuals`) requiere conocimiento del lifecycle pero lo consume solo vía CLI `agent-workflow`. No lee paths hardcodeados.

**Audiencia**: devs / DBAs / release managers. Términos técnicos del dominio (NNN, DDL, DML, rollback, hub, branch) autorizados.

**Argumentos:** $ARGUMENTS

### Argumentos soportados

- `--sessions NNN[,NNN]` — filtro discreto por código. Toma precedencia sobre `--since` (warning si ambos).
- `--since sessionNNN` — incluye sólo sesiones posteriores a NNN (inclusive). Ignorado si `--sessions` presente.
- `--source <alias>` — en hub mode, limita a una fuente específica.
- `--themes slug1,slug2` — genera `por-tema/<slug>/` (capa adicional encima del root plano).
- `--themes infer` — inferencia LLM de temas (mismo flujo que release-scripts legacy).
- `--keep-parts` — preserva `por-tema/<slug>/parts/<categoria>/*.sql`.
- `--skip-code-scan` — omite el escaneo de código fuente.
- `--dry-run` — reporte propositivo sin escribir archivos.

Sin args: incluye todas las sesiones cerradas, sin capa `por-tema/`, escanea todo el código.

## Flujo

Antes de generar, el skill llama al CLI `agent-workflow`:

```
agent-workflow release-data --include-graduated [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
agent-workflow code-scan                          # con built-in patterns + override
agent-workflow next-number docs/scripts           # numeración determinística
agent-workflow session-artifacts --code <CODE>    # lazy read de OBJECTIVE/TASKS/DECISIONS/scripts
```

Luego consolida cross-session por categoría al root del bundle (`01-DDL-TABLES.sql`, `02-DDL-FUNCTIONS.sql`, `03-DML.sql`, `04-INSERTS.sql`) y delega a `sql-rollback-generator` v2.0.0+ para generar el `00-ROLLBACK.sql` único. Si `--themes` declarado o inferido: agrega capa `por-tema/<slug>/` sin duplicar rollback.

Valida V1-V6 (`references/validations.md`) antes de escribir el bundle al filesystem.

## Plan mode

Reglas generales en `skills/session/references/sandbox-readonly-rules.md`. Describir en el plan file: NNN resuelto + sesiones incluidas + sentencias cross-session por categoría, capa `por-tema/` (activación + slugs), hallazgos esperados del code-scan, acciones manuales detectadas, advertencias bloqueantes (sesiones abiertas, rollback ausente, irreversibles).

## Relación con `/agent-workflow:release` y `/agent-workflow:release-scripts`

Este comando los reemplaza. Plan de deprecación Fase 1 (plugin v2.8.0):
- Ambos legacy siguen funcionando sin cambios.
- Banner deprecation visible al cargar SKILL.md y commands/*.md de cada uno.
- Workspaces que ya invocaron `release` mantienen `docs/release/` como histórico.

Detalle del plan: `skills/export-scripts/references/deprecation-plan.md`.

## Recursos

- `skills/export-scripts/SKILL.md` v4.0.0 — orquestador del comando (layout plano cross-session).
- `skills/export-scripts/references/readme-template.md` — plantilla canónica del README único.
- `skills/export-scripts/references/manifest-template.md` — **DEPRECATED** desde v4.0.0 (histórico).
- `skills/export-scripts/references/lexico-tecnico.md` — léxico vetado V2.
- `skills/export-scripts/references/validations.md` — V1-V6 detalladas (anti-redundancia v4.0.0).
- `skills/export-scripts/references/code-scan-recommendations.md` — catálogo extendido de patrones.
- `skills/export-scripts/references/theme-handling.md` — algoritmo de detección/consolidación por tema.
- `skills/export-scripts/references/deprecation-plan.md` — plan de fases 1-2.
- `skills/sql-rollback-generator/SKILL.md` v2.0.0 — `00-ROLLBACK.sql` único cross-session.
- `docs/conclusiones/007-export-commands-family.md` — Propuesta original de la familia `/agent-workflow:export-*`.
- `agent-workflow/skills/release/SKILL.md`, `release-scripts/SKILL.md` — legacy en deprecation Fase 1.
