# S3 — flow-detection

Spec literal del prompt S3. Index: [`../prompts-catalog.md#s3--flow-detection`](../prompts-catalog.md#s3--flow-detection).

- **Cuándo**: usuario invoca `/agent-workflow:session "<texto>"` y la heurística no determina flow (no hay alias específico ni keywords claras).
- **Forma**: 1 question principal + (si elige opción 4) sub-prompt encadenado.

**Prompt 1**:
- `header`: `flow`.
- `question`: "¿Qué flow usás para esta sesión?"
- `multiSelect`: false.
- `options`:
  1. "Dev (implementación de código)" — "Edits con coding-standards, SQL, tests."
  2. "Design (UX/UI specs)" — "Brief, discovery, develop, deliver. Spec-only."
  3. "Analyze (investigación read-only / propuesta)" — "Investigate, synthesize, propuesta/datos/post-mortem."
  4. "No estoy seguro" — "Disparo 1-2 preguntas más para clasificar."

**Prompt 2** (solo si elige opción 4):
- `header`: `clasificar`.
- `question`: "Para clasificar la sesión, ¿qué planeás hacer?"
- `multiSelect`: false.
- `options`:
  1. "Editar código directamente" → flow = dev.
  2. "Producir un spec UX/UI sin código" → flow = design.
  3. "Investigar sin editar código ni BD" → flow = analyze.
  4. "Mezcla — empezar investigando y después decidir" → flow = analyze (con posible Caso C después).

- **Reemplaza**: heurística silenciosa en `skills/session/SKILL.md` "Detectar flow".
