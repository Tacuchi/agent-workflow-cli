# Legacy anchors — alias permanentes `qtc:<topic>` → `agent-workflow:<topic>`

Política definida en `docs/especificaciones/003-migracion-lifecycle-a-aw/MAPPING.md` §"Política de anchors": el SKILL universal expone anchors `agent-workflow:<topic>` como nombre canónico. Los anchors `qtc:<topic>` se mantienen como **aliases permanentes** dentro del SKILL universal para que CLAUDE.md / AGENTS.md / READMEs / docs históricos que referencien `qtc:*` no rompan.

## Tabla de aliases

| Legacy anchor | Anchor canónico | Razón |
|---|---|---|
| `qtc:commits-policy` | `agent-workflow:commits-policy` | doctrina universal de commit messages |
| `qtc:sandbox-readonly` | `agent-workflow:sandbox-readonly` | plan mode read-only |
| `qtc:mcp-readonly` | `agent-workflow:mcp-readonly` | MCP SELECT/EXPLAIN/\d only |
| `qtc:redaccion-simple` | `agent-workflow:redaccion-simple` | estilo de prosa |
| `qtc:coding-standards` | `agent-workflow:coding-standards` | estándares por stack |
| `qtc:graduacion-routing` | `agent-workflow:graduacion-routing` | routing kind por hub/fuente |
| `qtc:branch-verification` | `agent-workflow:branch-verification` | gate de rama por fuente |

## Anchors de skills (agent-workflow:*)

Los nombres de skill también funcionan como anchors:

| Legacy | Canónico |
|---|---|
| `qtc:session` | `agent-workflow:session` |
| `qtc:resume` | `agent-workflow:resume` |
| `qtc:compact` | `agent-workflow:compact` |
| `qtc:rules` | `agent-workflow:rules` |
| `qtc:doctor` | `agent-workflow:doctor` |
| `qtc:migrate` | `agent-workflow:migrate` |
| `qtc:project-init` | `agent-workflow:project-init` |
| `qtc:hub-init` | `agent-workflow:hub-init` |
| `qtc:export-*` (9 commands) | `agent-workflow:export-*` |
| `qtc:dev-workflow` / `qtc:design-workflow` / `qtc:analyze-workflow` | `agent-workflow:dev-workflow` / etc. |

## Empresas que quieran shadow propios

Cualquier empresa puede inyectar sus propios anchors `<empresa>:<topic>` via `profile.custom_anchors[]`:

```json
{
  "custom_anchors": [
    { "anchor": "acme:special-rule", "target": "profiles/anchors/acme-special-rule.md" }
  ]
}
```

El skill `agent-workflow:rules` los renderiza al final del bundle bajo "## Anchors específicos del profile".

## Política de retiro

Los aliases `qtc:*` documentados aquí son **permanentes**. No hay ventana de retiro planeada. El skill `agent-workflow:rules` los expone automáticamente cuando el profile QTC está activo (detectado via `profile.namespace === "qtc"` o cuando `profile.mcp_databases[]` contiene los nombres legacy).
