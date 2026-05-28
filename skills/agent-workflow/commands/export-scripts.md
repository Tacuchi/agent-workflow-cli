---
description: Consolida los SQL pendientes del workspace en un único paquete `docs/scripts/NNN-export-scripts-YYYY-MM-DD/` con numeración continua tras `00-ROLLBACK.sql` (v5.0.0 — session103). Lee sesiones (`.workflow/sessions/<folder>/SCRIPTS.sql`) Y archivos standalone (`docs/scripts/*.sql`, excluyendo bundles previos). Headers SQL mínimos + README simple (3 secciones). Rollback derivado de los forwards al final. Read-only.
argument-hint: (opcional) --sessions NNN[,NNN] | --since sessionNNN | --source <alias> | --skip-standalone | --dry-run
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

Consolida los SQL pendientes del workspace en un único bundle de paso a producción. Delega al skill `export-scripts` (`agent-workflow/skills/export-scripts/SKILL.md`).

El skill **nunca** ejecuta commits, merges, push, SQL ni envía correos. Layout v5.0.0 del bundle (numeración continua tras `00-ROLLBACK.sql`):

```
<docs>/scripts/NNN-export-scripts-YYYY-MM-DD/
├── 00-ROLLBACK.sql              # único rollback (orden inverso de los forwards)
├── 01-<CATEGORIA>.sql           # primera categoría con contenido
├── 02-<CATEGORIA>.sql           # segunda categoría con contenido (si aplica)
├── ...                          # numeración continua, sin gaps
└── README.md                    # índice + cómo aplicar + cómo revertir
```

Categorías canónicas (orden de asignación de número): `DDL-TABLES`, `DDL-FUNCTIONS`, `DML`, `INSERTS`. Las categorías vacías no ocupan número.

Donde `<docs>` es:
- `Path.cwd() / docs` por default (project mode o hub workspace base).
- `<source.path>/docs` si se pasa `--source <alias>` en hub mode.

**Fuentes del corpus** (Paso 1 del skill):

1. `.workflow/sessions/<folder>/SCRIPTS.sql` de cada sesión del corpus.
2. `docs/scripts/*.sql` standalone (top-level), **excluyendo** cualquier `docs/scripts/NNN-export-scripts-*/` (bundles previos del skill).

**Audiencia**: devs / DBAs / release managers. Términos técnicos del dominio (DDL, DML, rollback, hub) autorizados.

**Argumentos:** $ARGUMENTS

### Argumentos soportados

- `--sessions NNN[,NNN]` — filtro discreto por código. Toma precedencia sobre `--since`.
- `--since sessionNNN` — incluye sólo sesiones posteriores a NNN (inclusive).
- `--source <alias>` — en hub mode, limita a una fuente específica.
- `--skip-standalone` — omite la lectura de `docs/scripts/*.sql` standalone.
- `--dry-run` — reporte propositivo sin escribir archivos.

Sin args: incluye todas las sesiones cerradas + todos los `.sql` standalone de `docs/scripts/`.

## Flujo

```
agent-workflow release-data [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
agent-workflow next-number docs/scripts
```

El skill:

1. Recolecta SQL desde las 2 fuentes.
2. Clasifica por categoría canónica (DDL-TABLES / DDL-FUNCTIONS / DML / INSERTS).
3. Asigna numeración continua tras `00-ROLLBACK.sql` (sin gaps).
4. Escribe los forwards.
5. Delega a `sql-rollback-generator` v3.0.0+ para generar `00-ROLLBACK.sql` **leyendo los forwards ya escritos**.
6. Escribe `README.md` minimal (3 secciones: Archivos, Aplicar, Revertir).
7. Valida V1-V2 (`references/validations.md`) y reporta.

## Plan mode

Reglas generales en `skills/session/references/sandbox-readonly-rules.md`. Describir en el plan file: NNN resuelto + fuentes detectadas + sentencias por categoría + numeración final + tamaño aproximado del README.

## Recursos

- `skills/export-scripts/SKILL.md` v5.0.0 — orquestador del comando.
- `skills/export-scripts/references/readme-template.md` — plantilla del README minimal.
- `skills/export-scripts/references/validations.md` — V1-V2.
- `skills/export-scripts/references/lexico-tecnico.md` — placeholders vetados (V2).
- `skills/sql-rollback-generator/SKILL.md` v3.0.0 — derivado de forwards.
- `docs/conclusiones/007-export-commands-family.md` — Propuesta original de la familia `/agent-workflow:export-*`.
