---
name: export-scripts
description: "Consolida los SQL pendientes del workspace en un único paquete `docs/scripts/NNN-export-scripts-YYYY-MM-DD/` con numeración continua: `00-ROLLBACK.sql` + `01-…`, `02-…`, etc. en orden ascendente. Lee SQL desde dos fuentes: `.workflow/sessions/<folder>/SCRIPTS.sql` de cada sesión Y archivos `docs/scripts/*.sql` standalone (excluyendo bundles previos `docs/scripts/NNN-export-scripts-*/`). Headers SQL mínimos (1 línea), README minimal (solo índice + cómo aplicar + cómo revertir). Genera `00-ROLLBACK.sql` AL FINAL leyendo los forwards consolidados. Read-only/reporte — no ejecuta SQL ni commits. Invocado vía `/agent-workflow:export-scripts`."
version: 5.0.0
---

# Export Scripts — Bundle SQL consolidado, simple y directo

Consolida SQL pendientes de N sesiones + archivos standalone en un único bundle `docs/scripts/NNN-export-scripts-YYYY-MM-DD/` con numeración continua tras `00-ROLLBACK.sql`. Solo lectura/reporte: el usuario aplica los scripts manualmente.

> v5.0.0 (session103) — simplificación radical del v4.0.0: numeración continua, headers SQL de 1 línea, README minimal (3 secciones), búsqueda extendida a `docs/scripts/*.sql` standalone, rollback derivado de forwards.

## Excepción session-aware

Requiere conocimiento del lifecycle. **No crea ni modifica sesiones**. Si el workspace no tiene SQL pendientes (ni en sesiones cerradas ni en `docs/scripts/`) → abortar.

**Consumo de CLI `agent-workflow`** (no leer paths hardcodeados):

- `agent-workflow release-data [--since sessionNNN] [--source alias] [--include-graduated]` — dump consolidado de sesiones.
- `agent-workflow session-artifacts --code <NNN>` — lectura lazy de artefactos por sesión.
- `agent-workflow next-number docs/scripts` — numeración determinística del output dir.
- Resolución hub-aware de `docs/scripts/` la maneja el CLI internamente.

## When to use

- "Bundle SQL del release", "preparar paso a prod", "consolidar SQLs pendientes".
- Antes de promover a `certificacion` o `main`.

## Qué hace

1. Recolecta SQL del workspace desde **dos fuentes** (Paso 1):
   - `.workflow/sessions/<folder>/SCRIPTS.sql` de cada sesión del corpus.
   - `docs/scripts/*.sql` standalone (top-level), **excluyendo** cualquier `docs/scripts/NNN-export-scripts-*/` (bundles previos de este mismo skill).
2. Clasifica sentencias por categoría (DDL-TABLES / DDL-FUNCTIONS / DML / INSERTS).
3. Consolida cross-source por categoría en archivos al root del bundle con **numeración continua** tras `00-ROLLBACK.sql` (Paso 4).
4. Escribe los forwards consolidados.
5. Genera `00-ROLLBACK.sql` **al final**, leyendo los forwards ya escritos (Paso 6).
6. Escribe `README.md` minimal con índice de archivos + cómo aplicar + cómo revertir (Paso 7).

## Qué NO hace

- Ejecutar SQL, commits, merges, push.
- Tocar `.workflow/sessions/` ni archivos standalone de `docs/scripts/*.sql` (lectura only).
- Migrar bundles previos (`docs/scripts/00X-export-scripts-*` quedan como histórico).
- Generar plantillas de correo, checklists de producción, listados de commits, listados de sesiones, ACT-NNN, resúmenes ejecutivos.

## Sandbox read-only

`../session/references/sandbox-readonly-rules.md`. Plan describe NNN, fuentes detectadas, archivos esperados al root y contenido aproximado del README.

## Entrada

```
/agent-workflow:export-scripts [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
                               [--skip-standalone] [--dry-run]
```

| Flag | Comportamiento |
|---|---|
| `--sessions NNN[,NNN]` | Filtro discreto por código (precedencia sobre `--since`) |
| `--since sessionNNN` | Incluye sólo sesiones posteriores a NNN (inclusive) |
| `--source <alias>` | Limita a una fuente específica (hub mode) |
| `--skip-standalone` | Omite la lectura de `docs/scripts/*.sql` standalone |
| `--dry-run` | Reporte propositivo sin escribir archivos |

Sin args: incluye todas las sesiones cerradas + todos los `.sql` standalone de `docs/scripts/` (excluyendo bundles previos).

## Flujo

### Paso 1 — Recolección de fuentes SQL

**Fuente A — sesiones**:

```
agent-workflow release-data [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
```

Por cada sesión del corpus, leer `.workflow/sessions/<folder>/SCRIPTS.sql` si existe. Si no existe → skip silencioso (no es error). Markers esperados: `-- @category: <01-04>` + `-- @stmt: NNN-verbo-objetivo` (spec en `agent-workflow/skills/sql-script-organizer/references/scripts-sql-format.md`).

**Fuente B — standalone en `docs/scripts/`** (a menos que `--skip-standalone`):

Listar `docs/scripts/*.sql` (sólo top-level). **Excluir explícitamente** cualquier archivo dentro de directorios `docs/scripts/NNN-export-scripts-*/` (son outputs previos de este skill, no fuente). Por cada archivo:
- Inferir categoría desde el contenido: `CREATE TABLE`/`ALTER TABLE`/`CREATE INDEX` → `01`; `CREATE OR REPLACE FUNCTION` → `02`; `UPDATE`/`DELETE` → `03`; `INSERT INTO ... VALUES` → `04`.
- Si el archivo tiene markers `@category` explícitos, respetar el declarado.
- Si el filename contiene `rollback` (caso `*-rollback.sql` legacy): skip — no se incluye en forward, se asume que el operador ya tiene su propio rollback.

Si la unión de Fuentes A + B está vacía → abortar con mensaje "No hay SQL pendientes en el workspace".

### Paso 2 — Numeración del output dir

```
agent-workflow next-number docs/scripts
```

Output: `<docs>/scripts/NNN-export-scripts-YYYY-MM-DD/` (hub-aware vía CLI).

### Paso 3 — Clasificación y orden interno

Agrupar todas las sentencias recolectadas por categoría canónica:

1. `DDL-TABLES` — `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`, `CREATE SEQUENCE`.
2. `DDL-FUNCTIONS` — `CREATE OR REPLACE FUNCTION`, `PROCEDURE`.
3. `DML` — `UPDATE`, `DELETE`, migraciones de datos.
4. `INSERTS` — `INSERT INTO ... VALUES`, seeds.

Orden interno dentro de cada categoría: cronológico por origen — sesionXXX ascendente → stmt ascendente dentro de cada una; archivos standalone se intercalan por su orden léxico (`001-…`, `002-…`).

### Paso 4 — Numeración continua

Asignar números **secuenciales** a las categorías **con contenido**, en el orden canónico arriba:

| Categorías presentes | Archivos generados al root |
|---|---|
| Sólo DML | `00-ROLLBACK.sql`, `01-DML.sql` |
| DDL-TABLES + DML | `00-ROLLBACK.sql`, `01-DDL-TABLES.sql`, `02-DML.sql` |
| DDL-TABLES + DDL-FUNCTIONS + INSERTS | `00-ROLLBACK.sql`, `01-DDL-TABLES.sql`, `02-DDL-FUNCTIONS.sql`, `03-INSERTS.sql` |
| Las 4 | `00-ROLLBACK.sql`, `01-DDL-TABLES.sql`, `02-DDL-FUNCTIONS.sql`, `03-DML.sql`, `04-INSERTS.sql` |

**Sin gaps**: categorías vacías no ocupan número. El primer forward siempre es `01-…`.

### Paso 5 — Escribir forwards

Por cada categoría con contenido, escribir un archivo con:

**Header del archivo** (3 líneas máx):

```sql
-- 0N-<CATEGORIA>.sql — bundle NNN-export-scripts-YYYY-MM-DD
-- Generado por agent-workflow export-scripts v5.0.0
```

**Cuerpo**: las sentencias consolidadas en orden cronológico. Por cada sentencia, **un comentario de una línea** identificando su origen, seguido del SQL:

```sql
-- sessionXXX / NNN-verbo-objetivo
BEGIN;
<SQL del SCRIPTS.sql original>
COMMIT;
```

**Reglas de header SQL**:
- No replicar la motivación / impacto / idempotencia que ya está en el SCRIPTS.sql origen (se copia tal cual lo que escribió el developer).
- No agregar índice de sentencias al inicio del archivo.
- No agregar SELECTs de verificación post-write — si el developer los puso en SCRIPTS.sql, quedan; si no, no se inventan.
- El header de bloque per-sentencia es UNA línea: `-- sessionXXX / stmt-id` o `-- docs/scripts/001-filename.sql` (para fuente standalone).

### Paso 6 — Generar `00-ROLLBACK.sql` (al final)

Delegar a `sql-rollback-generator` v3.0.0+ **leyendo los forwards ya escritos** (no el SCRIPTS.sql original). Produce un archivo único al root del bundle con:

- Header mínimo (2 líneas: bundle + fecha).
- Sentencias inversas en orden inverso al de los forwards (último → primero).
- Bloque `BEGIN; … COMMIT;` único.
- Bloque "Fase 5 — Cleanup irreversible" al final fuera de la transacción (solo si hay irreversibles).

### Paso 7 — Escribir `README.md`

Usar `references/readme-template.md`. Sólo 3 secciones:

1. `## Archivos` — tabla con archivos generados (1 fila por archivo presente).
2. `## Aplicar` — bloque `bash` con `psql -f` por archivo, en orden ascendente.
3. `## Revertir` — `psql -f 00-ROLLBACK.sql` + nota sobre Fase 5 si aplica.

**Vetado** en el README: resumen ejecutivo, tabla de sesiones, plantillas de correo, ACT-NNN, listado de commits, checklist de producción, documentación graduada.

### Paso 8 — Validaciones V1-V2

Aplicar `references/validations.md`:

- **V1**: estructura del bundle (archivos obligatorios + numeración continua sin gaps + vetados ausentes).
- **V2**: ausencia de placeholders en `README.md` y `.sql`.

Ambas hard-fail. Si fallan → abortar antes de finalizar.

### Paso 9 — Resumen al usuario

Una línea por archivo escrito + ruta del bundle. No replicar el contenido del README en el resumen. Ejemplo:

```
Bundle escrito: docs/scripts/004-export-scripts-2026-05-28/
  00-ROLLBACK.sql  (12 líneas)
  01-DML.sql       (28 líneas)
  README.md        (18 líneas)
```

## Composición con otras skills

- **`sql-script-organizer`** — clasificación de categorías 01-04 cross-session.
- **`sql-rollback-generator`** v3.0.0+ — `00-ROLLBACK.sql` derivado de forwards.
- **`session`** — este skill NO invoca graduación ni cierre.
- **`agent-workflow:redaccion-simple`** — preset default aplicado en prosa del `README.md`.

## Re-ejecución

Idempotente funcional pero NO sobrescribe bundles previos. Cada ejecución toma siguiente NNN. Para regenerar: borrar el directorio manualmente y re-invocar.

## Recursos adicionales

- **`references/readme-template.md`** — plantilla del README minimal.
- **`references/validations.md`** — V1-V2 hard-fail.
- **`references/lexico-tecnico.md`** — lista de placeholders vetados (V2).
- **`references/code-scan-recommendations.md`** — catálogo opcional si se requiere escaneo de código adicional (NO se ejecuta por default en v5.0.0; el flujo del bundle no requiere code-scan).
- **`references/theme-handling.md`** — DEPRECATED en v5.0.0 (capa `por-tema/` removida del default; ver histórico si se requiere reactivar).
- **`references/manifest-template.md`** — DEPRECATED desde v4.0.0 (absorbido por README).
- **`references/deprecation-plan.md`** — plan de fases legacy `release`/`release-scripts`.

## Histórico de versiones

- **v5.0.0** (session103, 2026-05-28) — simplificación: numeración continua, headers SQL minimal, README de 3 secciones, búsqueda extendida a `docs/scripts/*.sql` standalone, rollback derivado de forwards. Sin code-scan ni theme handling por default.
- **v4.0.0** (session093) — layout plano cross-session (`00-ROLLBACK.sql` + `01-04` por categoría). Histórico — bundles previos no se migran.
- **v3.x y anteriores** — layout `por-sesion/` + `manifest.md` + `ORDER.md` + companions. Histórico.
