# SCRIPTS.sql — spec canónica del archivo

Spec del archivo único `SCRIPTS.sql` que vive en `.workflow/sessions/<folder>/` desde `sql-script-organizer` v1.0.0 (decisión F-D + G1 de session062).

## Path canónico

```
.workflow/sessions/sessionXXX-<flow>-<slug>/SCRIPTS.sql
```

- Filename: **SCRIPTS.sql** en mayúsculas (uppercase EN, igual que CHECKPOINT.md, TASKS.md, etc.).
- Encoding: UTF-8 sin BOM.
- Line endings: LF.

## Estructura del archivo

```sql
-- ============================================================================
-- SCRIPTS.sql — sessionXXX-<flow>-<slug>
-- ============================================================================
-- Consolida todas las sentencias SQL aplicadas durante esta sesión.
-- Markers @category y @stmt los lee /agent-workflow:export-scripts para separar el bundle.
-- ----------------------------------------------------------------------------

BEGIN;

-- @category: 01-ddl-tablas
-- @stmt: 001-crear-tabla-usuarios
CREATE TABLE IF NOT EXISTS esq_credito.tb_usuarios (
  id          BIGSERIAL PRIMARY KEY,
  cod_usuario VARCHAR(20) NOT NULL UNIQUE,
  estado      CHAR(1) NOT NULL DEFAULT 'A'
);

-- @category: 02-ddl-funciones
-- @stmt: 002-fn-obtener-usuario
CREATE OR REPLACE FUNCTION esq_credito.fn_obtener_usuario(p_cod VARCHAR)
RETURNS TABLE(...)
LANGUAGE plpgsql AS $$
BEGIN
  ...
END;
$$;

-- @category: 04-inserts
-- @stmt: 003-insert-usuarios-seed
INSERT INTO esq_credito.tb_usuarios (cod_usuario, estado)
VALUES ('admin', 'A'), ('soporte', 'A')
ON CONFLICT (cod_usuario) DO NOTHING;

COMMIT;
```

## Markers

### `@category` — obligatorio

Clasifica la sentencia para la separación post-hoc en el bundle export-scripts:

| Marker | Patrones de detección |
|---|---|
| `01-ddl-tablas` | `CREATE TABLE`, `DROP TABLE`, `ALTER TABLE`, `CREATE INDEX`, `CREATE SEQUENCE` |
| `02-ddl-funciones` | `CREATE [OR REPLACE] FUNCTION`, `CREATE [OR REPLACE] PROCEDURE`, `DROP FUNCTION`, `DROP PROCEDURE` |
| `03-migracion` | `UPDATE`, `INSERT ... SELECT ...`, `DELETE` sobre datos existentes |
| `04-inserts` | `INSERT INTO ... VALUES`, seeds de catálogos, datos de configuración inicial |

Valor exacto, lowercase. Una categoría por marker (no listas).

### `@stmt` — obligatorio

Slug determinístico para que `export-scripts` derive el filename del archivo separado:

- Formato: `NNN-verbo-objetivo` (3 dígitos + kebab-case, ≤5 palabras útiles).
- Único dentro del SCRIPTS.sql.
- Orden cronológico recomendado pero NO requerido (export-scripts ordena por categoría al separar).
- Ejemplo: `001-crear-tabla-usuarios`, `015-poblar-catalogo-roles`.

### `@objeto` y `@alcance` — opcionales

Si la sentencia merece doc:

```sql
-- @category: 01-ddl-tablas
-- @stmt: 001-crear-tabla-usuarios
-- @objeto: Tabla central de identidades. UNIQUE en cod_usuario.
-- @alcance: solo esq_credito; trigger de auditoría en sesión separada.
CREATE TABLE ...
```

`export-scripts` usa estos al generar el header canónico del archivo separado.

## Reglas de idempotencia

Cada sentencia debe ser idempotente:

- **DDL**: `CREATE TABLE IF NOT EXISTS`, `DROP ... IF EXISTS`, `CREATE OR REPLACE`.
- **Inserts**: `ON CONFLICT (...) DO NOTHING` o `ON CONFLICT DO UPDATE`.
- **Migraciones de datos**: backup en `esq_audit.tb_bkp_<x>_sNNN` antes de UPDATE/DELETE masivo; ver `sql-rollback-generator` para política.
- **Funciones**: `CREATE OR REPLACE FUNCTION` siempre.

Re-ejecutar el archivo completo no debe fallar.

## Transaccionalidad

`BEGIN;` al inicio del archivo, `COMMIT;` al final. **Una sola transacción** global por sesión.

Si una sentencia requiere transacción aparte (ej. `CREATE INDEX CONCURRENTLY`), comentar con `-- @transaction: none` y mover fuera del BEGIN/COMMIT global. Casos raros; documentar.

## Concatenación con sessions previas

`SCRIPTS.sql` representa **lo que esta sesión cambia**. NO incluye:
- Scripts heredados de sesiones previas (esos ya viven en sus propios SCRIPTS.sql).
- Scripts del baseline del workspace.

`export-scripts` con `--sessions NNN,MMM` combina varios SCRIPTS.sql en el bundle final.

## Edición durante la sesión

Permitido:
- Append de nuevas sentencias al final (antes del COMMIT).
- Editar sentencias existentes para corregir (preservar `@stmt` del statement; el slug es estable).
- Eliminar sentencias descartadas (no preservar history en backlog SQL; usar `BACKLOG.md` para anotar lo descartado).

No permitido:
- Reordenar sentencias por estética (orden = cronológico). Si el orden de ejecución importa, dejarlo al separador post-hoc.
- Mezclar 2 sentencias en un solo bloque marker (un `@stmt` = una sentencia).

## Verificación pre-cierre

Antes de cerrar la sesión:
1. `agent-workflow session-artifacts --code NNN` reporta `scripts_sql_present: true` (si esperabas SQL).
2. El archivo abre con `BEGIN;` y cierra con `COMMIT;`.
3. Cada sentencia tiene `@category` y `@stmt`.
4. Re-ejecutar el archivo en cert no falla (manual; el AI nunca ejecuta).

## Migración desde layout legacy

Si la sesión tiene `scripts/01-ddl-tablas/*.sql` etc. (layout pre-v1.0.0), invocar `/agent-workflow:migrate --upgrade-topology`. El skill `migrate` lee los archivos en orden 01→04, concatena en SCRIPTS.sql con markers `@category` derivado de la carpeta y `@stmt` del filename original. Idempotente: si ya existe SCRIPTS.sql, no sobreescribe.

Ver `agent-workflow/skills/migrate/SKILL.md` capability 11.
