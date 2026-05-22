# Multi-root manual — snippets de referencia

Si el usuario declina la automatización de `attach-multiroot`, o si solo usa uno de los dos clientes, mostrarle estos snippets para configurar manualmente.

## Claude Code (`<workspace>/.claude/settings.json` o `~/.claude/settings.json`)

```json
{
  "permissions": {
    "additionalDirectories": [
      "C:/Source/repo-1",
      "C:/Source/repo-2"
    ]
  }
}
```

Alternativa por sesión: `/add-dir <path>` por fuente.

## Codex CLI (`<workspace>/.codex/config.toml` o `~/.codex/config.toml`)

```toml
additional_writable_roots = [
  "C:/Source/repo-1",
  "C:/Source/repo-2"
]

[projects."C:/Source/repo-1"]
trust_level = "trusted"

[projects."C:/Source/repo-2"]
trust_level = "trusted"
```

## Recomendación

- **Per-workspace** es preferible (`<workspace>/...`) para no contaminar la config global con paths específicos del hub.
- **Global** sólo si todos tus workspaces comparten el mismo set de repos.

## Comandos automáticos equivalentes

```
# Per-workspace (default desde v3.3.4):
agent-workflow attach-multiroot --from-sources

# Global (legacy):
agent-workflow attach-multiroot --from-sources --global

# Revertir global:
agent-workflow detach-multiroot --from-sources --global
```
