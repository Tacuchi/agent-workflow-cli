---
name: sql-script-organizer
description: "Mantiene el archivo único SCRIPTS.sql por sesión (uppercase EN canon, F-D session062), aplica estilo del proyecto (BEGIN/COMMIT, idempotencia, schema explícito), markers @category (01-ddl-tablas, 02-ddl-funciones, 03-migracion, 04-inserts) y @stmt por sentencia. La separación 01-04 + generación de rollbacks ocurre post-hoc en /agent-workflow:export-scripts (no durante exec). BREAKING desde v1.0.0: reemplaza el layout scripts/01-04/* + .rollback.sql per archivo (2N+1) por SCRIPTS.sql único. Layouts legacy se migran con /agent-workflow:migrate --upgrade-topology."
version: 1.0.0
---

# SQL Script Organizer

Organización, estilo y graduación de scripts SQL dentro del flujo de sesiones.

## Regla cero — read/write filesystem only

Este skill **organiza, renumera, escribe diffs y prepara el bundle** en disco. **Nunca ejecuta SQL** contra `<mcp-cert>`/`<mcp-prod>` ni ningún otro destino. La aplicación del bundle (DDL, migraciones, inserts) la realiza el **usuario** manualmente, fuera del scope de este skill. Si durante el flujo aparece tentación de "verificar aplicando" — refusar y pedir al usuario que ejecute.

## When to use

- Cuando existan ≥2 archivos `.sql` en la sesión y necesiten ordenarse para entrega.
- **Antes de escribir un nuevo `.sql`** — para elegir categoría correcta y aplicar estilo desde el inicio.
- Al llegar a Fase 5 (Cierre) con scripts SQL pendientes de graduar.
- NL: "unificar", "reorganizar", "preparar bundle de scripts", "listos para prod".
- Al renumerar o reclasificar scripts durante la sesión.

## Sandbox read-only

`../session/references/sandbox-readonly-rules.md`. Plan describe clasificación, renumeración y orden propuestos (sin crear ni mover `.sql`).

## Staging durante la sesión (v1.0.0 — BREAKING)

**Archivo único** en la raíz de la sesión:

```
.workflow/sessions/sessionXXX-nombre/
└── SCRIPTS.sql           (consolidado de todas las sentencias de la sesión)
```

Spec completa: ver [`references/scripts-sql-format.md`](references/scripts-sql-format.md).

**Cada sentencia** se appendea al SCRIPTS.sql con un par de markers en comentarios:

```sql
-- @category: 01-ddl-tablas
-- @stmt: 01-crear-tabla-usuarios
CREATE TABLE IF NOT EXISTS esq_credito.tb_usuarios (
  ...
);
```

- `@category` clasifica la sentencia (4 valores canónicos, ver tabla abajo).
- `@stmt` da el slug determinístico (`NN-verbo-objetivo`). Sirve para que `export-scripts` derive el filename al separar.
- Orden cronológico dentro del archivo = orden en que se appendea. `export-scripts` resuelve el orden de ejecución final por categoría (01 → 02 → 03 → 04).
- `BEGIN;` global al inicio del archivo, `COMMIT;` al final. Cada sentencia individual NO trae su propio BEGIN/COMMIT (la separación post-hoc los agrega por archivo).

> **Sin .rollback.sql per archivo durante exec**. Los rollbacks se generan post-hoc al correr `/agent-workflow:export-scripts` (ver `sql-rollback-generator` v1.0.0).

## Migración desde layout legacy

Sesiones creadas con `sql-script-organizer` v0.x usan layout antiguo:

```
.workflow/sessions/sessionXXX-nombre/scripts/
├── 01-ddl-tablas/
│   └── 001-crear-tabla.sql
├── 02-ddl-funciones/
│   └── 001-crear-fn.sql
└── ...
```

Para migrar: `/agent-workflow:migrate --upgrade-topology`. El skill `migrate` detecta el layout legacy y consolida en `SCRIPTS.sql` preservando order + agregando markers. Ver `agent-workflow/skills/migrate/SKILL.md` capability 11.

`/agent-workflow:export-scripts` aborta si detecta layout legacy sin migrar. NO consume sesiones mixtas.

## Las 4 categorías (markers `@category`)

| Marker | Patrones de detección |
|---|---|
| `01-ddl-tablas` | `CREATE TABLE`, `DROP TABLE`, `ALTER TABLE`, `CREATE INDEX`, `CREATE SEQUENCE` |
| `02-ddl-funciones` | `CREATE [OR REPLACE] FUNCTION`, `CREATE [OR REPLACE] PROCEDURE`, `DROP FUNCTION`, `DROP PROCEDURE` |
| `03-migracion` | `UPDATE`, `INSERT ... SELECT ...`, `DELETE` sobre datos existentes, transformaciones de columnas |
| `04-inserts` | `INSERT INTO ... VALUES`, seeds de catálogos, `tb_maestra_detalle`, datos de configuración inicial |

**Orden de ejecución obligatorio**: 01 → 02 → 03 → 04. El archivo SCRIPTS.sql puede mezclar categorías cronológicamente; `export-scripts` ordena al bundle final.

Patrones detallados y edge cases en `references/categorization-rules.md`.

## Reglas de estilo SQL

Cumplir `coding-standards/references/database-conventions.md#estilo-de-scripts-sql`:

- `BEGIN;` al inicio, `COMMIT;` al final.
- Idempotencia: `CREATE TABLE IF NOT EXISTS`, `DROP ... IF EXISTS`, `CREATE OR REPLACE`, `ON CONFLICT`.
- Cuerpo: preferir `WITH ... AS` (CTEs encadenadas) sobre subqueries anidados y sobre `DO $$ ... LOOP ... END $$`. Ver "Cuerpo: CTEs sobre DO/LOOP" abajo.
- Header canónico de 4 líneas (Script / Sesion / Objeto / Alcance). Ver "Header canónico" abajo.
- Separador entre secciones: una línea de comentario envuelta por guiones. Ver "Separadores entre secciones" abajo.
- Nunca crear `fn_*`/`sp_*` para reusar lógica exclusiva de un script; usar CTE o inline.
- Schema siempre explícito (`esq_credito.tb_x`, nunca `public.`).

### Header canónico

Bloque único al inicio del script, entre dos líneas de iguales:

```sql
-- ============================================================================
-- Script:  NNN-tipo-objetivo.sql
-- Sesion:  sNNN
-- Objeto:  <qué hace, 1-2 líneas>
-- Alcance: <filtros y boundaries del cambio, 1 línea>
-- ============================================================================
```

- Solo 4 campos: `Script`, `Sesion`, `Objeto`, `Alcance`.
- `Sesion` puede listar varias sesiones cuando el script trazó historia (ej. `s078 → s080 (fix UNIQUE) → s082 (simplificado)`).
- Autor / Fecha / "Defensa futura" / notas largas **NO** van dentro del header. Si el contexto lo amerita, van como bloque libre debajo del header (separado por una línea en blanco). Default: no se generan.
- Si el motor no es Postgres, indicarlo en `Objeto:` o como nota libre debajo, no como campo del header.

### Separadores entre secciones

Cada sección del cuerpo se introduce con una línea de comentario corta envuelta por guiones seguidos:

```sql
-- ----------------------------------------------------------------------------
-- N. Descripción corta de qué hace este bloque.
-- ----------------------------------------------------------------------------
```

- Sin cajas dobles (`====` queda solo para el header).
- Si el script tiene una sola sección, omitir separadores.
- No partir un bloque corto solo por estética — los separadores marcan flujos lógicos, no líneas.

### Cuerpo: CTEs sobre DO/LOOP

- Default: una transformación = `WITH ... AS` con CTEs encadenadas + un `INSERT/UPDATE/DELETE` final que las consume.
- Evitar `DO $$ DECLARE ... FOR ... LOOP ... END $$` cuando el mismo resultado se logra declarativamente. Es código que el lector tiene que mentalizar fila a fila; el SQL declarativo es más fácil de auditar y revertir.
- Excepción permitida: descubrimiento dinámico de objetos (FKs, columnas, constraints, secuencias) que no se puede expresar en SQL declarativo. En ese caso documentar el motivo en `Objeto:` del header (ej. `Objeto: ... cascadea a hijas via FKs detectadas dinámicamente.`).

## Proceso de mantenimiento del SCRIPTS.sql (v1.0.0)

1. **Detectar la categoría** del cambio a aplicar siguiendo la tabla de markers.
2. **Verificar idempotencia** del statement (CREATE OR REPLACE, IF EXISTS, ON CONFLICT, etc.).
3. **Append** al `SCRIPTS.sql` con par de markers (`@category` + `@stmt`).
4. **Style check** — el statement debe cumplir el header canónico, CTEs sobre DO/LOOP, schema explícito.
5. **NO mover ni renumerar** archivos individuales (solo hay un SCRIPTS.sql).
6. **NO generar `.rollback.sql`** durante exec (rollback se genera al exportar).

El usuario revisa el SCRIPTS.sql periódicamente; la separación 01-04 final y la verificación de dependencias cruzadas la hace `/agent-workflow:export-scripts` post-hoc.

## Layout del bundle (post-export-scripts v4.0.0)

`/agent-workflow:export-scripts` v4.0.0+ produce el bundle al ejecutarse, no este skill. Layout plano cross-session al root:

```
<docs>/scripts/NNN-export-scripts-YYYY-MM-DD/
├── 00-ROLLBACK.sql                            (único rollback cross-session — sql-rollback-generator v2.0.0)
├── 01-DDL-TABLES.sql                          (consolidado cross-session, skip si vacío)
├── 02-DDL-FUNCTIONS.sql                       (idem)
├── 03-DML.sql                                 (UPDATE/DELETE/migración + backup en esq_audit cuando aplica)
├── 04-INSERTS.sql                             (idem)
├── README.md                                  (único informe + índice + how-to-execute)
└── por-tema/                                  (opt-in — capa adicional encima del root)
    └── tema-<slug>/01-04-*.sql
```

Sentencias individuales del `SCRIPTS.sql` per-sesión se consolidan **cross-session** al archivo de su categoría — no se crea sub-carpeta por sesión.

Layout **v3.x** (`por-sesion/<sessionXXX>/01-04/*.sql + .rollback.sql` companions + per-sesión `rollback/`) ya **no se genera** desde v4.0.0. Bundles ya escritos con v3.x quedan como histórico.

Layout **legacy** pre-SCRIPTS.sql (`scripts/01-04/*.sql + .rollback.sql` directo en sesión) tampoco se genera; sesiones nuevas usan SCRIPTS.sql. Layouts legacy en sesiones cerradas se migran con `/agent-workflow:migrate --upgrade-topology`.

## Graduación al cierre (vía `/agent-workflow:release`)

Los scripts viven en la sesión durante execution: `.workflow/sessions/<folder>/scripts/`. La graduación a `docs/scripts/NNN-sessionXXX-<slug>/` la hace **`/agent-workflow:release` exclusivamente** (DEC-003) — único disparador de `kind=script`. Sesiones individuales NO invocan `agent-workflow graduate --kind script` directamente.

Destino al graduar (DEC-002, vía release):
- **hub mode** → `<hub>/docs/scripts/NNN-sessionXXX-<slug>/`.
- **project mode** → `<cwd>/docs/scripts/NNN-sessionXXX-<slug>/`.

`NNN` = siguiente correlativo en `docs/scripts/` (`agent-workflow next-number docs/scripts`). Release registra la ruta en `.workflow/HISTORY.md`.

## Modo release (cross-session + por tema)

Cuando `release` o `release-scripts` invocan este skill, aplica modo consolidación cross-session o modo por tema. Ambos comparten la clasificación 01→04 pero cambian el layout y la transaccionalidad.

Procedimiento completo (entrada, proceso paso a paso, layout destino, formato del consolidado, qué NO hacer) en **`references/consolidation-cross-session.md`**.

## Integración con otros skills

- **`sql-rollback-generator`** v1.0.0+ — **on-export**: ya NO genera rollbacks durante exec. La generación ocurre cuando `export-scripts` corre.
- **`export-scripts`** v3.0.0+ — consume `SCRIPTS.sql` per sesión, separa en 01-04 y delega a `sql-rollback-generator` para los rollbacks. Aborta si detecta layout legacy.
- **`migrate`** v1.3.0+ — capability 11: convierte layouts legacy `scripts/01-04/*.sql` → `SCRIPTS.sql` consolidado.
- **`coding-standards`** — fuente de las reglas de estilo (`database-conventions.md`).
- **`session`** — Fase execution invoca este skill al primer change SQL; Fase closure no necesita acción adicional.

## Ejemplo de header simplificado

Antes (estilo viejo, evitar):

```sql
-- ============================================================================
-- Script: 020-dml-normalizar-codusuario-uppercase.sql
-- Sesion: s078 (creado) → s079 (formato iniciales) → s080 (fix UNIQUE)
-- Fecha:  2026-04-29
-- Autor:  Jesus Loayza (con asistencia AI)
-- Objeto: Renombra esq_x.tb_x.cod a MAYUSCULAS con sufijo numerico para
--         colisiones internas. Cascadea a hijas via FKs detectadas dinamicamente.
-- Alcance: SOLO usuarios id_tipo = 'CORE' con tb_persona valida.
-- Defensa futura: AuthSvc.generarCod en mscore-mantenimiento.
-- ============================================================================
-- Si el INSERT al mapping rebota con UNIQUE, significa que ...
-- ============================================================================
```

Después (estilo canónico):

```sql
-- ============================================================================
-- Script:  020-dml-normalizar-codusuario-uppercase.sql
-- Sesion:  s078 → s080 (fix UNIQUE) → s082 (simplificado one-shot, sin trigger)
-- Objeto:  Renombra esq_x.tb_x.cod a MAYUSCULAS con sufijo numérico para
--          colisiones. Cascadea a hijas vía FKs detectadas dinámicamente.
-- Alcance: SOLO usuarios id_tipo = 'CORE' con tb_persona válida.
-- ============================================================================
```

Y en el cuerpo, las secciones se separan así:

```sql
-- ----------------------------------------------------------------------------
-- 1. Mapping old → new para CORE con persona válida.
-- ----------------------------------------------------------------------------
WITH bases AS (
    SELECT u.id, u.cod AS old_code,
           UPPER(LEFT(TRIM(p.nombres), 1) || REPLACE(TRIM(p.apellido_paterno), ' ', '')) AS base_code
      FROM esq_x.tb_x u
      JOIN esq_x.tb_persona p ON p.id_persona = u.id_persona
     WHERE u.id_tipo = 'CORE'
),
mapped AS ( ... )
INSERT INTO _cod_map (id, old_code, new_code) SELECT id, old_code, new_code FROM mapped;
```

## Recursos adicionales

- **`references/categorization-rules.md`** — patrones detallados, edge cases, scripts mixtos.
- **`references/bundle-readme-template.md`** — plantilla para `scripts/bundle/README.md`.
- **`references/consolidation-cross-session.md`** — modo release (cross-session + por tema).
