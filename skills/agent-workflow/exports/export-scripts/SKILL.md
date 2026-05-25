---
name: export-scripts
description: "Consolida N sesiones del workspace + `docs/scripts/` ya graduados en un paquete de paso a producción bajo `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`. v4.0.0 BREAKING (session093): layout plano cross-session al root del bundle — `00-ROLLBACK.sql`, `01-DDL-TABLES.sql`, `02-DDL-FUNCTIONS.sql`, `03-DML.sql`, `04-INSERTS.sql`, `README.md` único. Sin `por-sesion/`, sin `<file>.rollback.sql` companions, sin per-sesión `rollback/`, sin `manifest.md`/`ORDER.md` separados (absorbidos por `README.md`). Lee `SCRIPTS.sql` único per sesión (uppercase EN, G1), parsea markers `@category`/`@stmt` y consolida cross-session. Delega `sql-rollback-generator` v2.0.0+ on-export para generar `00-ROLLBACK.sql` único encadenado 04→01. Aborta con sugerencia de `/agent-workflow:migrate --upgrade-topology` si detecta layout legacy `scripts/01-04/*.sql` (G2). `--themes` opt-in: capa adicional `por-tema/<slug>/` encima del root plano. Read-only / reporte — no ejecuta commits ni SQL. Invocado sólo vía `/agent-workflow:export-scripts`."
version: 4.0.0
---

# Export Scripts — Bundle SQL + informe consolidado desde N sesiones

Consolida N sesiones cerradas (más opcionalmente activas) en un único output dir `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`. Es **solo lectura/reporte**: el usuario sigue ejecutando scripts, correos, merges y commits manualmente.

> Último comando de la familia `/agent-workflow:export-*`. Refactor que consolida `/agent-workflow:release` v2.0.0 + `/agent-workflow:release-scripts` v2.0.0. Propuesta del modelo: `docs/conclusiones/007-export-commands-family.md`. Plan de deprecación: ver `references/deprecation-plan.md`.

## Excepción session-aware

Como `release` y `release-scripts` legacy, este skill requiere conocimiento del lifecycle. **No crea ni modifica sesiones**. Si el workspace no tiene sesiones cerradas → abortar y sugerir `/agent-workflow:session create`.

**Solo formato actual (v0.9+)**: sesiones legacy abortan; migrar con `/agent-workflow:migrate --upgrade-topology`.

**Consumo de CLI `agent-workflow`** (no leer paths hardcodeados):

- `agent-workflow release-data [--since sessionNNN] [--source alias] [--include-graduated]` — dump consolidado de sesiones + bundles graduados.
- `agent-workflow session-artifacts --code <NNN>` — lectura lazy de OBJECTIVE/TASKS/DECISIONS/scripts (con fallback bilingual a OBJETIVO/TASKS/DECISIONES legacy).
- `agent-workflow code-scan` — escaneo determinístico (built-in + opcionalmente `--patterns-file`).
- `agent-workflow next-number docs/scripts` — numeración determinística del output dir.
- Resolución hub-aware de `docs/scripts/` la maneja el CLI internamente.

## When to use

- "Bundle SQL del release", "informe de release", "qué falta para producción", "preparar paso a prod".
- Sesiones cerradas a consolidar para promover a `certificacion` o `main`.
- Re-generar tras agregar nuevas sesiones desde el último export.
- Antes de go/no-go meeting.

## Qué hace este skill (v4.0.0)

1. Lee sesiones (`.workflow/sessions/`) recolectando `SCRIPTS.sql` (uppercase EN canónico) de **todas** las sesiones del workspace (filtrables por `--since` y `--source`).
2. Escanea código fuente buscando patrones que no deben llegar a producción.
3. Consulta git (rama vs `certificacion`, commits pendientes, archivos sin commit).
4. **Consolida cross-session por categoría al root** del bundle: `01-DDL-TABLES.sql`, `02-DDL-FUNCTIONS.sql`, `03-DML.sql`, `04-INSERTS.sql` (skip silencioso si la categoría está vacía).
5. Delega a `sql-rollback-generator` v2.0.0+ para generar **`00-ROLLBACK.sql` único** cross-session (encadenado 04→01).
6. Detecta acciones manuales requeridas (matriz heredada de `release`).
7. **Theme detection (opt-in)**: si hay `## Temas` en algún OBJECTIVE o `--themes slug1,slug2` declarado, genera `por-tema/<slug>/` como capa adicional encima del root plano (NO duplica rollback).
8. Aplica validations V1-V6 (`references/validations.md`).
9. Si pasa: escribe el bundle completo bajo `docs/scripts/NNN-export-scripts-YYYY-MM-DD/` con el layout plano + `README.md` único.

## Qué NO hace

- Ejecutar commits, merges, push (ver `agent-workflow:commits-policy`).
- Ejecutar scripts SQL contra BD.
- Enviar correos ni crear PRs.
- Modificar código fuente (los hallazgos del escaneo son recomendaciones).
- Tocar `.workflow/sessions/` ni artefactos individuales.
- Migrar histórico de `docs/release/` ni bundles `docs/scripts/00X-*` generados por export-scripts v3.x (layout previo, no se reescribe).
- **Escribir `por-sesion/`** (eliminado en v4.0.0): la consolidación es cross-session al root.
- **Escribir `<file>.rollback.sql` companions** (eliminado en v4.0.0): el rollback canónico es `00-ROLLBACK.sql` único.
- **Escribir `<session>/rollback/`** (eliminado en v4.0.0): no hay per-sesión rollback.
- **Escribir `manifest.md` separado** (eliminado en v4.0.0): absorbido por `README.md`.
- **Escribir `ORDER.md` separado** (eliminado en v4.0.0): absorbido por §4 del `README.md`.
- **Escribir `rollback-global.sql` separado** (eliminado en v4.0.0): el rollback es `00-ROLLBACK.sql` único.

## Sandbox read-only

`../session/references/sandbox-readonly-rules.md`. Plan describe NNN, sesiones incluidas, secciones del `README.md`, hallazgos esperados, contenido del bundle plano cross-session y (opcionalmente) capa `por-tema/`.

## Estilo de comunicación

`../session/references/communication-style.md`. Confirmación antes de crear el bundle SQL consolidado; si declina, ejecutar como `--dry-run` (sólo reporte propositivo).

## Entrada

```
/agent-workflow:export-scripts [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
                    [--themes slug1,slug2|infer] [--keep-parts]
                    [--skip-code-scan] [--dry-run]
```

| Flag | Comportamiento |
|---|---|
| `--sessions NNN[,NNN]` | Filtro discreto por código. Toma precedencia sobre `--since` (si ambos se pasan, `--since` se ignora con warning) |
| `--since sessionNNN` | Incluye sólo sesiones posteriores a NNN (inclusive). Ignorado si `--sessions` presente |
| `--source <alias>` | Limita a una fuente específica (hub mode) |
| `--themes slug1,slug2` | Genera `por-tema/` con los slugs declarados |
| `--themes infer` | Inferencia LLM de temas (mismo flujo que release-scripts legacy) |
| `--keep-parts` | Preserva `por-tema/<slug>/parts/<categoria>/*.sql` con scripts individuales |
| `--skip-code-scan` | Omite el escaneo de código fuente |
| `--dry-run` | Reporte propositivo sin escribir archivos |

Sin args: incluye todas las sesiones cerradas, sin vista `por-tema/`, escanea todo el código.

Ejemplo: `/agent-workflow:export-scripts --sessions 055,057,061` consolida sólo esas 3 sesiones.

## Flujo

### Paso 1 — Descubrimiento de sesiones

```
agent-workflow release-data --include-graduated [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
```

Output: `{workspace_mode, is_hub, source_alias, docs_root, sessions, sessions_count, legacy_sessions, graduated_bundles}`.

**Sesiones legacy v0.x (REQUIREMENTS.md)**: si `legacy_sessions` no vacío → abortar:

> Sesiones en formato legacy detectadas: sessionXXX, sessionYYY.
> Migrar primero con `/agent-workflow:migrate --upgrade-topology`, luego re-correr export-scripts.

### Paso 1.5 — Gate de layout SQL (v4.0.0, G2)

Por cada sesión del corpus, verificar el layout SQL:

```
agent-workflow session-artifacts --code <CODE>
```

Lógica:
1. Si `scripts_sql_present: true` → OK, usar `SCRIPTS.sql` (path: `.workflow/sessions/<folder>/SCRIPTS.sql`).
2. Si `scripts_sql_present: false` Y existe carpeta `.workflow/sessions/<folder>/scripts/` con sub-carpetas `01-ddl-tablas/`, `02-ddl-funciones/`, `03-migracion/` o `04-inserts/` → **ABORTAR**:

   > Layout SQL legacy detectado en sessionXXX-<slug>:
   > - scripts/01-ddl-tablas/...
   > - scripts/02-ddl-funciones/...
   > Migrar primero con `/agent-workflow:migrate --upgrade-topology` (consolida en SCRIPTS.sql) y luego re-correr export-scripts.

3. Si ninguno de los dos: la sesión no tiene cambios SQL → skipear esa sesión silenciosamente (no es error).

**Nunca consumir sesiones mixtas**: el bundle final debe ser coherente, sin mezclar layouts.

Para artefactos por sesión: el `session-artifacts` ya incluye flags de presencia (`scripts_sql_present`, `conclusiones_present`, etc.).

### Paso 2 — Escaneo de código fuente (delegado a `code-scan`)

```
agent-workflow code-scan
```

Built-in patterns: localhost, IP literal, TODO/FIXME/XXX/HACK, hardcoded-secret, console-log. Override con `--patterns-file references/code-scan-recommendations.md` (catálogo extendido) o `--pattern ID:REGEX:SEV` repetible.

**Excludes** por default: `node_modules/`, `target/`, `dist/`, `build/`, `.workflow/`, `docs/`, `tests/`, `test/`, `.git/`, `__pycache__/`, `.idea/`, `.vscode/`. Override: `--exclude DIR1,DIR2`.

**Extensiones** por default: `.java`, `.ts`, `.js`, `.py`, `.go`, `.rb`, `.php`, `.cs`, `.kt`, `.scala`, `.vue`, `.tsx`, `.jsx`, `.properties`, `.yml`, `.yaml`, `.json`, `.xml`, `.sql`. Override: `--ext`.

Output: `{matches: [{pattern_id, severity, file, line, snippet, recommendation}], counts, by_severity, total_matches}`.

Si `--skip-code-scan`: marcar la sección 6 del `README.md` como "escaneo omitido".

Catálogo extendido (alta/media/baja con recomendaciones detalladas) en `references/code-scan-recommendations.md`.

### Paso 3 — Estado de git

```
git rev-parse --abbrev-ref HEAD
git log certificacion..HEAD --oneline
git log HEAD..certificacion --oneline
git status --porcelain
git diff certificacion --stat
git branch -a --list
```

Interpretar: rama actual, commits no mergeados, cambios sin commit, archivos modificados. Si `certificacion`: marcar "ya integrada". Si git falla: registrar advertencia, no abortar.

### Paso 4 — Numeración del output dir

```
agent-workflow next-number docs/scripts
```

Output dir resuelto:
- **hub mode** → `<hub>/docs/scripts/NNN-export-scripts-YYYY-MM-DD/`.
- **project mode** → `<cwd>/docs/scripts/NNN-export-scripts-YYYY-MM-DD/`.

Si `docs/scripts/` no existe, crearlo.

### Paso 5 — Consolidación cross-session por categoría (v4.0.0)

Recolectar markers de todos los `SCRIPTS.sql` del corpus y consolidar al root del bundle:

1. **Para cada sesión** con `SCRIPTS.sql` (verificado en Paso 1.5):
   - Leer y parsear el archivo.
   - Detectar markers `-- @category: <01-04>` + `-- @stmt: NNN-verbo-objetivo`.
   - Detectar opcionales `@objeto` y `@alcance` para header de cada sentencia.
   - Validar idempotencia básica (presencia de `IF EXISTS`, `OR REPLACE`, `ON CONFLICT`); advertir en `README.md` §Hallazgos si falta.
   - Spec del SCRIPTS.sql: `agent-workflow/skills/sql-script-organizer/references/scripts-sql-format.md`.

2. **Consolidar por categoría al root** — un archivo por categoría con todas las sentencias cross-session. Mapping marker → filename:
   - `01-DDL-TABLES.sql` ← `@category: 01-ddl-tablas` (CREATE/ALTER TABLE, INDEX, SEQUENCE).
   - `02-DDL-FUNCTIONS.sql` ← `@category: 02-ddl-funciones` (CREATE OR REPLACE FUNCTION/PROCEDURE).
   - `03-DML.sql` ← `@category: 03-migracion` (UPDATE/DELETE/INSERT...SELECT sobre datos existentes).
   - `04-INSERTS.sql` ← `@category: 04-inserts` (INSERT INTO ... VALUES, seeds).
   - Orden cross-session: sessionXXX cronológica → stmt cronológica dentro de cada una.
   - Header de cada archivo: bloque inicial con metadata del bundle (corpus + fecha + versión CLI) + tabla de contenidos (sentencias en orden).
   - Cada bloque de sentencia preserva su header canónico (`Script` / `Sesion` / `Objeto` / `Alcance`) + bloque transaccional `BEGIN; ... COMMIT;` propio.
   - **Categorías vacías → skip silencioso**: no se escribe el archivo si no hay sentencias del corpus en esa categoría.

3. **Delegar a `sql-rollback-generator` v2.0.0** (on-export): genera `00-ROLLBACK.sql` único cross-session encadenado 04→01 (ver Paso 7).

4. **Queries de soporte**: si alguna sesión tiene `queries/`, copiarlas a `_queries/<sessionXXX>/` (sub-dir aparte; canal de consulta, no de ejecución).

5. Si la sesión tenía layout legacy `scripts/01-04/*.sql` (sub-carpetas), el Paso 1.5 ya abortó — nunca llegamos acá con layout mixto.

**Nota explícita**: NO se crea `por-sesion/`. NO se crea `<file>.rollback.sql` companion por sentencia. NO se crea sub-carpeta `rollback/` per-sesión. Esos artefactos del v3.x quedan eliminados del default.

### Paso 6 — `por-tema/` (opt-in, capa adicional encima del root plano)

Activación:
- `--themes slug1,slug2` declarado, **o**
- Al menos una sesión tiene `## Temas` en su OBJECTIVE, **o**
- `--themes infer` declarado (inferencia LLM).

Si activado, generar `por-tema/<slug>/` como **capa adicional** encima del root plano — NO reemplaza los archivos `0X-*.sql` del root. Aplicar `references/theme-handling.md`:

1. Resolver temas por sesión (lectura declarativa + inferencia + confirmación).
2. Asignar cada sentencia a su tema (header `-- Temas:`, nombre, contenido, fallback `tema-general`).
3. Consolidar por categoría dentro de cada tema en un único `.sql` ejecutable: `por-tema/<slug>/01-DDL-TABLES.sql`, `02-DDL-FUNCTIONS.sql`, `03-DML.sql`, `04-INSERTS.sql`.
4. **Rollback per-tema**: NO se genera. El rollback canónico es siempre `00-ROLLBACK.sql` al root — un solo punto de verdad para reversa. Esto evita estado inconsistente si el operador ejecuta rollback de un tema y deja otros aplicados.
5. Si `--keep-parts`: preservar `por-tema/<slug>/parts/<categoria>/*.sql` con sentencias individuales.
6. README §Mapping: agregar tabla "Sesión ↔ Tema ↔ Scripts" cuando `por-tema/` activado.

Si no activado, **skip** este paso completo (sin sub-carpeta `por-tema/` vacía).

### Paso 7 — `00-ROLLBACK.sql` cross-session (rollback único)

Delegar a **`sql-rollback-generator` v2.0.0** para generar un único archivo `00-ROLLBACK.sql` al root del bundle:

- Encadena rollbacks en orden inverso: última sesión → primera, dentro de cada una 04→03→02→01.
- Header del archivo lista las sesiones cubiertas + corpus + fecha de generación.
- Cuerpo: `BEGIN; ... COMMIT;` único con bloques agrupados por sesión + categoría inversa.
- **Irreversibles**: bloque "Fase 5 — Cleanup irreversible" **después** del `COMMIT;` con header `-- WARNING: IRREVERSIBLE` y referencia a `DECISIONS.md` de la sesión origen. El operador decide ejecutar este bloque manualmente.

**No se genera** `ORDER.md`: la secuencia ejecutable vive en §4 del `README.md` (única fuente de verdad).

### Paso 8 — Detección de acciones manuales

Cruzar contra `release/references/manual-actions-catalog.md` (reference cruzada — DEC-004 session061). Reglas resumidas:

| Condición | Acción manual |
|---|---|
| Tokens/api-key/credenciales mencionados sin valor | Solicitar a admin de prod (plantilla de correo) |
| Sentencias categorizadas `03-migracion` (consolidadas en `03-DML.sql`) | Respaldar tablas afectadas |
| `ALTER TABLE ... DROP` o `DROP TABLE` | Validar ventana de downtime |
| Escaneo: `localhost` / staging URL | Reemplazar por env var |
| Escaneo: credenciales hardcodeadas (alta) | Rotar + gestor de secretos |
| Rama distinta de `certificacion` con commits | Crear PR a `certificacion` |
| Sesión activa con `.sql` sin bundle | Cerrar o aislar antes del export |

Cada acción incluye `id` (ACT-001, …) para referenciar desde el checklist final del `README.md` (§9).

### Paso 9 — `README.md` único + validaciones

**`README.md`** (único informe + índice + how-to-execute): usar `references/readme-template.md`. Secciones canónicas v4.0.0:

1. Resumen ejecutivo + readiness.
2. Sesiones incluidas.
3. Acciones manuales (ACT-NNN).
4. Secuencia de ejecución 01→04 + invocaciones psql.
5. Rollback (`00-ROLLBACK.sql` — cómo, cuándo, irreversibles).
6. Hallazgos del code-scan.
7. Git y ramas.
8. Documentación graduada (decisiones / manuales / etc.).
9. Checklist final de producción.
10. Metadata (corpus + fecha + versión CLI).

**NO se genera `manifest.md`** (absorbido por README §1-§10). **NO se genera `ORDER.md`** (absorbido por §4 del README). El template `manifest-template.md` queda marcado `## Status: DEPRECATED` como histórico.

**Validaciones V1-V6** (`references/validations.md`):
- V1 estructura del bundle: archivos `00-ROLLBACK.sql`, `01..04-*.sql`, `README.md` al root. Falla si aparece `por-sesion/`, `<file>.rollback.sql`, `<session>/rollback/`, `manifest.md`, `ORDER.md` o `rollback-global.sql`.
- V2 noise vetado (placeholders, paths absolutos, `NNN` sin reemplazar) + anti-redundancia (sin patrones del layout v3.x).
- V3 secciones obligatorias del README único (las 10).
- V4 conditionals (`por-tema/` honored si activo, dry-run, code-scan skip).
- V5 header del README bien formado.
- V6 referencias resolubles (paths a `docs/`).

Si V1, V3 o V4 fallan → abortar con error report. V2, V5, V6 → warning.

### Paso 10 — Escribir output

Si `--dry-run`: imprimir reporte (count sesiones incluidas, hallazgos por severidad, acciones manuales, V4 outcome). No escribir.

Si pasa: escribir directorio completo (layout plano cross-session):

```
docs/scripts/NNN-export-scripts-YYYY-MM-DD/
├── 00-ROLLBACK.sql              # único rollback cross-session (encadenado 04→01)
├── 01-DDL-TABLES.sql            # CREATE/ALTER TABLE cross-session (skip si vacío)
├── 02-DDL-FUNCTIONS.sql         # CREATE OR REPLACE FUNCTION cross-session (skip si vacío)
├── 03-DML.sql                   # UPDATE/DELETE/migración cross-session (skip si vacío)
├── 04-INSERTS.sql               # INSERT/seed cross-session (skip si vacío)
├── README.md                    # único informe + índice + how-to-execute
├── _queries/                    # opcional: queries de soporte por sesión (canal de consulta)
│   └── sessionXXX/...
└── por-tema/                    # opt-in (capa adicional encima del root plano)
    ├── tema-<slug>/
    │   ├── 01-DDL-TABLES.sql    # consolidado cross-session del tema
    │   ├── 02-DDL-FUNCTIONS.sql
    │   ├── 03-DML.sql
    │   ├── 04-INSERTS.sql
    │   └── parts/               # si --keep-parts (sentencias individuales por categoría)
    └── tema-<otro>/...
```

**No se escriben** (eliminados desde v4.0.0): `por-sesion/`, `<file>.rollback.sql` companions, `<session>/rollback/`, `rollback-global.sql` separado, `manifest.md` separado, `ORDER.md`. El histórico (`docs/scripts/001-002-003-*` generados por v3.x) queda como histórico — no se migra.

### Paso 11 — Resumen al usuario

- Ruta del bundle (`docs/scripts/NNN-export-scripts-YYYY-MM-DD/`).
- Counts: sesiones incluidas, scripts totales, hallazgos por severidad, acciones manuales pendientes.
- Si `por-tema/` activado: temas resueltos + scripts por tema.
- Advertencias bloqueantes: sesiones abiertas, rollback ausente, irreversibles sin respaldo.

## Composición con otras skills

- **`sql-script-organizer`** — clasificación 01→04 cross-session (paso 5 y consolidación por tema paso 6).
- **`sql-rollback-generator`** v2.0.0+ — `00-ROLLBACK.sql` único cross-session (sin companions ni per-sesión).
- **`session`** — este skill NO invoca graduación ni cierre.
- **`coding-standards`** — patrones de escaneo derivan de reglas de seguridad.
- **`agent-workflow:redaccion-simple`** — preset default aplicado en prosa del `README.md`.

## Re-ejecución

Idempotente funcional pero NO sobreescribe bundles previos. Cada ejecución toma siguiente NNN. Para regenerar: borrar el directorio manualmente y re-invocar.

## Relación con `release` / `release-scripts` legacy

Plan de deprecación Fase 1 (plugin v2.8.0):
- `/agent-workflow:release` y `/agent-workflow:release-scripts` siguen funcionando idénticos. Output legacy (`docs/release/NNN-informe-release.md` + `docs/scripts/NNN-sessionXXX-<slug>/` + `scripts-por-tema/`) sin cambios.
- Banner deprecation visible al cargar SKILL.md y commands/*.md de ambos.
- Workspaces que ya invocaron `release` mantienen `docs/release/` como histórico. Nuevas invocaciones se hacen vía `/agent-workflow:export-scripts`.

Plan de deprecación Fase 2 (plugin v3.0.0 — futuro, sin compromiso de fecha):
- Remoción de skills + commands legacy.
- Decisión final cuando se confirme migración cross-workspace.

Detalle completo: `references/deprecation-plan.md`.

## Recursos adicionales

- **`references/manifest-template.md`** — **DEPRECATED** desde v4.0.0. El informe consolidado se redacta directamente en `README.md` siguiendo `references/readme-template.md`. Archivo se conserva como histórico — no usar para bundles nuevos.
- **`references/readme-template.md`** — plantilla del README del bundle.
- **`references/lexico-tecnico.md`** — lista mínima de noise vetado para V2.
- **`references/validations.md`** — V1-V6 con condiciones de hard-fail.
- **`references/code-scan-recommendations.md`** — catálogo extendido de patrones (port directo de `release/references/code-scan-patterns.md`).
- **`references/theme-handling.md`** — algoritmo de detección/consolidación por tema (port adaptado de `release-scripts/references/theme-detection.md` + `order-generation.md`).
- **`references/deprecation-plan.md`** — plan de fases 1-2.
- **`release/references/manual-actions-catalog.md`** — catálogo de acciones manuales (reference cruzada — DEC-004 session061).
- **`docs/conclusiones/007-export-commands-family.md`** — Propuesta original de la familia `/agent-workflow:export-*`.
- **`agent-workflow/skills/export-report/SKILL.md`**, **`export-arq/SKILL.md`**, **`export-tech-manuals/SKILL.md`** — hermanos de la familia.
