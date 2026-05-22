---
description: Bundle invokable de reglas transversales agent-workflow-* — carga los 7 anchors canónicos (commits, sandbox plan-mode, MCP read-only, redacción, coding-standards, graduación, branch verification) en un solo entry point. No requiere sesión activa.
argument-hint: (sin args)
allowed-tools:
  [
    "Read",
  ]
---

# Rules — Reglas transversales agent-workflow-*

Invoca el skill `rules` (canónico de agent-workflow).

## Cuándo correrlo

- Antes de un commit ad-hoc fuera de `/agent-workflow:session close` (para refrescar política).
- Antes de editar código en una fuente agent-workflow-* sin sesión activa.
- Antes de ejecutar una query vía MCP `<mcp-cert>`/`<mcp-prod>` (read-only canon).
- Durante onboarding de un usuario nuevo a agent-workflow-*.
- En conversaciones largas donde el contexto qtc se diluyó.

## Qué carga

Los 7 anchors canónicos del runtime agent-workflow-*:

1. `agent-workflow:commits-policy` — formato y prohibiciones de commits.
2. `agent-workflow:sandbox-readonly` — comportamiento en plan mode.
3. `agent-workflow:mcp-readonly` — política SELECT-only para MCP.
4. `agent-workflow:redaccion-simple` — estilo transversal para prosa agent-workflow-*.
5. `agent-workflow:coding-standards` — estándares por stack + FE-BE R1-R6 + seguridad.
6. `agent-workflow:graduacion-routing` — 6 kinds graduables + routing hub vs project.
7. `agent-workflow:branch-verification` — gate de rama por fuente + hard gate cross-fuente.

## Plan mode

Read-only. Skill imprime el bundle sin ejecutar nada.

## Recursos

Ver `skills/rules/SKILL.md` para el contenido extendido de cada anchor.
