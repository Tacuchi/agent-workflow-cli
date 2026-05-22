---
name: sql-rollback-generator
description: "Genera rollback **post-hoc** desde SCRIPTS.sql consolidado (v1.0.0 BREAKING — F-D session062): cuando /agent-workflow:export-scripts separa el bundle, este skill produce `.rollback.sql` por sentencia forward + `rollback-global.sql` encadenado en orden inverso (04→03→02→01). Cubre DDL (DROP IF EXISTS), migraciones con backup en esq_audit, e inserts. Marca operaciones irreversibles (DROP COLUMN, TRUNCATE, DROP CASCADE) con header WARNING. BREAKING desde v1.0.0: deja de generar rollbacks durante exec por archivo; la generación ocurre exclusivamente al exportar."
version: 1.0.0
---

# SQL Rollback Generator (v1.0.0 — on-export)

Generación de rollbacks **post-hoc** desde el archivo único `SCRIPTS.sql` de cada sesión. Disparado por `/agent-workflow:export-scripts` v3.0.0+ al producir el bundle de release.

> **BREAKING desde v1.0.0**: este skill ya NO genera `.rollback.sql` durante la sesión. La política previa "on-write per archivo" (v0.x) generaba un rollback acoplado por cada forward; la política nueva "on-export" agrupa la generación al consolidar el bundle. Razón: el flujo SQL durante exec ahora es un único `SCRIPTS.sql` (ver `sql-script-organizer` v1.0.0); no hay archivos individuales que parear con rollbacks. Layouts legacy se migran con `/agent-workflow:migrate --upgrade-topology`.

## When to use

- **Disparado por `/agent-workflow:export-scripts`** al consolidar el bundle desde N sesiones.
- NL del usuario: "generar rollback", "script de reversa", "rollback global".
- Si el usuario quiere entender cómo revertir un cambio específico ANTES del export: este skill puede simular un rollback en plan-mode sin escribir archivos.

## Sandbox read-only

Reglas en `../session/references/sandbox-readonly-rules.md`. En plan mode describir estrategia por sentencia forward (sin crear `.rollback.sql`); irreversibles se anotan para revisión.

## Principios (v1.0.0)

- **Input**: `SCRIPTS.sql` de cada sesión incluida en el corpus de export, parseado vía markers `@category`/`@stmt` (ver `sql-script-organizer/references/scripts-sql-format.md`).
- **Output**: archivos `.rollback.sql` ubicados junto al forward separado en el bundle export (`por-sesion/sessionXXX/<categoria>/NNN-*.rollback.sql`).
- **Global**: `por-sesion/sessionXXX/rollback/00-rollback-global.sql` encadena los rollbacks en orden inverso (04 → 03 → 02 → 01), todo en `BEGIN; ... COMMIT;` único.
- **Idempotencia obligatoria**: `DROP ... IF EXISTS`, `CREATE OR REPLACE`, `ON CONFLICT DO NOTHING`.
- **Transacción obligatoria** en cada rollback individual.
- **Header del rollback** reusa el del forward (4 líneas Script/Sesion/Objeto/Alcance) con `Objeto:` describiendo la reversa.
- **Irreversibles** (DROP COLUMN, TRUNCATE, DROP CASCADE, datos sin backup) marcados con `-- WARNING: IRREVERSIBLE` debajo del header.
- **Datos**: si el forward es UPDATE/DELETE masivo sin backup, generar un `000-backup-*.sql` previo en el bundle (Categoría 03-migracion) + rollback que restaure desde `esq_audit.tb_bkp_<x>_sNNN`.

## Header del rollback

El `.rollback.sql` reusa el mismo formato canónico definido en `sql-script-organizer/SKILL.md#header-canónico`:

```sql
-- ============================================================================
-- Script:  NNN-tipo-objetivo.rollback.sql
-- Sesion:  sNNN
-- Objeto:  Revierte los cambios de NNN-tipo-objetivo.sql (<resumen de la reversa>).
-- Alcance: <mismo alcance que el forward>
-- ============================================================================
```

- `Objeto:` describe la reversa, no el forward (ej. "Repone tb_x.cod_usuario al valor de esq_audit.tb_bkp_x_sNNN").
- `Alcance:` repite literal el del forward para que quede explícito que la reversa cubre exactamente el mismo set.
- Si el forward es irreversible, agregar **debajo del header** una línea suelta:

  ```sql
  -- ============================================================================
  -- Script:  ...
  -- Sesion:  ...
  -- Objeto:  ...
  -- Alcance: ...
  -- ============================================================================
  -- WARNING: IRREVERSIBLE — best-effort, ver DECISIONS.md DEC-NNN (legacy: DECISIONES.md).
  ```

  El bloque WARNING explica qué no se puede recuperar y referencia la decisión.

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

## Layout (post-export-scripts v3.0.0)

### Par acoplado

`export-scripts` produce los archivos separados desde SCRIPTS.sql y este skill genera el rollback junto a cada forward:

```
<docs>/scripts/NNN-export-scripts-YYYY-MM-DD/por-sesion/sessionXXX/01-ddl-tablas/
├── 001-crea-tb-x.sql              (forward, derivado de @stmt en SCRIPTS.sql)
└── 001-crea-tb-x.rollback.sql     (rollback, generado por este skill)
```

### Bundle global

```
<docs>/scripts/NNN-export-scripts-YYYY-MM-DD/por-sesion/sessionXXX/rollback/
├── 00-rollback-global.sql      (encadena todos 04→01 con BEGIN/COMMIT único)
├── 04-inserts-rollback.sql
├── 03-migracion-rollback.sql
├── 02-ddl-funciones-rollback.sql
└── 01-ddl-tablas-rollback.sql
```

Layout pre-v1.0.0 (`scripts/bundle/...` dentro de la sesión durante exec) ya no se genera. Layouts legacy se migran con `/agent-workflow:migrate --upgrade-topology`.

## Proceso

1. Leer el forward — identificar tipo.
2. Clasificar — seleccionar estrategia.
3. Generar rollback acoplado.
4. Verificar irreversibilidades — warning + DECISIÓN + confirmación si aplica.
5. Actualizar bundle global.
6. Verificar cobertura antes de graduar.

## Notas de portabilidad (PostgreSQL como motor primario)

| Concepto | PostgreSQL | Oracle | SQL Server |
|---|---|---|---|
| Rollback de función | `DROP FUNCTION IF EXISTS fn(...sig)` | `DROP FUNCTION fn` | `DROP FUNCTION IF EXISTS fn` |
| Idempotencia create | `CREATE OR REPLACE FUNCTION` | `CREATE OR REPLACE FUNCTION` | `CREATE OR ALTER PROCEDURE` |
| Insertar sin duplicar | `ON CONFLICT DO NOTHING` | `INSERT ... WHERE NOT EXISTS` | `IF NOT EXISTS (SELECT 1 ...) INSERT` |
| Secuencia | `DROP SEQUENCE IF EXISTS seq_` | `DROP SEQUENCE seq_` | No aplica (IDENTITY) |

Si el destino no es Postgres, indicarlo en `Objeto:` o como nota libre debajo del header (no como campo nuevo).

## Graduación al cierre

`rollback/` viaja junto al bundle forward bajo `docs/scripts/NNN-sessionXXX-nombre/rollback/`.

## Modo release (cross-session + por tema)

`release` y `release-scripts` invocan este skill para producir rollback global del release y rollback por tema. Algoritmo detallado (3 niveles, principios, qué NO hacer, verificación) en **`references/release-rollback.md`**.

## Integración con otros skills

- **`sql-script-organizer`** — companion: organiza el bundle forward y coordina rollbacks. En modo release, provee bundle consolidado.
- **`release`** — consume rollback global de release.
- **`release-scripts`** — consume rollback por tema.
- **`coding-standards`** — reglas de estilo SQL en `database-conventions.md#estilo-de-scripts-sql`.
- **`session`** — Fase 3 invoca este skill junto a `sql-script-organizer` al escribir el primer `.sql`.

## Recursos adicionales

- **`references/rollback-patterns.md`** — recetas completas con ejemplos SQL.
- **`references/irreversible-checklist.md`** — lista de irreversibles y protocolo.
- **`references/release-rollback.md`** — algoritmos de rollback global y por tema (modo release).
