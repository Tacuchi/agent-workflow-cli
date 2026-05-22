# Convenciones de Base de Datos

PostgreSQL. Todas las convenciones son snake_case en español.

## Esquemas

Prefijo `esq_` + dominio: `esq_credito`, `esq_seguridad`, `esq_motor`, `esq_contabilidad`, `esq_liquidacion`, `esq_pago`, `esq_movimiento`, `esq_reportes`, `esq_audit`, `esq_sistema`, `esq_pos`, `esq_promocion`, `esq_planeamiento`, `esq_seguro`, `esq_reclamo`, `esq_request`, `esq_kashio`.

Cada microservicio trabaja con 1-2 esquemas. Siempre referenciar el schema explícitamente en queries nativas y en `@Table`.

## Tablas

- Prefijo `tb_` + entidad: `tb_credito`, `tb_cliente`, `tb_solicitud`
- Relaciones: `tb_pago_cronograma`, `tb_usuario_sucursal`
- Cabecera/detalle: sufijo `_cab` / `_det` → `tb_lote_cab`, `tb_lote_det`

## Columnas

### Primary Keys
`id_` + entidad → `id_credito`, `id_cliente`, `id_solicitud`

### Foreign Keys
Mismo nombre que la PK referenciada → `id_cliente` en `tb_credito` apunta a `tb_cliente.id_cliente`

### Fechas
`fecha_` + acción → `fecha_registro`, `fecha_modificacion`, `fecha_solicitud`, `fecha_aprobacion`, `fecha_prestamo`

### Montos
`monto_` + concepto → `monto_prestamo`, `monto_cuota`, `monto_pagar`, `monto_desembolsado`

### Estados
- `estado` → integer genérico (1=activo, 0=inactivo)
- `estado_proceso`, `estado_aprobacion` → integer, referencia a `tb_maestra_detalle.id_maestra_detalle`

### Flags
`flag_` + concepto → `flag_extorno` (integer 0/1)

### Tipos de datos
- `integer` → IDs, estados, flags
- `numeric` → montos, tasas, porcentajes
- `character varying` → textos
- `timestamp without time zone` → fechas con hora
- `date` → fechas sin hora
- `boolean` → flags en tablas más nuevas

## Auditoría

Campos presentes en casi todas las tablas (mapeados por la clase base `Auditoria` en Java):

```
estado              integer       NOT NULL   -- 1=activo, 0=inactivo
usuario_registro    varchar       NOT NULL   -- usuario que creó
fecha_registro      timestamp     NOT NULL   -- cuándo se creó
usuario_modificacion varchar      NULL       -- usuario última modificación
fecha_modificacion  timestamp     NULL       -- cuándo se modificó
```

## Sequences

Patrón: `seq_tb_[entidad]` en el mismo esquema → `esq_credito.seq_tb_credito`

## Índices

- PK: `pk_tb_[entidad]`
- Índices: `idx_tb_[entidad]_[columna]` o `idx_[entidad]_[columnas]`

## Funciones y Stored Procedures

- Funciones: `fn_` + verbo + sustantivo → `fn_obtener_segmento`, `fn_calcular_cuota_oferta`
- Procedures: `sp_` + verbo + sustantivo → `sp_genera_credito`, `sp_recalcula_credito`
- Versionado: sufijo `_v2`, `_v3` para versiones nuevas (no se borran las anteriores)

## Patrón Maestra-Detalle

`tb_maestra` + `tb_maestra_detalle` es el catálogo centralizado. Estados, tipos de documento, tipos de crédito, etc. se referencian vía `id_maestra_detalle`. El campo `codprog` identifica el grupo funcional dentro de la maestra.

Al crear nuevos estados o tipos, siempre usar `tb_maestra_detalle` en lugar de hardcodear valores.

## Estilo de scripts SQL

Reglas de escritura para todos los scripts SQL de la sesión. Aplicar desde el primer `.sql`.

### Transacciones

```sql
BEGIN;
-- cuerpo del script
COMMIT;
```

`ROLLBACK` explícito en bloques con manejo de errores:

```sql
DO $$ BEGIN
    -- lógica
EXCEPTION WHEN OTHERS THEN
    RAISE;
END; $$;
```

### Idempotencia

| Operación | Forma idempotente |
|---|---|
| Crear tabla | `CREATE TABLE IF NOT EXISTS` |
| Eliminar objeto | `DROP ... IF EXISTS` |
| Crear/actualizar función | `CREATE OR REPLACE FUNCTION` |
| Insertar sin duplicar | `INSERT ... ON CONFLICT DO NOTHING` |
| Actualizar o insertar | `INSERT ... ON CONFLICT DO UPDATE` |

### CTEs sobre subqueries anidados

Usar CTE cuando hay ≥2 joins encadenados o cuando el mismo subquery se reutiliza:

```sql
-- Evitar:
SELECT * FROM tb_a WHERE id IN (SELECT id FROM tb_b WHERE id IN (SELECT id FROM tb_c));

-- Preferir:
WITH ids_c AS (SELECT id FROM tb_c),
     ids_b AS (SELECT b.id FROM tb_b b JOIN ids_c c ON b.id = c.id)
SELECT * FROM tb_a a JOIN ids_b b ON a.id = b.id;
```

### Comentarios ligeros

Header canónico de 4 líneas (Script / Sesion / Objeto / Alcance) entre dos líneas de iguales:

```sql
-- ============================================================================
-- Script:  003-ddl-tb-solicitud-credito.sql
-- Sesion:  s003
-- Objeto:  Crear tabla de solicitudes de crédito.
-- Alcance: Esquema esq_credito; sin migración de datos.
-- ============================================================================
```

Detalles, separadores entre secciones del cuerpo y la regla "CTEs sobre `DO`/`LOOP`" en `sql-script-organizer/SKILL.md#header-canónico`. Autor / Fecha / Motor / "Defensa futura" no van adentro del header — si el caso lo amerita, van como nota libre en una línea suelta debajo. Solo comentar el **por qué** cuando no es obvio. Nunca documentar qué hace una línea si el nombre ya lo dice.

### Sin funciones utilitarias efímeras

No crear `fn_*` o `sp_*` solo para reusar lógica dentro de un script. Usar CTE o repetir inline. Las `fn_`/`sp_` permanentes siguen la convención versionada (`_v2`, `_v3`).

### Esquema siempre explícito

```sql
-- Correcto:
SELECT * FROM esq_credito.tb_credito;

-- Incorrecto:
SELECT * FROM public.tb_credito;
SELECT * FROM tb_credito;  -- sin schema
```

### Portabilidad

PostgreSQL es el motor primario. Si el destino es otro motor, indicarlo en `Objeto:` o como nota libre debajo del header (no como campo nuevo). Ver `sql-rollback-generator/references/rollback-patterns.md` para equivalencias Oracle/SQL Server.

### Seguridad en SQL dinámico

Nunca concatenar strings en SQL dinámico. Usar `$1`/`$2` en queries parametrizados, o `%L` con `format()` en PL/pgSQL.

---

Para organización de scripts en sesiones de desarrollo: ver skill `sql-script-organizer`.
Para rollback de scripts: ver skill `sql-rollback-generator`.

## Scripts SQL

Modificaciones a BD solo mediante scripts SQL versionados en el proyecto. Nunca ejecutar INSERT/UPDATE/DELETE/DDL directamente contra la BD.
