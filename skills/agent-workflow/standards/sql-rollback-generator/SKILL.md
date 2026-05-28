---
name: sql-rollback-generator
description: "Genera `00-ROLLBACK.sql` único al root del bundle, leyendo los forwards ya escritos por `/agent-workflow:export-scripts` v5.0.0+. v3.0.0 BREAKING (session103): lee los archivos `NN-*.sql` consolidados (no `SCRIPTS.sql` por sesión); headers SQL mínimos (1-2 líneas); orden inverso del último forward al primero. Bloque `BEGIN; ... COMMIT;` único + bloque opcional `Fase 5 — Cleanup irreversible` después del COMMIT para operaciones no revertibles automáticamente (DROP COLUMN, TRUNCATE, ALTER COLUMN TYPE con pérdida). NO genera companions `.rollback.sql` ni sub-carpetas per-sesión."
version: 3.0.0
---

# SQL Rollback Generator — `00-ROLLBACK.sql` único, derivado de forwards

Genera el rollback **derivado de los forwards consolidados**. Invocado por `/agent-workflow:export-scripts` v5.0.0+ después de escribir los archivos `NN-*.sql` del bundle.

> v3.0.0 (session103) — lee los forwards ya escritos en vez de `SCRIPTS.sql` original. Headers minimal (1-2 líneas). Sin verbosidad de motivación/impacto.

## When to use

- **Disparado por `/agent-workflow:export-scripts`** después del Paso 5 (forwards escritos).
- NL del usuario: "generar rollback", "script de reversa".
- En plan-mode: simular el rollback de un cambio específico sin escribir archivos.

## Sandbox read-only

`../session/references/sandbox-readonly-rules.md`. Plan describe estructura del rollback sin escribir archivos.

## Principios (v3.0.0)

- **Input**: los archivos `NN-*.sql` forward ya escritos en el bundle (no `SCRIPTS.sql` original).
- **Output único**: `<bundle-root>/00-ROLLBACK.sql`.
- **Orden interno**: inverso del último forward al primero — si el bundle es `01-DDL-TABLES.sql, 02-DML.sql, 03-INSERTS.sql`, el rollback procesa `03 → 02 → 01`.
- **Headers mínimos**: 2 líneas para el archivo, 1 línea por sentencia.
- **Bloque transaccional único** `BEGIN; ... COMMIT;`.
- **Bloque Fase 5** después del COMMIT (solo si hay irreversibles): operaciones que no se pueden revertir automáticamente.
- **Idempotencia obligatoria**: `DROP ... IF EXISTS`, `CREATE OR REPLACE`.

## Estructura del `00-ROLLBACK.sql`

Header del archivo (2 líneas):

```sql
-- 00-ROLLBACK.sql — bundle NNN-export-scripts-YYYY-MM-DD
-- Generado por agent-workflow sql-rollback-generator v3.0.0
```

Sub-bloque por sentencia (1 línea de comentario + SQL):

```sql
-- Revierte: sessionXXX / stmt-id (forward: 02-DML.sql)
ALTER TABLE esq_.tb_x ALTER COLUMN col_y TYPE varchar(80);
```

Bloque Fase 5 (al final, fuera de la transacción — solo si hay irreversibles):

```sql
COMMIT;

-- Fase 5 — Cleanup irreversible (manual)
-- sessionXXX / UPDATE esq_.tb_y sin backup automático: completar valores previos manualmente.
-- sessionYYY / TRUNCATE esq_.tb_z: pérdida total, sin reversa.
```

Sin templates `BEGIN; UPDATE … COMMIT;` comentados ni explicaciones largas. Solo una línea por irreversible identificando origen y razón.

## Estrategias por tipo de operación

### DDL de tablas

| Forward | Rollback |
|---|---|
| `CREATE TABLE IF NOT EXISTS esq_.tb_x` | `DROP TABLE IF EXISTS esq_.tb_x;` |
| `ALTER TABLE tb_x ADD COLUMN col_y ...` | `ALTER TABLE tb_x DROP COLUMN IF EXISTS col_y;` |
| `CREATE INDEX idx_... ON tb_x(col)` | `DROP INDEX IF EXISTS idx_...;` |
| `CREATE SEQUENCE esq_.seq_tb_x` | `DROP SEQUENCE IF EXISTS esq_.seq_tb_x;` |
| `ALTER COLUMN col TYPE varchar(255)` (widen) | `ALTER COLUMN col TYPE varchar(80);` (con nota Fase 5 si datos exceden 80) |
| `DROP TABLE tb_x` | **Irreversible** → Fase 5 (requiere backup previo a `esq_audit`) |

### DDL de funciones

| Forward | Rollback |
|---|---|
| `CREATE OR REPLACE FUNCTION fn_x(...)` | `DROP FUNCTION IF EXISTS fn_x(<firma>);` |
| `DROP FUNCTION fn_x` | **Irreversible** → Fase 5 |

### Migración de datos (UPDATE / DELETE)

- Si el forward incluye backup explícito en `esq_audit.tb_bkp_*_sNNN` (visible en el forward consolidado): rollback `UPDATE … FROM esq_audit.tb_bkp_…`.
- Si NO hay backup automático en el forward: **Fase 5**, con nota de una línea ("`sessionXXX` / UPDATE sin backup: completar valores previos manualmente").

### Inserts

```sql
DELETE FROM esq_.tb_maestras WHERE campo_identificador IN (<lista>);
```

Usar claves naturales o rango de IDs conocido — nunca DELETE sin WHERE.

### Irreversibles → Fase 5

- `TRUNCATE TABLE`
- `DROP COLUMN` sin respaldo previo
- `DROP TABLE` sin respaldo previo
- `ALTER COLUMN TYPE` con pérdida (varchar widen → narrow si datos exceden)
- Cascadas destructivas (`DROP ... CASCADE`)
- `DELETE`/`UPDATE` sin respaldo en `esq_audit`

Cada uno aparece como **una sola línea** en la Fase 5, identificando origen + razón. Sin templates comentados ni explicaciones extensas.

## Proceso (v3.0.0)

1. Leer los archivos `NN-*.sql` forward escritos en el bundle (no `SCRIPTS.sql` original).
2. Parsear cada bloque (un BEGIN/COMMIT por sentencia, identificada por `-- sessionXXX / stmt-id`).
3. Para cada sentencia forward, clasificar el tipo y seleccionar estrategia (DDL / migración / inserts / irreversible).
4. Generar el bloque rollback correspondiente (header de 1 línea + SQL inverso).
5. Identificar irreversibles → moverlos a la Fase 5 al final.
6. Componer el `00-ROLLBACK.sql` único con orden inverso (último forward → primero, dentro de cada uno última sentencia → primera).
7. Escribir el archivo al root del bundle.

## Notas de portabilidad

PostgreSQL como motor primario. Para otros motores, ajustar sintaxis idempotente:

| Concepto | PostgreSQL | Oracle | SQL Server |
|---|---|---|---|
| Drop idempotente | `DROP … IF EXISTS` | `DROP … (no IF EXISTS)` | `DROP … IF EXISTS` |
| Recrear función | `CREATE OR REPLACE FUNCTION` | `CREATE OR REPLACE FUNCTION` | `CREATE OR ALTER PROCEDURE` |

Si el destino no es Postgres, indicarlo en el header del archivo (línea adicional opcional).

## Layout (post-export-scripts v5.0.0)

```
<docs>/scripts/NNN-export-scripts-YYYY-MM-DD/
└── 00-ROLLBACK.sql                # este skill lo genera
```

Para context: el bundle plano del export incluye además `01-…`, `02-…`, etc. (forwards en orden ascendente, numeración continua) + `README.md` — todos al root, generados por `export-scripts`.

**No se generan** desde v2.0.0:

- Companions `.rollback.sql` por sentencia.
- Sub-carpeta `<session>/rollback/` per-sesión.
- Archivo `rollback-global.sql` separado.

## Integración con otros skills

- **`export-scripts`** v5.0.0+ — único invocador activo; pasa los forwards ya escritos.
- **`sql-script-organizer`** — companion que organiza el `SCRIPTS.sql` por sesión.
- **`coding-standards`** — reglas de estilo SQL.
- **`session`** — este skill NO se invoca al cerrar una sesión individual; sólo desde export-scripts.

## Histórico de versiones

- **v3.0.0** (session103, 2026-05-28) — lee forwards ya escritos en vez de `SCRIPTS.sql` original; headers SQL minimal; Fase 5 sin templates comentados.
- **v2.0.0** (session093) — `00-ROLLBACK.sql` único cross-session leyendo `SCRIPTS.sql`. Histórico.
- **v1.0.0** y anteriores — companions `.rollback.sql` + per-sesión rollback. Histórico.

## Recursos adicionales

- **`references/rollback-patterns.md`** — recetas completas con ejemplos SQL.
- **`references/irreversible-checklist.md`** — lista de irreversibles y protocolo.
- **`references/release-rollback.md`** — algoritmos legacy (modo release, deprecation Fase 1).
