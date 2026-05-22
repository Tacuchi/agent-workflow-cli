---
name: doctor
description: "Health check read-only de la familia qtc-*. Orquesta `agent-workflow plugin-doctor` por fuente declarada en `agent-workflow sources` (hub mode) o sobre el cwd (single-repo). Default scope = all en hub, cwd en single-repo. Reporta versión del manifest, integridad de hooks, presencia de SKILL.md con frontmatter completo, runtime.json instalado y MCP config si aplica. Sin acciones ni mutaciones — sólo diagnóstico."
version: 1.0.0
---

> **Profile parametrization**: lee `mcp_databases[]` de `profile.json` (resuelto vía cascade 5 capas). Ver [`references/profile-parametrization.md`](../../references/profile-parametrization.md) para el contrato completo y comportamiento por defecto cuando el profile está vacío.

# Doctor — qtc-* health check (orquestador)

Skill canónica del comando `/agent-workflow:doctor`. Orquesta diagnósticos read-only sobre los plugins qtc-* declarados en el workspace. El trabajo pesado lo hace el CLI runtime (`@tacuchi/agent-workflow-cli`); esta skill resuelve el scope, llama al CLI por plugin y agrega los resultados.

## Cuándo se invoca

- Comando `/agent-workflow:doctor` (tanto Claude Code como Codex).
- NL: "¿está sano el plugin?", "diagnóstico de qtc", "doctor de plugins", "health check del hub".
- Pre-release: antes de publicar el plugin se chequea con `--scope <plugin>`.

## Scope resolution

1. Leer args:
   - `--scope <alias|all>` explícito.
   - `--plugin-root PATH` directo (single-repo o testing).
2. Si no hay args: `agent-workflow workspace-mode`. Si retorna `hub` → `--scope all`. Si `project` → `--plugin-root <cwd>`.
3. `--scope all` (hub): `agent-workflow sources` → filtrar fuentes con manifest `.claude-plugin/plugin.json` o `.codex-plugin/plugin.json` y aplicar `plugin-doctor` a cada path.

## Ejecución por plugin

```
agent-workflow plugin-doctor --plugin-root <path>
```

Output esperado (por plugin):

- `status` ∈ `ok` | `warn` | `error`.
- `plugin_version` desde el manifest.
- `manifests` = comparación claude vs codex (versiones coincidentes).
- `hooks` = parseo de `hooks/hooks.json` y `codex-hooks/hooks.json`.
- `skills` = barrer `skills/*/SKILL.md`, validar frontmatter (`name`, `description`, `version` semver) y matching `name == dirname`.
- `runtime` = presencia de `~/.workflow/agent-workflow/runtime.json` (agent-workflow only).
- `mcp_config` = `.mcp.json` si aplica.
- `errors[]` y `warnings[]`.

## Salida

### Tabla compacta (scope=all)

```
plugin                       version    status   findings
──────────────────────────   ────────   ──────   ────────
agent-workflow          2.2.2      ok       —
otro-plugin                  1.0.0      warn     SKILL.md sin version
```

Resumen final: `<N>/M plugins ok` o lista de findings.

### Detallado (scope=<alias> o --plugin-root)

Mostrar el JSON completo de `plugin-doctor` + interpretación humana.

## Accionables típicos

- `agent-workflow CLI not found in PATH` → `npm install -g @tacuchi/agent-workflow-cli`.
- `manifest version mismatch claude vs codex` → editar y bumpear coordinado.
- `runtime.json missing` → reload del cliente (SessionStart hook lo escribe).
- `SKILL.md sin frontmatter completo` → ver `agent-workflow:redaccion-simple` para canon.

## Sandbox read-only

Canon universal en `../session/references/sandbox-readonly-rules.md`. Read-only por construcción — el subcomando CLI `agent-workflow plugin-doctor` sólo consulta estado (versiones, namespaces, paths, fuentes registradas) sin mutar plugins ni fuentes.

En plan mode: describir en el plan file los checks que correrían (per-fuente, scope `all`/`hub`/`single-repo`) sin invocar el CLI. NO ejecuta `Write`, `Edit`, ni comandos que muten estado de plugins/fuentes/workspace.

Compatible con plan mode sin restricciones adicionales.

## Composición

| Skill | Cuándo |
|---|---|
| `agent-workflow` (CLI skill) | Ejecuta el `plugin-doctor` por fuente. |
| `agent-workflow:hub-init` / `agent-workflow:project-init` | Si `workspace-mode` no detecta el bloque AW-PROJECT. |

## Referencias

- `commands/doctor.md` — entry point del slash command (Claude Code y Codex).
- `agent-workflow plugin-doctor --help` — flags disponibles del CLI runtime.
