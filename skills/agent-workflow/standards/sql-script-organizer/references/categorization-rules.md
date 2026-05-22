# Reglas de Categorización de Scripts SQL

## Patrones de detección por categoría

### `01-ddl-tablas/` — Estructura de tablas

| Patrón | Ejemplos |
|---|---|
| `CREATE TABLE` | `CREATE TABLE IF NOT EXISTS esq_credito.tb_solicitud (...)` |
| `DROP TABLE` | `DROP TABLE IF EXISTS esq_credito.tb_solicitud_bkp;` |
| `ALTER TABLE ... ADD COLUMN` | `ALTER TABLE esq_credito.tb_credito ADD COLUMN flag_activo integer;` |
| `ALTER TABLE ... DROP COLUMN` | `ALTER TABLE esq_credito.tb_credito DROP COLUMN IF EXISTS col_legacy;` |
| `ALTER TABLE ... ALTER COLUMN` | `ALTER TABLE tb_x ALTER COLUMN monto_total TYPE numeric(18,4);` |
| `ALTER TABLE ... RENAME` | `ALTER TABLE esq_credito.tb_x RENAME COLUMN col_vieja TO col_nueva;` |
| `CREATE INDEX` | `CREATE INDEX IF NOT EXISTS idx_tb_credito_cliente ON esq_credito.tb_credito(id_cliente);` |
| `DROP INDEX` | `DROP INDEX IF EXISTS esq_credito.idx_tb_credito_legacy;` |
| `CREATE SEQUENCE` | `CREATE SEQUENCE IF NOT EXISTS esq_credito.seq_tb_nueva;` |
| `DROP SEQUENCE` | `DROP SEQUENCE IF EXISTS esq_credito.seq_tb_legacy;` |
| `CREATE TABLE ... AS SELECT` | Reconstrucción desde backup |
| Constraint `ADD/DROP` | `ALTER TABLE tb_x ADD CONSTRAINT pk_tb_x PRIMARY KEY (id_x);` |

### `02-ddl-funciones/` — Funciones y Stored Procedures

| Patrón | Ejemplos |
|---|---|
| `CREATE [OR REPLACE] FUNCTION` | `CREATE OR REPLACE FUNCTION esq_credito.fn_calcular_cuota(...)` |
| `CREATE [OR REPLACE] PROCEDURE` | `CREATE OR REPLACE PROCEDURE esq_credito.sp_genera_credito(...)` |
| `DROP FUNCTION` | `DROP FUNCTION IF EXISTS esq_credito.fn_legacy(integer, numeric);` |
| `DROP PROCEDURE` | `DROP PROCEDURE IF EXISTS esq_credito.sp_legacy(integer);` |
| `CREATE [OR REPLACE] VIEW` | Vistas con lógica de negocio compleja |
| `DROP VIEW` | `DROP VIEW IF EXISTS esq_credito.vw_resumen_credito;` |

> **Nota**: La firma completa (incluyendo tipos de parámetros) es necesaria en `DROP FUNCTION`/`DROP PROCEDURE` para evitar ambigüedad en PostgreSQL.

### `03-migracion/` — Transformación de datos existentes

| Patrón | Ejemplos |
|---|---|
| `UPDATE` sobre tabla existente | `UPDATE esq_credito.tb_credito SET estado = 1 WHERE estado IS NULL;` |
| `INSERT ... SELECT ...` | Copiar/transformar datos entre tablas |
| `DELETE` sobre datos existentes | `DELETE FROM tb_x WHERE fecha_registro < '2020-01-01';` |
| Relleno de nueva columna | `UPDATE tb_x SET nueva_col = fn_calcula(otra_col);` |
| Normalización de datos | Separar una columna en múltiples, fusionar tablas |
| Migración de tipo de dato | Copiar valores transformados antes de cambiar tipo |

> **Importante**: Cualquier script de migración debe ir precedido de un `000-backup-<tabla>.sql` que respalde las filas afectadas a `esq_audit`.

### `04-inserts/` — Datos nuevos (seeds / catálogos)

| Patrón | Ejemplos |
|---|---|
| `INSERT INTO ... VALUES (...)` | Registros de `tb_maestra_detalle`, roles, perfiles |
| Seeds de configuración | Parámetros iniciales, valores de lookup |
| Datos de referencia | Países, monedas, estados de proceso |
| `INSERT ... ON CONFLICT DO NOTHING` | Idempotent inserts de catálogos |
| `INSERT ... ON CONFLICT DO UPDATE` | Upserts de configuración |

---

## Edge cases y scripts mixtos

### Script con DDL + DML (mezcla)

Si un script crea una tabla Y la puebla inmediatamente (patrón común en seeds):

**Opción A (recomendada)**: Dividir en dos scripts — `01-ddl-tablas/001-crea-tb-x.sql` + `04-inserts/001-inserta-tb-x.sql`.

**Opción B**: Si la división no tiene sentido semántico (ej: tabla temporal de trabajo que se llena y elimina en la misma operación), clasificar según la operación **dominante**. Documentar en el `README.md` del bundle.

### Scripts de respaldo previo (`000-backup-*.sql`)

Los scripts de respaldo pertenecen a la misma categoría que su script de migración:
- `03-migracion/000-backup-tb-credito.sql` precede a `03-migracion/001-migra-estado.sql`
- Numeración especial `000` para indicar que va primero dentro de la categoría

### Funciones de apoyo temporal

Si un script `03-migracion` usa una función **solo dentro de ese script** (creada y eliminada en el mismo archivo), **no** moverla a `02-ddl-funciones/`. Usar un bloque `DO $$ ... $$` o una CTE en su lugar, siguiendo la regla "sin funciones utilitarias efímeras".

### Scripts de versionado de funciones (`_v2`, `_v3`)

Al actualizar una función a una nueva versión:
- `02-ddl-funciones/001-actualiza-fn-x-v2.sql` → `CREATE OR REPLACE FUNCTION fn_x(...)`
- El rollback contiene la versión anterior (`v1`) para restaurar en caso necesario
- **No eliminar** la versión anterior hasta confirmar que `v2` funciona en producción

### Views

Clasificar en `02-ddl-funciones/` (mismo directorio que funciones). Las views son DDL de objetos de BD, no migración de datos.

---

## Resolución de dependencias entre categorías

Al renumerar, verificar:

1. `03-migracion` no puede referenciar una columna creada en `01-ddl-tablas` si ese script aún no fue ejecutado
2. `04-inserts` no puede insertar en una tabla que existe solo en `01-ddl-tablas` del mismo bundle (al ejecutar prod, ir en orden)
3. `02-ddl-funciones` puede depender de tablas de `01-ddl-tablas` — verificar que la función no se crea antes que su tabla

Si se detecta una dependencia circular o un orden imposible, dividir el bundle en sub-bundles y documentarlo en `README.md`.

---

## Nomenclatura de archivos

Formato: `NNN-verbo-sustantivo-objetivo.sql`

| Elemento | Regla | Ejemplos |
|---|---|---|
| `NNN` | 3 dígitos, cero-padded dentro de la categoría | `001`, `002`, `010` |
| `verbo` | acción que realiza el script | `crea`, `elimina`, `modifica`, `migra`, `inserta`, `actualiza`, `agrega` |
| `sustantivo` | objeto principal afectado | `tb-credito`, `fn-calcular-cuota`, `sp-genera-credito` |
| `objetivo` | detalle adicional si es necesario | `columna-estado`, `v2`, `sesion-inicial` |

Ejemplos válidos:
- `001-crea-tb-solicitud.sql`
- `002-agrega-columna-flag-activo-tb-credito.sql`
- `001-crea-fn-calcular-cuota-v2.sql`
- `001-migra-estado-credito.sql`
- `000-backup-tb-credito.sql`
- `001-inserta-maestras-estado-solicitud.sql`
