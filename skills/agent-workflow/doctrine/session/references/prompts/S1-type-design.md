# S1 — type-design (standalone o brief ambiguo)

Spec literal del prompt S1. Index: [`../prompts-catalog.md#s1--type-design-standalone-o-brief-ambiguo`](../prompts-catalog.md#s1--type-design-standalone-o-brief-ambiguo).

- **Cuándo**: `/agent-workflow:session` con flow=design y `design-brief` no define `## Type` en el OBJECTIVE (legacy: `## Tipo` en OBJETIVO.md).
- **Forma**: 1 question.
  - `header`: `design-type`.
  - `question`: "¿Qué tipo de sesión de diseño es?"
  - `multiSelect`: false.
  - `options`:
    1. "Project (pantalla/feature concreta)" — "Produce DELIVERY.md en `.workflow/sessions/<folder>/`. Al graduar va a `docs/especificaciones/<NNN>-<slug>/` (kind=`especificacion`)."
    2. "System (tokens/componentes compartidos)" — "Produce DELIVERY.md describiendo cambios al design system. Al graduar va a `docs/especificaciones/<NNN>-<slug>/` (mismo kind, distinto contenido)."
- **Tratamiento del Other auto-inyectado**: cancelación + apertura de conversación libre ("necesito más contexto"). El AI **no infiere** project/system desde el texto libre — pide al usuario que lo defina explícitamente. La sesión queda **sin type** hasta que el usuario lo declare.
- **Valor persistido**: el AI siempre escribe el valor canónico EN (`project`/`system`) en el OBJECTIVE.md. Los valores ES legacy (`proyecto`/`sistema`) se aceptan sólo en lectura (sesiones pre-R3).
- **Reemplaza**: prosa en `qtc-design/skills/design-workflow/SKILL.md` paso 2 + `qtc-design/skills/design-brief/SKILL.md` sección "Si el usuario no puede deducir el Type".
