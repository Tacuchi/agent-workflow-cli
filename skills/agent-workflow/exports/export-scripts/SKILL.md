---
name: export-scripts
description: "Consolida N sesiones del workspace + `docs/scripts/` ya graduados en un paquete de paso a producción bajo `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`. v3.0.0 BREAKING (F-D session062): lee `SCRIPTS.sql` único per sesión (uppercase EN, G1), parsea markers `@category`/`@stmt` y separa post-hoc en `por-sesion/sessionXXX/01-04/`. Delega `sql-rollback-generator` v1.0.0+ on-export para generar rollbacks per archivo + global encadenado 04→01. Aborta con sugerencia de `/agent-workflow:migrate --upgrade-topology` si detecta layout legacy `scripts/01-04/*.sql` (G2). Sigue produciendo `manifest.md`, `por-tema/` opt-in, `rollback-global.sql`, `ORDER.md`. Read-only / reporte — no ejecuta commits ni SQL. Invocado sólo vía `/agent-workflow:export-scripts`. v3.1 (session081): corpus extendido a `docs/` además de sesiones (DEC-002) — ver `docs/shared-contract/export-corpus-sources.md`."
version: 3.1.0
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

## Qué hace este skill

1. Lee sesiones (`.workflow/sessions/`) recolectando `scripts/` y `queries/` de **todas** las sesiones del workspace (filtrables por `--since` y `--source`).
2. Escanea código fuente buscando patrones que no deben llegar a producción.
3. Consulta git (rama vs `certificacion`, commits pendientes, archivos sin commit).
4. Delega a `sql-script-organizer` (clasificación 01→04 cross-session) y `sql-rollback-generator` (rollback acoplado + global).
5. Detecta acciones manuales requeridas (matriz heredada de `release`).
6. **Theme detection (opt-in)**: si hay `## Temas` en algún OBJECTIVE o `--themes slug1,slug2` declarado, genera vista `por-tema/` consolidada por categoría.
7. Aplica validations V1-V6 (`references/validations.md`).
8. Si pasa: escribe el dossier completo bajo `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`.

## Qué NO hace

- Ejecutar commits, merges, push (ver `agent-workflow:commits-policy`).
- Ejecutar scripts SQL contra BD.
- Enviar correos ni crear PRs.
- Modificar código fuente (los hallazgos del escaneo son recomendaciones).
- Tocar `.workflow/sessions/` ni artefactos individuales.
- Migrar histórico de `docs/release/` (workspaces que ya invocaron `release` legacy mantienen ese dir como histórico).

## Sandbox read-only

`../session/references/sandbox-readonly-rules.md`. Plan describe NNN, sesiones incluidas, secciones del manifest, hallazgos esperados, contenido del bundle por sesión y (opcionalmente) por tema.

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

### Paso 1.5 — Gate de layout SQL (v3.0.0, G2)

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

Si `--skip-code-scan`: marcar la sección 5 del manifest como "escaneo omitido".

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

### Paso 5 — `por-sesion/` (bundle por sesión, v3.0.0)

Para cada sesión del corpus que tenga `SCRIPTS.sql` (verificado en Paso 1.5):

1. Crear `por-sesion/sessionXXX-<slug>/`.
2. **Leer y parsear `SCRIPTS.sql`** de la sesión:
   - Detectar markers `-- @category: <01-04>` + `-- @stmt: NNN-verbo-objetivo`.
   - Detectar opcionales `@objeto` y `@alcance` para el header canónico de cada archivo separado.
   - Validar idempotencia básica (presencia de `IF EXISTS`, `OR REPLACE`, `ON CONFLICT`); advertir en manifest si falta.
3. **Separar en 01-04**:
   - Por cada par marker → escribir archivo `por-sesion/sessionXXX-<slug>/<categoria>/<stmt>.sql` con header canónico re-derivado (Script / Sesion / Objeto / Alcance) + BEGIN/COMMIT propios.
   - Orden dentro de cada categoría: cronológico según aparición en SCRIPTS.sql.
   - Spec del SCRIPTS.sql: `agent-workflow/skills/sql-script-organizer/references/scripts-sql-format.md`.
4. **Delegar a `sql-rollback-generator` v1.0.0** (on-export): genera `<stmt>.rollback.sql` por cada forward separado + `rollback/00-rollback-global.sql` encadenado 04→01.
5. Copiar `queries/` tal cual si existe (canal aparte para queries de soporte; no se separa).
6. Si la sesión tenía layout legacy `scripts/01-04/*.sql` (sub-carpetas), el Paso 1.5 ya abortó antes — nunca llegamos acá con layout mixto.

### Paso 6 — `por-tema/` (opt-in)

Activación:
- `--themes slug1,slug2` declarado, **o**
- Al menos una sesión tiene `## Temas` en su OBJECTIVE, **o**
- `--themes infer` declarado (inferencia LLM).

Si activado, aplicar `references/theme-handling.md` (port adaptado de release-scripts legacy):

1. Resolver temas por sesión (lectura declarativa + inferencia + confirmación).
2. Asignar cada script a su tema (header `-- Temas:`, nombre, contenido, fallback `tema-general`).
3. Consolidar por categoría dentro de cada tema en un único `.sql` ejecutable (4 forwards + 4 rollbacks + 1 rollback de tema = ~9 archivos/tema).
4. Generar `ORDER.md` cross-tema con secuencia fase 1→4.
5. Si `--keep-parts`: preservar `por-tema/<slug>/parts/<categoria>/*.sql`.

Si no activado, **skip** este paso completo (sin sub-carpeta `por-tema/` vacía).

### Paso 7 — `rollback-global.sql` + `ORDER.md`

**`rollback-global.sql`**: encadena rollbacks en orden inverso al `ORDER.md`. Si `por-tema/` existe, el global encadena rollbacks por-tema; si no, encadena rollbacks por-sesion. Operaciones irreversibles → "Fase 5 — Cleanup irreversible" al final con header WARNING.

**`ORDER.md`**: secuencia ejecutable cross-bundle:
- Sin `por-tema/`: orden por sesión cronológica, dentro de cada una 01→04.
- Con `por-tema/`: intercalado por fase (Fase 1 DDL tablas cross-tema, Fase 2 DDL funciones cross-tema, etc.) — algoritmo en `references/theme-handling.md`.

### Paso 8 — Detección de acciones manuales

Cruzar contra `release/references/manual-actions-catalog.md` (reference cruzada — DEC-004 session061). Reglas resumidas:

| Condición | Acción manual |
|---|---|
| Tokens/api-key/credenciales mencionados sin valor | Solicitar a admin de prod (plantilla de correo) |
| Scripts en `03-migracion/` | Respaldar tablas afectadas |
| `ALTER TABLE ... DROP` o `DROP TABLE` | Validar ventana de downtime |
| Escaneo: `localhost` / staging URL | Reemplazar por env var |
| Escaneo: credenciales hardcodeadas (alta) | Rotar + gestor de secretos |
| Rama distinta de `certificacion` con commits | Crear PR a `certificacion` |
| Sesión activa con `.sql` sin bundle | Cerrar o aislar antes del export |

Cada acción incluye `id` (ACT-001, …) para referenciar desde el checklist final del manifest.

### Paso 9 — `manifest.md` + `README.md` + validaciones

**`manifest.md`** (informe consolidado): usar `references/manifest-template.md`. Secciones canónicas:
1. Resumen ejecutivo + readiness.
2. Sesiones incluidas.
3. Acciones manuales (ACT-NNN).
4. Base de datos (secuencia, rollback, impacto, vista por-tema si aplica).
5. Hallazgos del code-scan.
6. Git y ramas.
7. Documentación graduada.
8. Checklist final de producción.
9. Advertencias.
10. Metadata.

**`README.md`**: índice del directorio + mapeo sesión↔tema↔scripts + how-to-execute. Usar `references/readme-template.md`.

**Validaciones V1-V6** (`references/validations.md`):
- V1 estructura del manifest.
- V2 noise vetado (placeholders, paths absolutos, `NNN` sin reemplazar).
- V3 secciones obligatorias del manifest.
- V4 conditionals (vista por-tema honored, dry-run, código scan skip).
- V5 header del manifest bien formado.
- V6 referencias resolubles (paths a `docs/`).

Si V1, V3 o V4 fallan → abortar con error report. V2, V5, V6 → warning.

### Paso 10 — Escribir output

Si `--dry-run`: imprimir reporte (count sesiones incluidas, hallazgos por severidad, acciones manuales, V4 outcome). No escribir.

Si pasa: escribir directorio completo:

```
docs/scripts/NNN-export-scripts-YYYY-MM-DD/
├── manifest.md                 # informe consolidado
├── README.md                   # índice + mapeo
├── ORDER.md                    # secuencia ejecutable
├── rollback-global.sql         # rollback encadenado inverso
├── por-sesion/
│   ├── sessionXXX-<slug>/
│   │   ├── 01-ddl-tablas/
│   │   ├── 02-ddl-funciones/
│   │   ├── 03-migracion/
│   │   ├── 04-inserts/
│   │   └── rollback/
│   └── ...
└── por-tema/                   # opt-in
    ├── tema-<slug>/
    │   ├── 01-ddl-tablas.sql   # consolidado cross-session
    │   ├── 02-ddl-funciones.sql
    │   ├── 03-migracion.sql
    │   ├── 04-inserts.sql
    │   ├── rollback-tema-<slug>.sql
    │   └── parts/              # si --keep-parts
    └── tema-<otro>/...
```

### Paso 11 — Resumen al usuario

- Ruta del bundle (`docs/scripts/NNN-export-scripts-YYYY-MM-DD/`).
- Counts: sesiones incluidas, scripts totales, hallazgos por severidad, acciones manuales pendientes.
- Si `por-tema/` activado: temas resueltos + scripts por tema.
- Advertencias bloqueantes: sesiones abiertas, rollback ausente, irreversibles sin respaldo.

## Composición con otras skills

- **`sql-script-organizer`** — clasificación 01→04 cross-session (paso 5 y consolidación por tema paso 6).
- **`sql-rollback-generator`** — rollback acoplado por archivo y rollback global encadenado.
- **`session`** — este skill NO invoca graduación ni cierre.
- **`coding-standards`** — patrones de escaneo derivan de reglas de seguridad.
- **`agent-workflow:redaccion-simple`** — preset default aplicado en prosa del manifest.

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

- **`references/manifest-template.md`** — plantilla canónica del informe consolidado (port adaptado de `release/references/report-template.md` con nuevos paths).
- **`references/readme-template.md`** — plantilla del README del bundle.
- **`references/lexico-tecnico.md`** — lista mínima de noise vetado para V2.
- **`references/validations.md`** — V1-V6 con condiciones de hard-fail.
- **`references/code-scan-recommendations.md`** — catálogo extendido de patrones (port directo de `release/references/code-scan-patterns.md`).
- **`references/theme-handling.md`** — algoritmo de detección/consolidación por tema (port adaptado de `release-scripts/references/theme-detection.md` + `order-generation.md`).
- **`references/deprecation-plan.md`** — plan de fases 1-2.
- **`release/references/manual-actions-catalog.md`** — catálogo de acciones manuales (reference cruzada — DEC-004 session061).
- **`docs/conclusiones/007-export-commands-family.md`** — Propuesta original de la familia `/agent-workflow:export-*`.
- **`agent-workflow/skills/export-report/SKILL.md`**, **`export-arq/SKILL.md`**, **`export-tech-manuals/SKILL.md`** — hermanos de la familia.
