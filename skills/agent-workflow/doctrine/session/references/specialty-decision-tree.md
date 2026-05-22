# Specialty decision tree

> Anchor `agent-workflow:specialty-decision-tree`. Spec del árbol que `choose_specialty` aplica para mapear el OBJECTIVE de la sesión a una especialidad concreta dentro del flow elegido.

## CLI runtime

El árbol está implementado en el CLI:

```
agent-workflow specialty-choose --flow <dev|design|analyze> --objective "<text>"
```

Devuelve `{ specialty: <slug>, reason: <text> }` o `{ specialty: null }` si el OBJECTIVE no matchea ninguna especialidad clara (en cuyo caso `agent-workflow:session` pregunta al usuario via prompt C1).

## Lógica resumida

### Flow `dev`

1. Si OBJECTIVE menciona `refactor`, `rebuild`, `Strangler` o el archivo declara `## Tipo: refactor` → `refactor`.
2. Si menciona `release`, `bundle SQL`, `paso a producción` → `release` (o `release-scripts` si menciona temas).
3. Si menciona crear/editar SQL forward → `sql-script-organizer`.
4. Si menciona rollback SQL → `sql-rollback-generator`.
5. Si menciona testing strategy → `testing-strategy`.
6. Si menciona FE-BE contract / Sparse DTO / PATCH semantics → `coding-standards`.
7. Default: `implement` (la mayoría de los OBJECTIVE de feature/bugfix).

### Flow `design`

1. Si la sesión está en planning sin Type capturado → `design-brief`.
2. Si ya hay brief y es divergencia inicial → `design-discover`.
3. Si está convergiendo en problema/soluciones → `design-develop`.
4. Si está cerrando spec final para handoff a dev → `design-deliver`.
5. Para componentes CRUD reusables → `frontend-design`.

### Flow `analyze`

1. Si recolecta evidencia/queries read-only → `analyze-investigate`.
2. Si sintetiza FINDINGS.md desde EVIDENCE.md → `analyze-synthesize`.
3. Si produce CONCLUSIONS.md final → `analyze-conclude`.

## Heurística cuando no hay match

`specialty-choose` devuelve `{ specialty: null }`. `agent-workflow:session` dispara prompt C1 con las opciones del flow + "Other (free-form)" para que el usuario decida.

## Composición múltiple

Algunas especialidades componen entre sí dentro de la misma sesión (ej. `implement` invoca `coding-standards`, `sql-script-organizer`, `testing-strategy` durante execution). El árbol resuelve la **especialidad principal**; las composiciones se gatillan dinámicamente.

## Override manual

El usuario puede forzar la especialidad con `--specialty <slug>` en `aw session-create`, saltando el árbol.

## Refs

- `references/lifecycle-deep.md` §Composición dinámica de especialidades.
- CLI: `agent-workflow specialty-choose --help`.
