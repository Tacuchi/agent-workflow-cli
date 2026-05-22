---
description: Health check de plugins agent-workflow-* (core/dev/design/analyze). Solo lectura. Default scope=all en hub mode; cwd en single-repo.
argument-hint: (opcional) --scope <core|dev|design|analyze|all> [--plugin-root PATH]
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# Doctor — agent-workflow-* Health Check (orchestrator desde core)

Diagnostica el estado de uno o varios plugins de la familia `agent-workflow-*`. El runtime CLI (`@tacuchi/agent-workflow-cli`) corre los checks por plugin; este comando los orquesta.

## Argumentos

- `--scope <alias|all>` (default: `all` en hub mode; `cwd` en single-repo) — qué plugin chequear.
  - `core` → `core-workflow-plugin`.
  - `dev` → `developer-workflow-plugin`.
  - `design` → `design-workflow-plugin`.
  - `analyze` → `analyze-workflow-plugin`.
  - `all` → los 4 plugins de la familia (resueltos desde `agent-workflow sources`).
- `--plugin-root PATH` (opcional, sin `--scope`) — checkear el plugin en `PATH` directamente. Útil para single-repo.

Default: si `agent-workflow workspace-mode` retorna `hub` → `--scope all`. Sino → `--scope cwd` (alias del plugin del cwd).

## Qué verifica (por plugin, vía `agent-workflow plugin-doctor --plugin-root <path>`)

1. **CLI presente**: `agent-workflow --version` responde correctamente.
2. **Manifests**: `.claude-plugin/plugin.json` y `.codex-plugin/plugin.json` existen y la versión coincide entre ambos.
3. **Hooks**: `hooks/hooks.json` y `codex-hooks/hooks.json` parsean como JSON válido y los `command` apuntan al CLI (`agent-workflow ...`) — no a scripts Python locales.
4. **Skills**: el directorio `skills/` existe; cada subdir tiene un `SKILL.md` con frontmatter completo (`name`, `description`, `version` semver) y `name` coincide con directorio.
5. **MCP config** (si aplica): `.mcp.json` válido y env vars del DSN seteadas (solo si el profile activo define `mcp_databases[]`).
6. **runtime.json instalado** (agent-workflow only): `~/.workflow/agent-workflow/runtime.json` existe y matchea `config/agent-workflow-runtime.json`.

## Qué NO verifica (post-v6.3)

- Versiones del CLI vs plugin: el CLI se actualiza independiente.
- Existencia de scripts Python o `qtc_core/`: la familia migró a single-path npm en session032.

## Ejecución por scope

### `--scope all` (hub mode)

1. `agent-workflow sources` → leer `sources[]`.
2. Filtrar por alias que termine en `-workflow-plugin` (los 4 plugins de la familia).
3. Por cada uno: `agent-workflow plugin-doctor --plugin-root <path>`. Capturar `status`, `plugin_version`, `manifests`, `errors`/`warnings` (si los expone).
4. Agregar resultados en una tabla compacta:

   ```
   plugin                       version    status   findings
   ──────────────────────────   ────────   ──────   ────────
   core-workflow-plugin         3.29.0     ok       —
   developer-workflow-plugin    2.7.0      ok       —
   design-workflow-plugin       1.4.0      ok       —
   analyze-workflow-plugin      1.5.0      warn     SKILL.md sin version
   ```

5. Resumen final: `<N>/4 plugins ok` o lista de los con findings.

**Si `agent-workflow` aparece en sources** (post-Fase B de la Propuesta 002): incluirlo también, mapping `qtc` → `agent-workflow`. Hasta que tenga manifest, el plugin-doctor reportará error informativo y queda flaggeado en la tabla.

### `--scope <alias>`

1. Resolver alias → path:
   - Si hub mode: leer `agent-workflow sources` y matchear el alias correspondiente al `<alias>-workflow-plugin` (excepto `dev` → `developer-workflow-plugin`).
   - Si single-repo: error con mensaje claro ("scope `<alias>` requiere hub mode; usá `--plugin-root PATH` o cambia al cwd del plugin").
2. `agent-workflow plugin-doctor --plugin-root <path>`.
3. Mostrar resultado completo (todos los campos del JSON de plugin-doctor).

### Sin `--scope`, sin `--plugin-root` (default)

1. `agent-workflow workspace-mode` → si `hub` → comportarse como `--scope all`.
2. Sino → comportarse como `--plugin-root <cwd>` (single-repo, plugin actual).

### `--plugin-root PATH` (sin `--scope`)

1. `agent-workflow plugin-doctor --plugin-root <PATH>`.
2. Mostrar resultado completo.

## Interpretación

1. **Resumen por plugin** según `status`:
   - `ok` → "saludable" + versión del manifest.
   - `warn` → resumen de findings (ej. SKILL.md sin frontmatter).
   - `error` → resumen de findings críticos (ej. CLI no encontrado, manifest corrupto).
2. **Resumen global** (scope=all):
   - "Familia agent-workflow-* saludable" si todos `ok`.
   - "<N> plugin(s) con findings: <lista>" si alguno warn/error.

## Accionables típicos

- `agent-workflow CLI not found in PATH` → `npm install -g @tacuchi/agent-workflow-cli`.
- `manifest version mismatch claude vs codex` → editar el plugin.json y bump coordinado.
- `runtime.json missing` (agent-workflow) → reload Claude Code/Codex (SessionStart hook lo escribe).
- `<plugin> sin manifest` (post-Fase A pre-B en `agent-workflow`) → esperar Fase B (migración de skeletons) antes de incluir en checks.

## Plan mode

Read-only. En plan mode el comando solo describe los checks que correría sin invocar `agent-workflow plugin-doctor` ni `agent-workflow sources`.
