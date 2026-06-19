---
name: export-scripts
description: "Consolida los SQL pendientes del workspace en un único bundle `docs/scripts/NNN-export-scripts-YYYY-MM-DD/` con numeración continua tras `00-ROLLBACK.sql`. Lee migraciones tipo-B (DDL/DML) desde dos fuentes: `.workflow/sessions/<folder>/SCRIPTS.sql` de N sesiones Y `docs/scripts/*.sql` standalone (excluyendo bundles previos). Ignora el tipo-A read-only (consultas de diagnóstico, no entregables). Headers SQL mínimos + README simple (3 secciones: Archivos / Aplicar / Revertir). El rollback se deriva de los forwards. Read-only/reporte: NUNCA ejecuta SQL ni commitea — el bundle es para que un humano/DBA lo aplique. Compone la capacidad `sql`. Úsalo para 'bundle SQL del release', 'preparar paso a prod', 'consolidar SQLs pendientes'. Invocado por el usuario vía `/w:export-scripts`."
---

# export-scripts — Bundle SQL consolidado, simple y directo

Consolida las migraciones SQL pendientes de N sesiones + archivos standalone en un único bundle bajo `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`, con numeración continua tras `00-ROLLBACK.sql`. **Read-only / reporte** — la IA **nunca ejecuta** el SQL; el usuario/DBA aplica el bundle manualmente.

> Familia `export-*` (la única vía artefacto→`docs/`). Recicla el espíritu del viejo `export-scripts` v5.0.0 (numeración continua, headers SQL minimal, README de 3 secciones, rollback derivado de forwards), modernizado al modelo nuevo (sin modos project/hub; `docs/scripts` en inglés). Diseño: `docs/referencias/workflow-exports/export-scripts.md`.

## Category

`docs/scripts` — **única** carpeta `docs/` que este export escribe.

## Composes

Capacidad **`sql`** (built-in default `sql`), resuelta vía `.workflow/skills.toml`. Aporta el vocabulario de categorías DDL/DML, el orden de aplicación y la derivación de rollback. Este export **no** posee esa lógica: la compone. Rebindeable u `off` por config.

## When to use

- "Bundle SQL del release", "preparar paso a prod", "consolidar SQLs pendientes".
- Antes de promover una rama a certificación / `main`.
- Tras varias sesiones `exec`/`quick` que dejaron `SCRIPTS.sql` con migraciones.

## What it does

1. Recolecta SQL del workspace desde **dos fuentes**: `SCRIPTS.sql` tipo-B de cada sesión del corpus + `docs/scripts/*.sql` standalone (excluyendo bundles previos).
2. Clasifica las sentencias por categoría canónica (DDL-TABLES / DDL-FUNCTIONS / DML / INSERTS).
3. Consolida cross-source por categoría con **numeración continua** tras `00-ROLLBACK.sql`.
4. Escribe los forwards consolidados (cada sentencia con su origen, 1 línea).
5. Deriva `00-ROLLBACK.sql` **al final**, leyendo los forwards ya escritos.
6. Escribe un `README.md` minimal (Archivos / Aplicar / Revertir).

## What it does NOT do

- **Ejecutar SQL** (invariante BD scripts-only). El bundle es entregable; lo aplica un humano/DBA.
- Commitear, mergear, push.
- Tocar `.workflow/sessions/` ni los `docs/scripts/*.sql` standalone (solo lectura).
- Escribir cualquier carpeta `docs/` que no sea `docs/scripts/` (invariante: una categoría).
- Migrar bundles previos (`docs/scripts/NNN-export-scripts-*/` quedan como histórico).
- Incluir el tipo-A read-only (consultas de diagnóstico) ni inventar SQL.
- Generar plantillas de correo, checklists de producción, listados de commits/sesiones, ni resúmenes ejecutivos en el README.

## Read-only sandbox

En plan mode **describe**, no escribe: el `NNN` resuelto, las fuentes detectadas (sesiones + standalone), las categorías con contenido, los archivos que aparecerían al root del bundle y el contenido aproximado del README. **No** ejecuta `Write`, ni `aw next-number` con efecto, ni mutaciones.

## Inputs

**CLI `agent-workflow` (alias `aw`)** — no leer paths hardcodeados:

- `aw sessions` / `aw release-data [--since sessionNNN] [--source <alias>]` — enumera el corpus de sesiones.
- `aw session-artifacts --code <NNN>` — lee `SCRIPTS.sql` de cada sesión (lazy). Si no existe → skip silencioso.
- `aw next-number docs/scripts` — numeración determinística del directorio del bundle (la resolución de la carpeta destino la maneja el CLI).

**Filesystem**:

- `docs/scripts/*.sql` standalone (solo top-level), **excluyendo** cualquier `docs/scripts/NNN-export-scripts-*/` (outputs previos de este export).

**Args** (sin lifecycle `AskUserQuestion`):

```
/w:export-scripts [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
                  [--skip-standalone] [--dry-run]
```

| Flag | Comportamiento |
|---|---|
| `--sessions NNN[,NNN]` | Filtro discreto por código (precede a `--since`) |
| `--since sessionNNN` | Solo sesiones posteriores a NNN (inclusive) |
| `--source <alias>` | Limita a una fuente (workspace multi-fuente) |
| `--skip-standalone` | Omite la lectura de `docs/scripts/*.sql` standalone |
| `--dry-run` | Reporte propositivo sin escribir archivos |

Sin args: todas las sesiones del corpus + todos los `.sql` standalone (excluyendo bundles previos). *(Si algún flag exacto difiere en el CLI runtime, ajustar al contrato real de `aw`.)*

## Flow

### Paso 1 — Recolección de fuentes SQL

**Fuente A — sesiones**: por cada sesión del corpus (`aw sessions` / `release-data` + `session-artifacts --code <NNN>`), leer `.workflow/sessions/<folder>/SCRIPTS.sql` si existe. Tomar **solo** las sentencias tipo-B (migraciones DDL/DML entregables); ignorar el tipo-A read-only (consultas de diagnóstico). Markers esperados por sentencia: `-- @category: <01-04>` + `-- @stmt: NNN-verbo-objetivo` (formato definido por la capacidad `sql`).

**Fuente B — standalone** (salvo `--skip-standalone`): listar `docs/scripts/*.sql` top-level, **excluyendo** `docs/scripts/NNN-export-scripts-*/`. Por archivo: respetar markers `@category` si los hay; si no, inferir categoría del contenido (`CREATE/ALTER TABLE`, `CREATE INDEX` → `01`; `CREATE OR REPLACE FUNCTION`/`PROCEDURE` → `02`; `UPDATE`/`DELETE` → `03`; `INSERT INTO … VALUES` → `04`). Si el filename contiene `rollback` → skip (no entra en forward).

Si la unión A + B está vacía → **abortar**: "No hay SQL pendientes en el workspace".

### Paso 2 — Numeración del bundle

`aw next-number docs/scripts` → `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`.

### Paso 3 — Clasificación y orden interno

Agrupar por categoría canónica: `01 DDL-TABLES` · `02 DDL-FUNCTIONS` · `03 DML` · `04 INSERTS`. Orden interno cronológico por origen (sesión ascendente → stmt ascendente; standalone intercalado por orden léxico del filename).

### Paso 4 — Numeración continua (sin gaps)

Asignar números secuenciales **solo a las categorías con contenido**, en el orden canónico. El primer forward siempre es `01-…`. Ej.: solo DML → `00-ROLLBACK.sql`, `01-DML.sql`; las 4 categorías → `00-ROLLBACK.sql`, `01-DDL-TABLES.sql`, `02-DDL-FUNCTIONS.sql`, `03-DML.sql`, `04-INSERTS.sql`.

### Paso 5 — Escribir forwards

Por categoría con contenido, un archivo con header de 1-2 líneas (`-- 0N-<CATEGORIA>.sql — bundle NNN-export-scripts-YYYY-MM-DD`) y, por sentencia, **un comentario de una línea** con el origen (`-- sessionXXX / stmt-id` o `-- docs/scripts/001-filename.sql`) seguido del SQL tal cual lo escribió el developer (envuelto en `BEGIN; … COMMIT;` si aplica). No replicar motivación/impacto/idempotencia ya presentes en el origen; no agregar índice de sentencias ni SELECTs de verificación inventados.

### Paso 6 — Derivar `00-ROLLBACK.sql` (al final)

Vía la capacidad `sql`, **leyendo los forwards ya escritos** (no el `SCRIPTS.sql` original): sentencias inversas en orden inverso (último→primero), bloque transaccional único, y un bloque "Cleanup irreversible" al final fuera de transacción solo si hay operaciones sin reversa automática.

### Paso 7 — Escribir `README.md` (3 secciones)

`## Archivos` (tabla: 1 fila por archivo presente) · `## Aplicar` (un `psql -f` por archivo en orden ascendente; el export no ejecuta nada) · `## Revertir` (`psql -f 00-ROLLBACK.sql` + nota si hay bloque irreversible). **Vetado**: resumen ejecutivo, tabla de sesiones, plantillas de correo, listado de commits, checklist de producción.

### Paso 8 — Escribir o reportar

Si `--dry-run`: imprimir el reporte; no escribir. Si no: `Write` del bundle. **NUNCA commitear**. Resumen al usuario: una línea por archivo escrito + ruta del bundle (sin replicar el README).

## Output location

```
docs/scripts/NNN-export-scripts-YYYY-MM-DD/
├── 00-ROLLBACK.sql       # reversa derivada de los forwards
├── 01-<CATEGORIA>.sql    # primer forward (numeración continua)
├── 02-<CATEGORIA>.sql    # …según categorías con contenido
└── README.md             # Archivos · Aplicar · Revertir
```

## Re-run

Idempotente funcional: cada invocación toma el siguiente `NNN` y **no sobrescribe** bundles previos. Para regenerar: borrar el directorio manualmente y re-invocar.

## Resources

- Design: `docs/referencias/workflow-exports/export-scripts.md` · familia: [`../README.md`](../README.md).
- Capacidad compuesta: `sql` (built-in default; ver `docs/referencias/workflow-skills/`).
- Artefacto fuente: `SCRIPTS.sql` (ver `docs/referencias/workflow-artifacts/artifacts-core/`).
- Siblings: [`../export-manuals/SKILL.md`](../export-manuals/SKILL.md) · [`../export-diagrams/SKILL.md`](../export-diagrams/SKILL.md) · [`../export-reports/SKILL.md`](../export-reports/SKILL.md).
