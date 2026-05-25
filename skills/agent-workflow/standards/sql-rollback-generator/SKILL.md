---
name: sql-rollback-generator
description: "Genera rollback **post-hoc** desde SCRIPTS.sql consolidado (v2.0.0 BREAKING — session093): cuando /agent-workflow:export-scripts produce el bundle, este skill emite un único archivo `00-ROLLBACK.sql` al root del bundle, encadenado cross-session en orden inverso (última sesión → primera, 04→03→02→01 dentro de cada una). NO genera `.rollback.sql` companions por sentencia ni `<session>/rollback/` per-sesión (ambos eliminados desde v2.0.0). Cubre DDL (DROP IF EXISTS), migraciones con backup en esq_audit, e inserts. Marca operaciones irreversibles (DROP COLUMN, TRUNCATE, DROP CASCADE) con header WARNING en bloque separado al final del archivo, después del `COMMIT;`."
version: 2.0.0
---

# SQL Rollback Generator (v2.0.0 — `00-ROLLBACK.sql` único cross-session)

Generación de rollback **post-hoc** desde los archivos `SCRIPTS.sql` de las sesiones incluidas en el bundle de export. Disparado por `/agent-workflow:export-scripts` v4.0.0+ al consolidar el bundle.

> **BREAKING desde v2.0.0**: este skill ya NO produce companions `.rollback.sql` por sentencia ni sub-carpetas `<session>/rollback/` per-sesión (comportamiento v1.0.0 eliminado). El output canónico es un único `00-ROLLBACK.sql` al root del bundle. Razón: el bundle se ejecuta atomic (todo o nada) — múltiples archivos rollback agregaban ruido sin valor operacional. Layouts v1.0.0 quedan como histórico; bundles generados con export-scripts v3.x no se reescriben.

## When to use

- **Disparado por `/agent-workflow:export-scripts`** al consolidar el bundle desde N sesiones.
- NL del usuario: "generar rollback", "script de reversa", "rollback global".
- Si el usuario quiere entender cómo revertir un cambio específico ANTES del export: este skill puede simular un rollback en plan-mode sin escribir archivos.

## Sandbox read-only

Reglas en `../session/references/sandbox-readonly-rules.md`. En plan mode describir estrategia por sentencia forward (sin crear `.rollback.sql`); irreversibles se anotan para revisión.

## Principios (v2.0.0)

- **Input**: `SCRIPTS.sql` de cada sesión incluida en el corpus de export, parseado vía markers `@category`/`@stmt` (ver `sql-script-organizer/references/scripts-sql-format.md`).
- **Output único**: `<bundle-root>/00-ROLLBACK.sql` — un solo archivo cross-session al root del bundle.
- **NO se generan** companions `.rollback.sql` por sentencia (eliminado en v2.0.0).
- **NO se genera** sub-carpeta `<session>/rollback/` per-sesión (eliminado en v2.0.0).
- **NO se genera** `rollback-global.sql` separado del root (eliminado en v2.0.0).
- **Orden interno**: encadenado en orden inverso global — última sesión → primera; dentro de cada sesión 04 → 03 → 02 → 01.
- **Estructura del archivo**:
  - Header del archivo: corpus + fecha + sesiones cubiertas + versión del CLI.
  - Bloque transaccional único `BEGIN; ... COMMIT;` con sub-bloques por sesión.
  - Cada sub-bloque preserva header canónico del rollback de su sentencia (Script / Sesion / Objeto / Alcance) como comentario.
  - Bloque final **fuera de la transacción**: "Fase 5 — Cleanup irreversible" con header `-- WARNING: IRREVERSIBLE` listando operaciones que no son revertibles automáticamente (decisión manual del operador).
- **Idempotencia obligatoria**: `DROP ... IF EXISTS`, `CREATE OR REPLACE`, `ON CONFLICT DO NOTHING`.
- **Datos**: si el forward es UPDATE/DELETE masivo sin backup, generar un `000-backup-*.sql` previo en `03-DML.sql` del bundle + el rollback que restaura desde `esq_audit.tb_bkp_<x>_sNNN` vive dentro de `00-ROLLBACK.sql`.

## Estructura del `00-ROLLBACK.sql`

Header global del archivo:

```sql
-- ============================================================================
-- Script:  00-ROLLBACK.sql
-- Bundle:  NNN-export-scripts-YYYY-MM-DD
-- Sesiones: sNNN, sNNN, ...
-- Objeto:  Revierte el bundle completo en orden inverso (última sesión → primera, 04→01).
-- Alcance: <enumeración cross-session>
-- ============================================================================
```

Sub-bloque por sentencia (dentro del `BEGIN; ... COMMIT;` único):

```sql
-- ----------------------------------------------------------------------------
-- Rollback de sesion sNNN — <categoria>: NNN-tipo-objetivo
-- Objeto:  <resumen de la reversa>
-- Alcance: <mismo alcance que el forward>
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS esq_.tb_x;
-- ...
```

- `Objeto:` del sub-bloque describe la reversa (ej. "Repone tb_x.cod_usuario al valor de esq_audit.tb_bkp_x_sNNN").
- `Alcance:` repite literal el del forward.

Bloque irreversibles al final del archivo (después del `COMMIT;`, **fuera de la transacción**):

```sql
COMMIT;

-- ============================================================================
-- Fase 5 — Cleanup irreversible (manual)
-- WARNING: IRREVERSIBLE — best-effort. Ver DECISIONS.md de la sesión origen.
-- ============================================================================
-- sesion sNNN — DROP COLUMN esq_.tb_x.col_y (no hay backup automático)
-- sesion sMMM — TRUNCATE esq_.tb_z
-- ...
```

El bloque WARNING explica qué no se puede recuperar y referencia la decisión de la sesión donde se introdujo.

## Estrategias por tipo de operación

### DDL de tablas

| Forward | Rollback |
|---|---|
| `CREATE TABLE IF NOT EXISTS esq_.tb_x` | `DROP TABLE IF EXISTS esq_.tb_x;` |
| `ALTER TABLE tb_x ADD COLUMN col_y ...` | `ALTER TABLE tb_x DROP COLUMN IF EXISTS col_y;` |
| `CREATE INDEX idx_... ON tb_x(col)` | `DROP INDEX IF EXISTS idx_...;` |
| `CREATE SEQUENCE esq_.seq_tb_x` | `DROP SEQUENCE IF EXISTS esq_.seq_tb_x;` |
| `DROP TABLE tb_x` | Backup previo en `esq_audit.tb_bkp_x_sessionXXX`; rollback es `CREATE TABLE ... AS SELECT * FROM esq_audit.tb_bkp_x_sessionXXX` |
| Reconstrucción | Script previo `000-backup-tb-x.sql` que copia a `esq_audit`; rollback restaura desde backup |

### DDL de funciones y SP

| Forward | Rollback |
|---|---|
| `CREATE OR REPLACE FUNCTION fn_x(...)` | `DROP FUNCTION IF EXISTS fn_x(<firma>);` o recrear versión previa con `CREATE OR REPLACE` embebido |
| `CREATE OR REPLACE PROCEDURE sp_x(...)` | `DROP PROCEDURE IF EXISTS sp_x(<firma>);` + recreación si existe versión anterior |
| `DROP FUNCTION fn_x` | `-- WARNING: IRREVERSIBLE` — incluir cuerpo en comentario |

### Migración de datos (UPDATE / DELETE)

Pasos obligatorios antes del forward:

1. Generar `000-backup-<tabla>.sql` que copia filas afectadas a `esq_audit.tb_bkp_<tabla>_sessionXXX`.
2. Rollback usa el backup:

```sql
BEGIN;
UPDATE esq_.tb_x t
SET col_a = bkp.col_a, col_b = bkp.col_b
FROM esq_audit.tb_bkp_x_sessionXXX bkp
WHERE t.id_x = bkp.id_x;
COMMIT;
```

Si DELETE masivo, rollback es `INSERT INTO ... SELECT * FROM esq_audit.tb_bkp_...`.

### Inserts de datos nuevos

```sql
BEGIN;
DELETE FROM esq_.tb_maestras WHERE campo_identificador IN (<lista>);
COMMIT;
```

Usar claves naturales o rango de IDs conocido — nunca DELETE sin WHERE.

### Operaciones irreversibles

Marcar con `-- WARNING: IRREVERSIBLE` en el header del forward:

- `TRUNCATE TABLE`
- `DROP COLUMN` sin respaldo previo
- `DROP TABLE` sin respaldo previo
- `ALTER COLUMN TYPE` con pérdida de precisión
- Cascadas destructivas (`DROP ... CASCADE`)
- `DELETE` sin respaldo en `esq_audit`

Protocolo:

1. Header WARNING.
2. Registrar decisión en DECISIONS.md (legacy: DECISIONES.md) antes de ejecutar.
3. Generar rollback "best-effort" indicando qué se perdería.
4. **Confirmación explícita** del usuario antes de continuar.

Lista completa en `references/irreversible-checklist.md`.

## Layout (post-export-scripts v4.0.0)

Output canónico — un solo archivo al root del bundle:

```
<docs>/scripts/NNN-export-scripts-YYYY-MM-DD/
└── 00-ROLLBACK.sql                # único rollback cross-session (este skill lo genera)
```

Para context: el bundle plano del export incluye además `01-DDL-TABLES.sql`, `02-DDL-FUNCTIONS.sql`, `03-DML.sql`, `04-INSERTS.sql`, `README.md` — todos al root, generados por `export-scripts` (no por este skill).

**No se generan** (eliminados desde v2.0.0):
- Companions `.rollback.sql` por sentencia.
- Sub-carpeta `<session>/rollback/` per-sesión.
- Archivo `rollback-global.sql` separado.
- Archivos `04-inserts-rollback.sql`, `03-migracion-rollback.sql`, etc. (categorías por separado).

Layouts v1.0.0 quedan como histórico en bundles ya generados (`docs/scripts/00X-export-scripts-*` previos). No se migran retroactivamente. Layouts legacy v0.x se migran con `/agent-workflow:migrate --upgrade-topology`.

## Proceso (v2.0.0)

1. Parsear todos los `SCRIPTS.sql` del corpus de export (markers `@category`/`@stmt`).
2. Para cada sentencia forward, clasificar el tipo y seleccionar estrategia (DDL / migración / inserts / irreversible).
3. Generar el bloque rollback correspondiente — sin escribir todavía a disco.
4. Identificar irreversibles → moverlos al bloque "Fase 5" final.
5. Componer el `00-ROLLBACK.sql` único con orden inverso global (última sesión → primera, 04→01) + bloque "Fase 5" al final.
6. Escribir el archivo único al root del bundle.

## Notas de portabilidad (PostgreSQL como motor primario)

| Concepto | PostgreSQL | Oracle | SQL Server |
|---|---|---|---|
| Rollback de función | `DROP FUNCTION IF EXISTS fn(...sig)` | `DROP FUNCTION fn` | `DROP FUNCTION IF EXISTS fn` |
| Idempotencia create | `CREATE OR REPLACE FUNCTION` | `CREATE OR REPLACE FUNCTION` | `CREATE OR ALTER PROCEDURE` |
| Insertar sin duplicar | `ON CONFLICT DO NOTHING` | `INSERT ... WHERE NOT EXISTS` | `IF NOT EXISTS (SELECT 1 ...) INSERT` |
| Secuencia | `DROP SEQUENCE IF EXISTS seq_` | `DROP SEQUENCE seq_` | No aplica (IDENTITY) |

Si el destino no es Postgres, indicarlo en `Objeto:` o como nota libre debajo del header (no como campo nuevo).

## Graduación al cierre

Este skill **NO se invoca al cerrar una sesión**. La graduación de scripts de una sesión individual produce `docs/scripts/NNN-sessionXXX-nombre/` con el `SCRIPTS.sql` curado; el rollback consolidado vive **exclusivamente en el bundle de export** (`docs/scripts/NNN-export-scripts-YYYY-MM-DD/00-ROLLBACK.sql`).

## Modo release (LEGACY — deprecation Fase 1)

`release` y `release-scripts` (legacy en deprecation Fase 1) consumían el algoritmo v1.0.0 (companions `.rollback.sql` + per-sesión rollback + global). Ese código y output **no se actualizan a v2.0.0**: se conserva como histórico en `references/release-rollback.md` mientras los workspaces dejan de invocarlos. El reemplazo canónico es `/agent-workflow:export-scripts` v4.0.0+ que invoca este skill en v2.0.0.

## Integración con otros skills

- **`sql-script-organizer`** — companion: organiza el `SCRIPTS.sql` por sesión que este skill consume al exportar.
- **`export-scripts`** v4.0.0+ — único invocador activo de este skill (genera `00-ROLLBACK.sql` único).
- **`release`** / **`release-scripts`** — legacy en deprecation Fase 1; consumen `references/release-rollback.md` (no se actualiza).
- **`coding-standards`** — reglas de estilo SQL en `database-conventions.md#estilo-de-scripts-sql`.
- **`session`** — este skill NO se invoca al cerrar una sesión individual; sólo desde export-scripts.

## Recursos adicionales

- **`references/rollback-patterns.md`** — recetas completas con ejemplos SQL.
- **`references/irreversible-checklist.md`** — lista de irreversibles y protocolo.
- **`references/release-rollback.md`** — algoritmos de rollback global y por tema (modo release).
