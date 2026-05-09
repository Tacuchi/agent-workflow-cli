# Test plan — Workflow universal (CLI agent-workflow + skill agent-workflow)

Specs (no implementación). Validan los 3 contratos arquitecturales.

Generable a `skills/agent-workflow/docs/TEST-PLAN.md` para que cualquier consumidor del workflow tenga la batería de aceptación.

## Convenciones

- Cada test tiene: id, contrato, precondición, pasos, criterio de éxito, frontera (lo que NO valida).
- Estados esperados expresados como JSON observable o efectos de filesystem.
- Implementación recomendada: vitest (unit/golden) para Contract A; bash/CI smoke para Contract B; bash + namespace alterno para Contract C.

## Contract A — CLI ↔ skill

Cada comando que el skill referencia ejecuta y devuelve la forma JSON declarada por la reference.

### A1 — Surface match

- **Precondición**: CLI instalado globalmente, skill instalado en `~/.claude/skills/agent-workflow`.
- **Pasos**:
  1. Listar comandos del CLI (`agent-workflow --help`).
  2. Para cada comando: parse top-level del SKILL.md y de las 11 references; verificar que aparece exactamente en 1 reference.
- **Criterio**: 43 comandos listados, 43 menciones en exactamente 1 reference cada uno. 0 huérfanos.
- **Frontera**: no valida la forma del JSON ni la implementación de cada comando.

### A2 — JSON contract por comando

- **Precondición**: workspace de prueba con bloque `<NS>-PROJECT` y al menos una sesión.
- **Pasos** (por cada comando read-only):
  1. Ejecutar `agent-workflow <cmd> [flags] | jq '.'`.
  2. Validar que `jq` retorna 0 (JSON parseable).
  3. Validar que las claves top-level matchean lo declarado en la reference.
- **Criterio**: 100% de comandos read-only retornan JSON parseable con shape declarado.
- **Frontera**: no valida correctness semántica de los valores (solo shape).

### A3 — Error envelope

- **Precondición**: workspace donde el namespace activo no existe.
- **Pasos**:
  1. Correr `agent-workflow --namespace invalid sessions`.
  2. Capturar stdout + stderr + exit code.
- **Criterio**: exit code ≠ 0, stderr o stdout incluye `error.code = "NOT_IN_WORKSPACE"` (o equivalente declarado).
- **Frontera**: no valida cobertura exhaustiva de error codes.

## Contract B — Skill ↔ usuario externo

Una empresa nueva instala skill + CLI y completa un workflow E2E sin tocar plugins.

### B1 — Install path

- **Precondición**: máquina sin `agent-workflow` ni skill instalado.
- **Pasos**:
  1. `npm install -g @tacuchi/agent-workflow-cli`.
  2. `agent-workflow self install-skill`.
  3. `agent-workflow self doctor`.
- **Criterio**: doctor reporta `cli_version >= 1.2.0`, `skill.installed = true`, `skill.path` apunta al directorio correcto.
- **Frontera**: no valida ediciones de `~/.claude/settings.json` ni hook registration.

### B2 — Workflow E2E (fresh namespace)

- **Precondición**: directorio `/tmp/acme-test` vacío, `git init` ejecutado.
- **Pasos**:
  1. `cd /tmp/acme-test && agent-workflow --namespace acme project-md-upsert --init`.
  2. `agent-workflow --namespace acme session-create --flow dev --name first-feature --objetivo "Implementar lo que sea"`.
  3. `agent-workflow --namespace acme tasks-data --code session001`.
  4. `agent-workflow --namespace acme checkpoint-write --code session001`.
  5. `agent-workflow --namespace acme checkpoint-read --code session001`.
  6. `agent-workflow --namespace acme session-close --code session001`.
- **Criterio**:
  - Tras paso 1: `CLAUDE.md` (o `AGENTS.md`) contiene bloque `<!-- ACME-PROJECT-START -->`.
  - Tras paso 2: directorio `.acme/sessions/session001-dev-first-feature/` con `OBJETIVO.md`.
  - Tras paso 6: `HISTORY.md` muestra fila con state = closed.
- **Frontera**: no valida invocación desde Claude Code real (eso es B3).

### B3 — Skill consumption en Claude Code (manual)

- **Precondición**: B1 + B2 ejecutados; Claude Code abierto en `/tmp/acme-test`.
- **Pasos**:
  1. Pedirle al modelo: "create a session for fixing the login bug".
  2. Observar si el modelo invoca el skill `agent-workflow`.
  3. Observar comandos ejecutados por el modelo.
- **Criterio**: el modelo lee SKILL.md, identifica `session-create`, lo ejecuta con namespace correcto.
- **Frontera**: depende de que la SessionStart del entorno setee `AW_NAMESPACE` o el modelo use `--namespace`.

## Contract C — Plugins downstream sin lógica universal

El workflow universal opera con namespaces alternativos y produce resultados equivalentes.

### C1 — Equivalencia operacional

- **Precondición**: workspace con plugins instalados + workspace alternativo "vanilla" (sin plugins, con bloque `<NS>-PROJECT` propio).
- **Pasos**: ejecutar la misma secuencia (`session-create → tasks-data → checkpoint-write → session-close`) en ambos workspaces, con namespaces respectivos.
- **Criterio**: ambos generan estructuras isomorfas (`.<ns>/sessions/sessionNNN-dev-<slug>/OBJETIVO.md` + fila en `HISTORY.md` + bloque `<NS>-PROJECT` actualizado). Diferencias permitidas: contenido de `OBJETIVO.md` (texto), header del bloque project (`WORKFLOW-PROJECT` vs `ACME-PROJECT`).
- **Frontera**: no valida los skills de negocio downstream — esos son específicos del namespace.

### C2 — Plugins downstream no implementan lifecycle

- **Precondición**: repos del plugin downstream accesibles.
- **Pasos**:
  1. `grep -rn "def session_create\|function sessionCreate\|create_session" <plugin-root>/skills/` (debe retornar 0 hits).
  2. `find <plugin-root> -name "*.py"` (debe retornar 0 archivos si el plugin es sólo skills/hooks declarativos).
  3. Para cada hook en `hooks.json`: validar que invoca `agent-workflow ...` (no script local).
- **Criterio**: 0 funciones de lifecycle, 0 archivos Python, 100% de hooks invocan al CLI.
- **Frontera**: no valida que los skills de negocio sean correctos — solo que no duplican lógica universal.

### C3 — `AW_NAMESPACE` propagation

- **Precondición**: nuevo Claude Code session en workspace del plugin.
- **Pasos**:
  1. Esperar SessionStart hook.
  2. Verificar `cat ~/.config/agent-workflow/namespace`.
  3. Correr `agent-workflow self namespace`.
- **Criterio**: archivo contiene el namespace esperado, comando reporta `{ namespace: "<namespace>", source: "user-config" }` (o "workspace" si detectó bloque local).
- **Frontera**: no valida cómo plugins no instalados propagan su namespace.

## Contract D — Hooks (cobertura faltante en tests del CLI)

Estos tests cierran H4 (gap de tests existentes en agent-workflow/tests/).

### D1 — `hook branch-check`

- **Precondición**: workspace con sesión que declara `expected_work_branch = main`; checkout en `feature/x`.
- **Pasos**: `echo '{"tool_input":{"file_path":"src/foo.ts"}}' | agent-workflow hook branch-check`.
- **Criterio**: exit 2 (block), stdout JSON con `{ match: false, expected: "main", current: "feature/x" }`.
- **Frontera**: no valida MultiEdit/NotebookEdit (covered por Anthropic harness).

### D2 — `hook sql-mutation-guard`

- **Precondición**: payload de MCP con SQL DML.
- **Pasos**: `echo '{"tool_input":{"sql":"UPDATE foo SET x=1"}}' | agent-workflow hook sql-mutation-guard`.
- **Criterio**: exit 2, stdout JSON con `{ blocked: true, reason: "DML detected" }` (o equivalente).
- **Frontera**: no valida SELECT/EXPLAIN (deben pasar — cubrir en D2.b).

### D3 — `mcp dbhub` smoke

- **Precondición**: DSN persistido vía `bootstrap-dsn`.
- **Pasos**: `agent-workflow mcp dbhub cert` con stdin/stdout MCP frame de `initialize`.
- **Criterio**: el binario lanza `@bytebase/dbhub` vía npx y devuelve respuesta MCP válida.
- **Frontera**: no valida queries ejecutadas (las hace dbhub).

### D4 — `plugin-doctor`

- **Precondición**: plugin root válido.
- **Pasos**: `agent-workflow plugin-doctor --plugin-root /Users/tacuchi/Git/core-workflow-plugin`.
- **Criterio**: JSON con `status: "ok"` o `findings: []`. Si manifests no declaran `exportedSkills`, dejar warning explícito (no error).
- **Frontera**: no valida correctness de los skills exportados — solo presencia.

## Resumen

| Contract | Tests | Severidad |
|---|---|---|
| A — CLI ↔ skill | 3 (A1, A2, A3) | crítica |
| B — Skill ↔ usuario externo | 3 (B1, B2, B3) | alta |
| C — Plugins downstream sin lógica universal | 3 (C1, C2, C3) | alta |
| D — Hooks gap | 4 (D1, D2, D3, D4) | media |
| **Total** | **13 specs** | |

Implementación recomendada (no en alcance):
- A1, A2, A3 → vitest unit en `agent-workflow/tests/unit/`.
- B1, B2 → bash + golden fixtures en `agent-workflow/tests/golden/external-namespace.test.ts`.
- B3 → manual + grabado en `skills/agent-workflow/MANUAL-FUNCIONAL.md`.
- C1, C2, C3 → bash + workspace fixture comparativo.
- D1..D4 → vitest unit con stdin mock + spawn snapshot.
