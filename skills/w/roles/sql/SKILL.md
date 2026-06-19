---
name: sql
description: >-
  SQL / database capability — built-in default for the `sql` role. Authoring DB
  changes as versioned scripts (never executing them): writes statements to the
  session `SCRIPTS.sql` with `@category` + `@stmt` markers, applies project SQL
  style (canonical header, BEGIN/COMMIT, idempotency, explicit schema, CTEs over
  DO/LOOP), classifies into the 4 categories, and knows how rollbacks are derived
  on export. DB access is read-only via MCP — DML/DDL is NEVER executed (invariant 4).
  Use when a loop writes migrations / queries, when research reads schema, or when
  export-scripts consolidates the bundle.
---

# sql — SQL / database capability

## Role

`sql` — built-in default. Rebindable in `.workflow/skills.toml` (third-party skill or `off`). When `off`, the loop continues without DB authoring help and says so if the task needed it.

## Purpose

Autorar cambios de base de datos como **scripts SQL versionados**, nunca ejecutándolos. Cubre dos modos:

- **Read-only** (consulta): leer schema/datos via MCP para entender el dominio (research, planning).
- **Write-to-script** (cambio): toda mutación de BD se escribe a `SCRIPTS.sql` de la sesión; la **aplica el usuario**, no la IA.

## Composed by

- **research** — leer schema via MCP read-only para entender el dominio.
- **`plan-exec-loop`** — cada cambio SQL se appendea a `SCRIPTS.sql` durante la ejecución.
- **`quick-loop`** — igual, para el atajo liviano.
- **`export-scripts`** — consolida los `SCRIPTS.sql` de N sesiones en el bundle `docs/scripts/NNN-export-scripts-YYYY-MM-DD/` y deriva el rollback.

## Knowledge

### Regla cero — nunca ejecutar SQL (invariante 4)

La IA **nunca ejecuta DML/DDL** contra ninguna BD, por ningún canal (MCP, `psql`, `Bash`, driver de app). Las migraciones quedan en `SCRIPTS.sql` y las **aplica el usuario**. Si aparece la tentación de "verificar aplicando", rehusar y pedir al usuario que ejecute.

- **Lecturas read-only via MCP**: `SELECT`, inspección de schema, conteos — OK. Sin `INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE`.
- Los MCP de BD (cert/prod) son **READONLY** por contrato.
- Excepción única, que NO relaja la regla: si el usuario pide explícitamente "ejecutalo vos contra cert", aún así confirmar por bloque y no asumir autorización ampliada.

### Staging — archivo único `SCRIPTS.sql` por sesión

```
.workflow/sessions/<folder>/
└── SCRIPTS.sql      (consolidado de TODAS las sentencias de la sesión)
```

Cada sentencia se **appendea** con un par de markers en comentarios:

```sql
-- @category: 01-ddl-tablas
-- @stmt: 01-crear-tabla-usuarios
CREATE TABLE IF NOT EXISTS esq_credito.tb_usuarios (
  ...
);
```

- `@category` clasifica (4 valores canónicos, abajo).
- `@stmt` da el slug determinístico `NN-verbo-objetivo`; `export-scripts` deriva el filename al separar.
- Orden dentro del archivo = orden cronológico de append. El orden de ejecución final por categoría (01→02→03→04) lo resuelve `export-scripts`, no este paso.
- `BEGIN;` global al inicio del archivo, `COMMIT;` al final. Cada sentencia individual **no** trae su propio BEGIN/COMMIT.
- **Sin** `.rollback.sql` per archivo durante exec — el rollback se genera al exportar.

### Las 4 categorías (`@category`)

| Marker | Patrones de detección |
|---|---|
| `01-ddl-tablas` | `CREATE/DROP/ALTER TABLE`, `CREATE INDEX`, `CREATE SEQUENCE` |
| `02-ddl-funciones` | `CREATE [OR REPLACE] FUNCTION/PROCEDURE`, `DROP FUNCTION/PROCEDURE` |
| `03-migracion` | `UPDATE`, `INSERT ... SELECT`, `DELETE` sobre datos existentes, transformaciones de columnas |
| `04-inserts` | `INSERT INTO ... VALUES`, seeds de catálogos, datos de configuración inicial |

**Orden de ejecución obligatorio**: 01 → 02 → 03 → 04. El `SCRIPTS.sql` puede mezclar categorías cronológicamente; `export-scripts` ordena el bundle final.

### Estilo SQL (cumple `database-conventions`)

- **Header canónico de 4 líneas**, entre dos líneas de iguales:
  ```sql
  -- ============================================================================
  -- Script:  NNN-tipo-objetivo.sql
  -- Sesion:  sNNN
  -- Objeto:  <qué hace, 1-2 líneas>
  -- Alcance: <filtros y boundaries del cambio, 1 línea>
  -- ============================================================================
  ```
  Solo 4 campos. Autor/Fecha/notas largas NO van en el header (si hacen falta, bloque libre debajo). Si el motor no es Postgres, indicarlo en `Objeto:`.
- **Idempotencia**: `CREATE TABLE IF NOT EXISTS`, `DROP ... IF EXISTS`, `CREATE OR REPLACE`, `ON CONFLICT`.
- **Schema explícito** siempre (`esq_credito.tb_x`, nunca `public.`).
- **CTEs sobre DO/LOOP**: una transformación = `WITH ... AS` encadenadas + un `INSERT/UPDATE/DELETE` final. Evitar `DO $$ ... LOOP ... END $$` cuando el resultado se logra declarativamente (más fácil de auditar y revertir). Excepción: descubrimiento dinámico de objetos (FKs/columnas/constraints) — documentar el motivo en `Objeto:`.
- **Queries parametrizadas** siempre (nunca concatenar strings) — en cualquier SQL que termine en código de app.
- Nunca crear `fn_*`/`sp_*` para reusar lógica exclusiva de un script; usar CTE o inline.
- **Separadores entre secciones** (solo si hay 2+ secciones):
  ```sql
  -- ----------------------------------------------------------------------------
  -- N. Descripción corta de qué hace este bloque.
  -- ----------------------------------------------------------------------------
  ```
  Cajas dobles (`====`) solo para el header.

### Proceso de mantenimiento del `SCRIPTS.sql`

1. **Detectar la categoría** del cambio (tabla de markers).
2. **Verificar idempotencia** del statement.
3. **Append** con par de markers (`@category` + `@stmt`).
4. **Style check** — header canónico, CTEs sobre DO/LOOP, schema explícito.
5. **No** renumerar ni mover (solo hay un `SCRIPTS.sql`).
6. **No** generar `.rollback.sql` durante exec.

### Rollback (lo genera `export-scripts`, no este paso)

`export-scripts` lee los forwards ya consolidados y genera **un único** `00-ROLLBACK.sql` al root del bundle, en orden inverso. Conocer las estrategias para escribir forwards reversibles:

| Forward | Rollback |
|---|---|
| `CREATE TABLE IF NOT EXISTS tb_x` | `DROP TABLE IF EXISTS tb_x;` |
| `ALTER TABLE tb_x ADD COLUMN col` | `ALTER TABLE tb_x DROP COLUMN IF EXISTS col;` |
| `CREATE INDEX idx_...` | `DROP INDEX IF EXISTS idx_...;` |
| `CREATE SEQUENCE seq_...` | `DROP SEQUENCE IF EXISTS seq_...;` |
| `CREATE OR REPLACE FUNCTION fn_x(...)` | `DROP FUNCTION IF EXISTS fn_x(<firma>);` |
| `UPDATE/DELETE` con backup en `esq_audit.tb_bkp_*` | `UPDATE … FROM esq_audit.tb_bkp_…` |
| `INSERT INTO tb_x VALUES (...)` | `DELETE FROM tb_x WHERE <clave natural / rango>;` (nunca DELETE sin WHERE) |

**Irreversibles → bloque "Fase 5" manual** (fuera de la transacción, una línea por caso): `TRUNCATE`, `DROP COLUMN`/`DROP TABLE` sin backup, `ALTER COLUMN TYPE` con pérdida, `DROP ... CASCADE`, `DELETE/UPDATE` sin respaldo en `esq_audit`. Para que un cambio destructivo sea reversible, escribir el backup en el mismo forward (`esq_audit.tb_bkp_<tabla>_sNNN`).

## Output

- Durante loops: sentencias appendeadas a `.workflow/sessions/<folder>/SCRIPTS.sql` (artefacto de sesión, no `docs/`).
- Vía `export-scripts`: bundle `docs/scripts/NNN-export-scripts-YYYY-MM-DD/` — `00-ROLLBACK.sql` + `01-<CATEGORIA>.sql` … (numeración continua, sin gaps por categoría vacía) + `README.md`. Orden canónico de categorías: `DDL-TABLES → DDL-FUNCTIONS → DML → INSERTS`.

Nunca escribe a `docs/` desde un loop (invariante 1: solo `export-*` exporta). Nunca ejecuta nada contra una BD (invariante 4).

## Source

Reciclada de `standards/sql-script-organizer/` (staging `SCRIPTS.sql`, markers, 4 categorías, estilo) + `standards/sql-rollback-generator/` (derivación de rollback, irreversibles, Fase 5) + reglas de estilo de `standards/coding-standards/references/database-conventions.md`. Se moderniza al modelo nuevo: el bundle lo arma `export-scripts`, no la skill; el "release/graduate" viejo se reemplaza por `export-scripts`.
