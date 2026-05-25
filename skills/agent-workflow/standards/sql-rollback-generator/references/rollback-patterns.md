# Patrones de Rollback SQL

Recetas por tipo de operación. Motor primario: **PostgreSQL**. Se incluyen equivalencias para otros motores donde difieren.

---

## DDL de Tablas

### CREATE TABLE → DROP TABLE

```sql
-- Forward
BEGIN;
CREATE TABLE IF NOT EXISTS esq_credito.tb_nueva (
    id_nueva    integer         NOT NULL DEFAULT nextval('esq_credito.seq_tb_nueva'),
    nombre      varchar(100)    NOT NULL,
    estado      integer         NOT NULL DEFAULT 1,
    CONSTRAINT pk_tb_nueva PRIMARY KEY (id_nueva)
);
COMMIT;

-- Rollback
BEGIN;
DROP TABLE IF EXISTS esq_credito.tb_nueva;
DROP SEQUENCE IF EXISTS esq_credito.seq_tb_nueva;  -- si la secuencia fue creada junto a la tabla
COMMIT;
```

### ALTER TABLE ADD COLUMN → DROP COLUMN

```sql
-- Forward
BEGIN;
ALTER TABLE esq_credito.tb_credito
    ADD COLUMN IF NOT EXISTS flag_reestructurado integer NOT NULL DEFAULT 0;
COMMIT;

-- Rollback
BEGIN;
ALTER TABLE esq_credito.tb_credito
    DROP COLUMN IF EXISTS flag_reestructurado;
COMMIT;
```

### DROP TABLE (con respaldo previo)

```sql
-- 000-backup-tb-x.sql (siempre antes del DROP)
BEGIN;
CREATE TABLE IF NOT EXISTS esq_audit.tb_bkp_credito_sessionXXX
    AS SELECT * FROM esq_credito.tb_credito_legacy;
COMMIT;

-- Forward
BEGIN;
DROP TABLE IF EXISTS esq_credito.tb_credito_legacy;
COMMIT;

-- Rollback
BEGIN;
CREATE TABLE IF NOT EXISTS esq_credito.tb_credito_legacy
    AS SELECT * FROM esq_audit.tb_bkp_credito_sessionXXX;
-- Restaurar constraints si aplica:
ALTER TABLE esq_credito.tb_credito_legacy
    ADD CONSTRAINT pk_tb_credito_legacy PRIMARY KEY (id_credito_legacy);
COMMIT;
```

### CREATE INDEX → DROP INDEX

```sql
-- Forward
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tb_credito_cliente
    ON esq_credito.tb_credito(id_cliente);

-- Rollback
DROP INDEX CONCURRENTLY IF EXISTS esq_credito.idx_tb_credito_cliente;
```

> `CONCURRENTLY` no puede ir dentro de `BEGIN/COMMIT` en PostgreSQL — ejecutar fuera de transacción o sin `CONCURRENTLY` dentro de transacción.

---

## DDL de Funciones y SP

### CREATE OR REPLACE FUNCTION → DROP FUNCTION

```sql
-- Forward
BEGIN;
CREATE OR REPLACE FUNCTION esq_credito.fn_calcular_cuota_v2(
    p_monto     numeric,
    p_tasa      numeric,
    p_plazo     integer
) RETURNS numeric
LANGUAGE plpgsql AS $$
BEGIN
    RETURN p_monto * (p_tasa / 12) / (1 - POWER(1 + p_tasa / 12, -p_plazo));
END;
$$;
COMMIT;

-- Rollback: eliminar nueva versión y restaurar la anterior (si existe)
BEGIN;
DROP FUNCTION IF EXISTS esq_credito.fn_calcular_cuota_v2(numeric, numeric, integer);
-- Si existía v1, recrear aquí:
-- CREATE OR REPLACE FUNCTION esq_credito.fn_calcular_cuota(...) ...
COMMIT;
```

> **Siempre incluir la firma completa en `DROP FUNCTION`** (tipos de parámetros). PostgreSQL puede tener múltiples sobrecargas del mismo nombre.

### DROP FUNCTION irreversible

```sql
-- WARNING: IRREVERSIBLE — no hay versión anterior registrada
-- Rollback best-effort: cuerpo de la función para restauración manual
BEGIN;
DROP FUNCTION IF EXISTS esq_credito.fn_legacy(integer);
COMMIT;

/*
  RESTAURACIÓN MANUAL si se necesita revertir:
  CREATE OR REPLACE FUNCTION esq_credito.fn_legacy(p_id integer)
  RETURNS void LANGUAGE plpgsql AS $$
  BEGIN
      -- [cuerpo de la función aquí]
  END;
  $$;
*/
```

---

## Migración de Datos

### UPDATE masivo → restaurar desde backup

```sql
-- 000-backup-tb-credito.sql
BEGIN;
CREATE TABLE IF NOT EXISTS esq_audit.tb_bkp_credito_sessionXXX AS
SELECT id_credito, estado, estado_proceso
FROM esq_credito.tb_credito
WHERE estado = 0 AND fecha_registro < '2024-01-01';
COMMIT;

-- Forward: migración
BEGIN;
UPDATE esq_credito.tb_credito
SET estado = 2
WHERE estado = 0 AND fecha_registro < '2024-01-01';
COMMIT;

-- Rollback: restaurar desde backup
BEGIN;
UPDATE esq_credito.tb_credito t
SET estado = bkp.estado
FROM esq_audit.tb_bkp_credito_sessionXXX bkp
WHERE t.id_credito = bkp.id_credito;
COMMIT;
```

### INSERT ... SELECT → DELETE por rango

```sql
-- Forward: poblar tabla destino desde origen
BEGIN;
INSERT INTO esq_credito.tb_credito_nuevo (id_credito, monto, estado)
SELECT id_credito, monto_prestamo, 1
FROM esq_credito.tb_credito_legacy
WHERE flag_migrado = 0;
COMMIT;

-- Rollback: eliminar solo los registros insertados en esta sesión
BEGIN;
DELETE FROM esq_credito.tb_credito_nuevo
WHERE id_credito IN (
    SELECT id_credito FROM esq_credito.tb_credito_legacy WHERE flag_migrado = 0
);
COMMIT;
```

---

## Inserts de datos nuevos

### INSERT simple → DELETE por clave natural

```sql
-- Forward
BEGIN;
INSERT INTO esq_sistema.tb_maestra_detalle
    (id_maestra, codprog, descripcion, valor, estado, usuario_registro, fecha_registro)
VALUES
    (1, 'EST_SOLICITUD', 'Pendiente',  1, 1, 'session_deploy', NOW()),
    (1, 'EST_SOLICITUD', 'Aprobada',   2, 1, 'session_deploy', NOW()),
    (1, 'EST_SOLICITUD', 'Rechazada',  3, 1, 'session_deploy', NOW())
ON CONFLICT DO NOTHING;
COMMIT;

-- Rollback
BEGIN;
DELETE FROM esq_sistema.tb_maestra_detalle
WHERE codprog = 'EST_SOLICITUD'
  AND valor IN (1, 2, 3)
  AND usuario_registro = 'session_deploy';
COMMIT;
```

---

## Bloque rollback de una sesión dentro de `00-ROLLBACK.sql`

```sql
-- ----------------------------------------------------------------------------
-- ROLLBACK de sessionXXX-[nombre] — revierte los cambios en orden inverso.
-- Forma parte del 00-ROLLBACK.sql cross-session del bundle.
-- ----------------------------------------------------------------------------
BEGIN;

-- Paso 4 invertido: deshacer inserts
DELETE FROM esq_sistema.tb_maestra_detalle
WHERE codprog = 'EST_SOLICITUD' AND usuario_registro = 'session_deploy';

-- Paso 3 invertido: deshacer migraciones
UPDATE esq_credito.tb_credito t
SET estado = bkp.estado
FROM esq_audit.tb_bkp_credito_sessionXXX bkp
WHERE t.id_credito = bkp.id_credito;

-- Paso 2 invertido: eliminar funciones nuevas
DROP FUNCTION IF EXISTS esq_credito.fn_calcular_cuota_v2(numeric, numeric, integer);

-- Paso 1 invertido: eliminar tablas nuevas
DROP TABLE IF EXISTS esq_credito.tb_nueva;
DROP SEQUENCE IF EXISTS esq_credito.seq_tb_nueva;

COMMIT;
```

---

## Equivalencias entre motores

| Concepto | PostgreSQL | Oracle | SQL Server |
|---|---|---|---|
| Idempotencia CREATE TABLE | `CREATE TABLE IF NOT EXISTS` | `BEGIN EXECUTE IMMEDIATE ... EXCEPTION WHEN OTHERS THEN NULL; END;` | `IF NOT EXISTS (SELECT...) CREATE TABLE` |
| Idempotencia DROP | `DROP TABLE IF EXISTS` | No nativo — usar bloque PL/SQL | `DROP TABLE IF EXISTS` (2016+) |
| Create o reemplazar función | `CREATE OR REPLACE FUNCTION` | `CREATE OR REPLACE FUNCTION` | `CREATE OR ALTER PROCEDURE` |
| Insertar sin duplicar | `ON CONFLICT DO NOTHING` | `INSERT INTO ... WHERE NOT EXISTS (SELECT 1 ...)` | `IF NOT EXISTS (SELECT 1 ...) INSERT` |
| Esquema explícito | `esq_credito.tb_x` | `schema.tb_x` | `[schema].[tb_x]` |
| Secuencias | `CREATE SEQUENCE` / `nextval(...)` | `CREATE SEQUENCE` / `.NEXTVAL` | `IDENTITY` o `SEQUENCE` (2012+) |
| Transacción | `BEGIN; ... COMMIT;` | `-- implícita; usar COMMIT;` | `BEGIN TRANSACTION; ... COMMIT;` |
| Creación condicional índice | `CREATE INDEX IF NOT EXISTS` | No nativo | `IF NOT EXISTS (SELECT...) CREATE INDEX` |

> Si el motor de destino no es PostgreSQL, indicarlo en el header del script y ajustar la sintaxis según la tabla anterior.
