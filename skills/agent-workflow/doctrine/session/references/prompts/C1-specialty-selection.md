# C1 — specialty-selection (planning)

Spec literal del prompt C1. Index: [`../prompts-catalog.md#c1--specialty-selection-planning`](../prompts-catalog.md#c1--specialty-selection-planning).

- **Cuándo**: planning phase, después de `agent-workflow specialty-choose --phase planning`, hay 2+ skills sugeridas.
- **Forma**: 1 question multi-select.
  - `header`: `specialty`.
  - `question`: "¿Qué skills invoco para descomponer el plan?"
  - `multiSelect`: true.
  - `options` (≤4): nombres de skills sugeridas con namespace (ej. `agent-workflow:analyze-synthesize`, `agent-workflow:design-brief`, `agent-workflow:implement` post-Fase C; aliases legacy `qtc-analyze:analyze-synthesize` etc. válidos durante convivencia) y descripción de qué hace cada una en planning.
- **Refina**: prosa en `skills/session/SKILL.md` "Plan agent + Specialty (suggestion-only)".
