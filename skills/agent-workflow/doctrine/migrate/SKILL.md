---
name: migrate
description: "Migra artefactos legacy del workspace al formato actual — sesiones de .claude/.codex a .workflow, REQUIREMENTS y artefactos ES (OBJETIVO/DECISIONES/HALLAZGOS/CONCLUSIONES/PROBLEMA/EVIDENCIA/ENTREGA) a EN canon (OBJECTIVE/DECISIONS/FINDINGS/CONCLUSIONS/PROBLEM/EVIDENCE/DELIVERY), QTC-WORKFLOW a AW-PROJECT, fases v3.x al lifecycle universal de 4 fases con CHECKPOINT.md inicial, hub mode promotion, bloque 'Reglas transversales qtc-*' (post-session052), AGENTS.md/CLAUDE.md por fuente (post-session053), wire-up de hooks PreToolUse post-v5.18 (sql-mutation-guard + git-commit-advisor), y consolidación de scripts SQL legacy `scripts/01-04/*.sql` → SCRIPTS.sql único (F-D session062 / sql-script-organizer v1.0.0). Invocado solo vía /agent-workflow:migrate."
version: 1.4.0
---

> **Profile parametrization**: lee `migrate_legacy_rules[]` de `profile.json` (resuelto vía cascade 5 capas). Ver [`references/profile-parametrization.md`](../../references/profile-parametrization.md) para el contrato completo y comportamiento por defecto cuando el profile está vacío.

# Migrate (agent-workflow)

Migrar artefactos del workspace desde rutas y formatos legacy hacia la topología actual (v0.8+, lifecycle universal v4.0+, infraestructura de reglas transversales post-session052/053). Vive en agent-workflow (Fase B; antes en qtc-core v3.0+, consolidando los `migrate` que vivían duplicados en qtc-dev/design/analyze).

## Capacidades

1. **Migración de sesiones legacy**: mover sesiones de `.claude/sessions/` y `.codex/sessions/` a `.workflow/sessions/`.
2. **Migración de project-config**: copiar project-config legacy a `.workflow/project-config.md` (transitorio; en v0.8+ el bloque AW-PROJECT vive en CLAUDE.md/AGENTS.md).
3. **Upgrade de topología al formato actual (v0.8+)**:
   - Reemplazar bloque `<!-- QTC-WORKFLOW -->` por `<!-- AW-PROJECT -->` (también acepta `<!-- WORKFLOW-PROJECT -->` como variante actual del marker).
   - Rename completo de artefactos legacy ES → canon EN (post-R3, ver §"Artefactos R3 EN/ES" abajo):
     - `REQUIREMENTS.md` / `OBJETIVO.md` → `OBJECTIVE.md`
     - `DECISIONES.md` → `DECISIONS.md`
     - `HALLAZGOS.md` → `FINDINGS.md`
     - `CONCLUSIONES.md` → `CONCLUSIONS.md`
     - `PROBLEMA.md` → `PROBLEM.md`
     - `EVIDENCIA.md` → `EVIDENCE.md`
     - `ENTREGA.md` → `DELIVERY.md`
   - Rename de tokens embebidos: `## Tipo` → `## Type`, `## Modalidad` → `## Modality` con valores ES→EN (`tecnica`→`technical`, `incidente`→`incident`, `datos`→`data`; `feature|refactor|bugfix|chore` ya en EN).
   - Absorber `STATUS.md` en `AW-PROJECT.Status`.
   - Archivar obsoletos (`SCENARIOS`, `CHANGELOG`, `TEST_LOG`, `TEST_STRATEGY`, `CONSULTASSQL`) a `_archived/`.
   - Rename `assets/` por sesión → `referencias/` (DEC-004).
4. **Upgrade v0.11.x → v0.12 (rename a qtc-*)**: renombrar carpetas de sesión `sessionNNN-<slug>` → `sessionNNN-<flow>-<slug>`, actualizar HISTORY.md a 7 columnas, mover `~/.developer-workflow/` → `~/.workflow/dev/`.
5. **Actualización/rebuild de HISTORY.md**.
6. **Upgrade v3.x → v4.0 (lifecycle universal)**: mapea fases en AW-PROJECT (`requerimiento|plan|implementacion|validacion|cierre` → `planning|execution|validation|closure`) y escribe `CHECKPOINT.md` inicial para sesiones activas.
7. **Upgrade hub-mode (v3.0+)**: detecta workspaces con ≥2 fuentes sin marcador `Mode:` declarado y promueve a `Mode: hub`. Idempotente. Delega a `agent-workflow upgrade-hub-mode`.
8. **Upgrade transversal-rules block (post-session052, extendido post-session090)**: detecta workspaces sin la sección `## Reglas transversales qtc-*` en CLAUDE.md/AGENTS.md y propone agregarla (8 anchors canónicos + puntero a `Skill(agent-workflow:rules)`). Aplica a hub workspaces principalmente; también a project workspaces qtc-* que usen el lifecycle qtc-*.
9. **Upgrade per-fuente anchors (post-session053)**: detecta repos qtc-* fuente (declarados en AW-PROJECT.Fuentes) que no tienen `AGENTS.md` o `CLAUDE.md` en su raíz y propone crearlos con preludio repo-específico ≤2 líneas + bloque transversal.
10. **Upgrade hooks PreToolUse post-v5.18 (agent-workflow como workspace)**: aplica solo si el workspace ES el repo `agent-workflow` (workspace de desarrollo del plugin). Detecta `hooks/hooks.json` y `codex-hooks/hooks.json` sin matchers `mcp__.*__execute_sql` ni `Bash` en `PreToolUse[]` y propone agregarlos.

11. **Upgrade scripts SQL: layout legacy → SCRIPTS.sql consolidado (F-D session062, v1.3.0)**: detecta sesiones que tienen carpeta `scripts/` con sub-carpetas `01-ddl-tablas/`, `02-ddl-funciones/`, `03-migracion/`, `04-inserts/` (layout v0.x de `sql-script-organizer`) y produce `SCRIPTS.sql` único en la raíz de la sesión consolidando todas las sentencias.

    **Algoritmo**:
    1. Por cada sesión candidata: leer `scripts/01-*/`*.sql, `scripts/02-*/`*.sql, `scripts/03-*/`*.sql, `scripts/04-*/`*.sql en orden ascendente por filename.
    2. Concatenar en `SCRIPTS.sql` (uppercase EN canon) en la raíz de la sesión:
       - Header global `-- ============... SCRIPTS.sql — sessionXXX-...` (ver `agent-workflow/skills/sql-script-organizer/references/scripts-sql-format.md`).
       - `BEGIN;`.
       - Para cada archivo legacy: marker `-- @category: <carpeta>` + `-- @stmt: <filename-sin-ext>` antes del cuerpo. Preservar el cuerpo SQL tal cual (idempotencia ya estaba).
       - `COMMIT;` al final.
    3. Eliminar archivos `.rollback.sql` durante la migración (la nueva política es on-export; sus rollbacks se regenerarán al correr `/agent-workflow:export-scripts`).
    4. **Opcional (prompt al usuario)**: borrar las carpetas legacy `scripts/01-04/` post-consolidación. Default: mover a `.workflow/sessions/<folder>/_archived/scripts-legacy/` para reversibilidad.
    5. **Idempotente**: si ya existe `SCRIPTS.sql` y no hay sub-carpetas legacy → no-op silencioso.
    6. **Conflict**: si existen AMBOS (SCRIPTS.sql + scripts/01-04/) → reportar y pedir decisión al usuario (puede ser que la migración haya quedado a medias).

    **Indicadores de detección**:
    - Existe `.workflow/sessions/<folder>/scripts/01-ddl-tablas/` o equivalentes Y NO existe `SCRIPTS.sql` en raíz.
    - Filename de archivos en sub-carpetas: `^\d{2,3}-[a-z0-9-]+\.sql$`.

    **Trigger desde `/agent-workflow:export-scripts`**: si export-scripts detecta layout legacy y aborta (G2), el mensaje sugiere `/agent-workflow:migrate --upgrade-topology`. Ejecutar la migración hace que la próxima corrida de export-scripts proceda.

12. **Upgrade referencias globales (DEC-004 v2, session080, v1.4.0)**: detecta sesiones con carpeta `.workflow/sessions/<folder>/referencias/` (DEC-004 v1, scope por-sesión) y consolida el contenido a `<workspace-root>/docs/referencias/` (DEC-004 v2, scope transversal). Opt-in vía `--upgrade-referencias-globales`. Default: no toca contenido legacy.

    **Por qué**: a partir de DEC-004 v2, el AI ya no lee la carpeta `referencias/` por-sesión. Si el contenido viejo aporta valor (mockups reutilizables, glosarios, exports), esta migración es la única vía soportada para rescatarlo al path canónico.

    **Algoritmo**:
    1. Por cada sesión con `referencias/` no vacía (legacy v1): listar archivos.
    2. Resolver `<workspace-root>/docs/referencias/` (en hub mode = hub root; en single-repo = cwd).
    3. Si no existe, crear `docs/referencias/` + `docs/referencias/README.md` (template canónico — ver `agent-workflow/skills/session/SKILL.md` §"`docs/referencias/` transversal (DEC-004 v2)").
    4. Por cada archivo legacy:
       - Renombrar con prefijo `<sessionNNN>-` para evitar colisiones (ej. `referencias/A-mockup.png` → `docs/referencias/session023-A-mockup.png`).
       - Si el archivo ya existe en destino con mismo prefijo: reportar conflicto y pedir resolución manual (no sobrescribir).
       - Mover con `git mv` si el repo está versionado; `mv` plano si no.
    5. Mover la carpeta legacy completa a `.workflow/sessions/<folder>/_archived/referencias-legacy/` para reversibilidad. NO eliminar.
    6. **Idempotente**: si una sesión ya tiene `_archived/referencias-legacy/` y `referencias/` vacía o ausente → skip.

    **Indicadores de detección**:
    - Existe `.workflow/sessions/<folder>/referencias/` con ≥1 archivo (excluir `.gitkeep` puro).
    - El archivo no es link simbólico ni gitignored.

    **Conflict resolution**:
    - Si dos sesiones distintas tienen `referencias/A-mockup.png` con contenido distinto: ambas se preservan como `session023-A-mockup.png` y `session041-A-mockup.png`.
    - Si dos sesiones tienen el mismo file pero contenido idéntico (sha-1 match): consolidar a 1 con prefijo de la primera sesión y registrar las otras como duplicados en el log.

## Parámetros

- `--flow dev|design|analyze` — enfoca el upgrade al flow específico (afecta rename de slugs legacy y destino de scripts cache `~/.workflow/<flow>/`).
- `--rebuild-history` — solo regenerar HISTORY.md, sin mover archivos.
- `--upgrade-topology` — solo upgrade al formato 0.8+ (incluye rename de artefactos R3 y tokens).
- `--upgrade-v4` — solo upgrade v3.x → v4.0.
- `--upgrade-hub-mode` — solo upgrade hub-mode.
- `--upgrade-referencias-globales` — solo upgrade DEC-004 v2 (consolida `referencias/` por-sesión legacy a `docs/referencias/` transversal). Opt-in.
- Sin flags: detección completa con confirmación por bloque (NO incluye `--upgrade-referencias-globales` por default; mover contenido del usuario sin pedirlo viola la regla "AI no escribe en `referencias/` salvo solicitud explícita").

> **TODO(migrate)**: considerar flags adicionales `--upgrade-transversal-rules`, `--upgrade-per-fuente-anchors`, `--upgrade-hooks-post-v5.18` con CLI delegation para cada uno. Hoy estos 3 escenarios se ejecutan dentro de la detección completa.

## Indicadores de detección

### Pre-0.9 (topología)

- Bloque `<!-- QTC-WORKFLOW-START -->` en `CLAUDE.md` o `AGENTS.md` (sin el reemplazo a `<!-- AW-PROJECT-START -->` o `<!-- WORKFLOW-PROJECT-START -->`).
- Sesiones con `REQUIREMENTS.md` y sin `OBJECTIVE.md`/`OBJETIVO.md`.
- Sesiones con `STATUS.md` (archivo ya no usado en 0.8+).
- Existe `.workflow/project-config.md`.
- `~/.workflow/user-config.md` con sección `## Workflow profile` (formato pre-0.9).

### Pre-R3 (artefactos ES legacy)

- Sesiones con artefactos `OBJETIVO.md` / `DECISIONES.md` / `HALLAZGOS.md` / `CONCLUSIONES.md` / `PROBLEMA.md` / `EVIDENCIA.md` / `ENTREGA.md` sin sus contrapartes EN canon.
- Tokens embebidos `## Tipo: <valor>` y/o `## Modalidad: <valor>` con valores ES (`tecnica` / `incidente` / `datos`).
- Carpetas `assets/` dentro de sesiones (DEC-004 v1 las reemplaza por `referencias/`; DEC-004 v2 las desactiva a favor de `docs/referencias/` transversal — ver indicador siguiente).

### Pre-DEC-004 v2 (referencias por-sesión legacy → docs/referencias/ transversal)

- Sesiones con `.workflow/sessions/<folder>/referencias/` no vacía. La carpeta sigue existiendo pero el AI ya no la lee (DEC-004 v2). Aplicar `--upgrade-referencias-globales` para consolidar al path canónico.

### Pre-v0.12 (rename a qtc-*)

- Existe `~/.developer-workflow/`.
- Sesiones con slug `sessionNNN-<slug>` sin marcador de flujo.
- HISTORY.md de 6 columnas.

### Pre-v4.0 (lifecycle 5 fases)

- Sesiones activas con fase `requerimiento|plan|implementacion|validacion|cierre`.
- Manifest del plugin con `qtcContractVersion < 4.0` (raro post-v6.3 ya que el CLI se actualiza independiente).

### Pre-v4.5 (hub mode)

- Bloque AW-PROJECT con ≥2 fuentes pero sin línea `Mode: hub|project` declarada.

### Pre-session052 (bloque transversal en workspace)

- `CLAUDE.md` y/o `AGENTS.md` del workspace tiene `<!-- WORKFLOW-PROJECT-START -->` pero NO tiene la sección `## Reglas transversales qtc-*` después del `<!-- WORKFLOW-PROJECT-END -->`.
- Detector específico (regex): el archivo NO contiene la string `## Reglas transversales qtc-*` después del marker de cierre.
- Si la sección existe pero con menos de 8 anchors canónicos (lista esperada: `agent-workflow:commits-policy`, `agent-workflow:sandbox-readonly`, `agent-workflow:mcp-readonly`, `agent-workflow:redaccion-simple`, `agent-workflow:coding-standards`, `agent-workflow:graduacion-routing`, `agent-workflow:branch-verification`, `agent-workflow:closure-cleanup`), se considera incompleta y se ofrece actualización.

### Pre-session053 (repos qtc-* fuente sin anchors)

- Workspace que se identifica como repo qtc-* fuente del runtime: su path coincide con alguna entrada de AW-PROJECT.Fuentes de OTRO workspace (típicamente el hub que coordina los 3 repos del runtime).
- Detector específico: la raíz del repo NO tiene `AGENTS.md` ni `CLAUDE.md`.
- Aplica a los 3 repos canónicos: `agent-workflow-cli`, `agent-workflow`, `qtc-plugins-marketplace`. Generalizable a otros repos qtc-* fuente declarados como tales.

### Pre-v5.18 (hooks PreToolUse incompletos)

- Aplica SOLO si el workspace es el repo `agent-workflow` (workspace de desarrollo del plugin).
- Detector: `hooks/hooks.json` y/o `codex-hooks/hooks.json` no incluye matchers `mcp__.*__execute_sql` ni `Bash` en `PreToolUse[]`.
- Específicamente:
  - Falta entry con `matcher: "mcp__.*__execute_sql"` → `agent-workflow hook sql-mutation-guard`.
  - Falta entry con `matcher: "Bash"` → `agent-workflow hook git-commit-advisor`.
- El matcher original `Edit|Write|MultiEdit|NotebookEdit` debe existir; si falta, es un escenario más serio (Pre-v0.9 hook layout) y migrate debe reportar antes de ofrecer wire-up nuevo.

## Procesos

Detalle por upgrade abajo. Los procesos idempotentes; cada uno verifica el estado actual antes de mutar. Las delegaciones al CLI runtime son la vía canónica para mutaciones; el AI confirma con el usuario antes de ejecutar cada bloque.

### Upgrade hub-mode (delegado al CLI)

```
agent-workflow upgrade-hub-mode [--dry-run]
```

`--dry-run` reporta elegibilidad sin mutar. Sin `--dry-run`, aplica el cambio (escribe `Mode: hub` en CLAUDE.md/AGENTS.md). Idempotente.

### Upgrade transversal-rules block (post-session052, manual guidado por AI)

1. Detector: leer `CLAUDE.md` y `AGENTS.md` del workspace; verificar ausencia de la sección `## Reglas transversales qtc-*` o presencia incompleta (menos de 8 anchors canónicos).
2. Si falta o está incompleto, el AI propone al usuario agregar/completar el bloque con la plantilla canónica (8 anchors + puntero a `Skill(agent-workflow:rules)`).
3. Mutación: edit incremental en ambos archivos (`CLAUDE.md` y `AGENTS.md`) insertando el bloque después del `<!-- WORKFLOW-PROJECT-END -->`.
4. Idempotencia: si la sección ya existe completa (8 anchors), skip silent. Si está incompleta, ofrece reemplazo con confirmación.
5. **Sin CLI delegation hoy** (TODO: futuro `agent-workflow upgrade-transversal-rules`).

### Upgrade per-fuente anchors (post-session053, manual guidado por AI)

1. Detector: workspace ES un repo qtc-* fuente (path coincide con AW-PROJECT.Fuentes de algún hub) y no tiene `AGENTS.md` ni `CLAUDE.md` en raíz.
2. Si falta, el AI propone crear los 2 archivos con preludio repo-específico ≤2 líneas + bloque "Reglas transversales qtc-*" idéntico al del hub.
3. Mutación: crear `AGENTS.md` y `CLAUDE.md` con contenido idéntico salvo el preludio (repo-específico).
4. Idempotencia: si ambos archivos existen y tienen el bloque transversal, skip silent. Si uno existe pero está incompleto, ofrece actualización.
5. **Sin CLI delegation hoy** (TODO: futuro `agent-workflow upgrade-per-fuente-anchors`).

### Upgrade hooks PreToolUse post-v5.18 (agent-workflow workspace, manual)

1. Detector: workspace es `agent-workflow` (heurística: existe `skills/session/SKILL.md` Y `hooks/hooks.json` en raíz).
2. Verificar entries en `PreToolUse[]` de `hooks/hooks.json` y `codex-hooks/hooks.json`:
   - ¿Existe `matcher: "mcp__.*__execute_sql"` → `agent-workflow hook sql-mutation-guard`?
   - ¿Existe `matcher: "Bash"` → `agent-workflow hook git-commit-advisor`?
3. Si falta cualquiera de los 2, el AI propone agregarlos como entries nuevas en `PreToolUse[]`, coexistiendo con el entry original `Edit|Write|MultiEdit|NotebookEdit`.
4. Mutación: edit JSON preservando formato (indentación 2 espacios, llave de cierre ordenada).
5. Validación: ejecutar `python3 -c "import json; json.load(open(p))"` sobre ambos archivos tras la mutación.
6. Idempotencia: si los 2 matchers nuevos ya están registrados, skip silent.
7. **Sin CLI delegation hoy** (TODO: futuro `agent-workflow upgrade-hooks`).

### Rename de artefactos R3 EN/ES (durante upgrade-topology)

Tabla canónica de renames (legacy ES → EN canon):

| Legacy ES | EN canon |
|---|---|
| `OBJETIVO.md` | `OBJECTIVE.md` |
| `DECISIONES.md` | `DECISIONS.md` |
| `HALLAZGOS.md` | `FINDINGS.md` |
| `CONCLUSIONES.md` | `CONCLUSIONS.md` |
| `PROBLEMA.md` | `PROBLEM.md` |
| `EVIDENCIA.md` | `EVIDENCE.md` |
| `ENTREGA.md` | `DELIVERY.md` |

Tokens embebidos:

| Legacy ES | EN canon |
|---|---|
| `## Tipo` | `## Type` |
| `## Modalidad` | `## Modality` |
| `tecnica` | `technical` |
| `incidente` | `incident` |
| `datos` | `data` |
| `feature|refactor|bugfix|chore` | (sin cambio — ya EN) |

Procedimiento:
1. Por cada sesión legacy, identificar artefactos con nombre ES.
2. Si NO existe la contraparte EN, renombrar (`git mv` si la sesión está bajo control de versión).
3. Si AMBOS coexisten (raro), reportar conflicto y pedir resolución manual al usuario.
4. Buscar tokens embebidos en cada `.md` y reemplazar (manteniendo el contenido del cuerpo). Idempotente.
5. Aliases bilingües siguen aceptándose por readers R1 — el rename es una mejora de canonización, no una ruptura.

### Rename `assets/` → `referencias/` por sesión (DEC-004 v1, histórico)

1. Por cada sesión con carpeta `assets/` en su raíz, renombrar a `referencias/`.
2. Si ambas existen, mover contenido de `assets/` a `referencias/` y reportar; preferir no sobrescribir.
3. Idempotente: si `referencias/` ya existe y `assets/` no, skip.

> **Nota DEC-004 v2 (session080, v1.4.0)**: la operación `referencias/` por-sesión existió hasta DEC-004 v1. A partir de DEC-004 v2 las nuevas sesiones no usan `referencias/` por-sesión; el contenido va a `<workspace-root>/docs/referencias/` (transversal). Para consolidar contenido viejo, ver §"Consolidar `referencias/` por-sesión → `docs/referencias/` (DEC-004 v2, opt-in)" abajo.

### Consolidar `referencias/` por-sesión → `docs/referencias/` (DEC-004 v2, opt-in)

Activado por `--upgrade-referencias-globales`. Mueve contenido de carpetas legacy a la carpeta transversal. Procedimiento completo en la capacidad #12 arriba (algoritmo, indicadores, conflict resolution).

1. Por cada sesión con `.workflow/sessions/<folder>/referencias/` no vacía: listar archivos.
2. Resolver destino: `<workspace-root>/docs/referencias/` (hub root en hub mode, cwd en single-repo).
3. Crear `docs/referencias/` + README.md si no existe.
4. Mover cada archivo con prefijo `<sessionNNN>-` para evitar colisiones (`git mv` si versionado).
5. Mover la carpeta legacy completa a `_archived/referencias-legacy/` (reversible). NO eliminar.
6. Reportar conflictos (mismo prefijo + contenido distinto) y dejar resolución al usuario.
7. Idempotente: si la sesión ya tiene `_archived/referencias-legacy/` → skip.

## Reglas

- **Nunca sobreescribir sesiones**: si una carpeta ya existe en `.workflow/sessions/`, no moverla desde legacy.
- **Nunca borrar** `.claude/` ni `.codex/`: solo mover contenido del plugin.
- **Nunca borrar automáticamente** archivos durante el upgrade; siempre mover a `_archived/`.
- **Siempre confirmar** antes de escribir.
- **Preservar manuales existentes** en `docs/manuales/` (Manual Técnico, Manual Funcional, etc.).
- **Idempotencia universal**: cada proceso verifica estado actual antes de mutar. Skip silent si ya aplicado.
- **No modificar el código del CLI** desde migrate; migrate edita workspace files y delega al CLI ya instalado para mutaciones específicas (hub-mode).

## Política — sin fallback al CLI

Si `agent-workflow upgrade-hub-mode` (u otros sub-comandos) falla (no está en PATH, comando no reconocido, exit code != 0), **cortá la acción y reportá al usuario**: pedile que verifique `npm install -g @tacuchi/agent-workflow-cli`. No hay flujo alternativo Python.

## Sandbox read-only

Canon universal en `../session/references/sandbox-readonly-rules.md`. Read-only por construcción cuando se invoca en plan mode — el migrate no muta nada sin confirmación explícita del usuario, y el CLI delega (hub-mode) se llama solo después de aprobación.

En plan mode describir:
- Sesiones a mover de legacy (paths origen → destino).
- Artefactos R3 a renombrar (legacy ES → EN canon, lista cerrada de archivos por sesión).
- Tokens embebidos a renombrar (`## Tipo`/`## Modalidad` con valores ES).
- Bloque AW-PROJECT a escribir o normalizar.
- Bloque "Reglas transversales qtc-*" a insertar/completar (post-session052).
- AGENTS.md/CLAUDE.md por fuente a crear (post-session053).
- Entries `PreToolUse[]` a agregar en hooks.json (post-v5.18).
- Filas de HISTORY.md a actualizar.
- Rename `assets/` → `referencias/` por sesión (DEC-004 v1, histórico).
- Consolidar `referencias/` por-sesión → `<workspace-root>/docs/referencias/` (DEC-004 v2, opt-in — sólo si `--upgrade-referencias-globales`).

NO ejecutar mutaciones. NO invocar `agent-workflow upgrade-hub-mode` sin `--dry-run` en plan mode.

## Recursos

- `../session/references/sandbox-readonly-rules.md` — canon plan mode.
- `../session/references/commits-policy.md` — política de commits del closure (aplicable también fuera de sesión vía bloque transversal).
- `../session/SKILL.md` §"Graduar artefactos (6 kinds — DEC-003)" — kinds + routing hub-vs-fuente.
- `../rules/SKILL.md` (skill agregadora `agent-workflow:rules`, post-session052; 8º anchor agregado post-session090) — bundle invokable de las 8 reglas transversales.
- CLI runtime `@tacuchi/agent-workflow-cli` ≥5.18.0 — subcomandos relevantes: `upgrade-hub-mode`, `project-md-upsert`, `sources`, `hook git-commit-advisor`, `hook sql-mutation-guard`, `hook branch-check`.
- Histórico: session051 (analyze reglas transversales) → session052 (quick-wins) → session053 (anchors por fuente + Bash hook) → session054 (este migrate update).
