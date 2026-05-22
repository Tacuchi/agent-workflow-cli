# C2 — cost-guard (queries pesadas en analyze-investigate)

Spec literal del prompt C2. Index: [`../prompts-catalog.md#c2--cost-guard-queries-pesadas-en-analyze-investigate`](../prompts-catalog.md#c2--cost-guard-queries-pesadas-en-analyze-investigate).

- **Cuándo**: `agent-workflow:analyze-investigate` (legacy `qtc-analyze:analyze-investigate`) antes de ejecutar query categorizada como **costosa** (>10k filas o seq scan >100k según `references/cost-guard.md`).
- **Forma**: 1 question + preview.
  - `header`: `cost`.
  - `question`: "Esta query estima `<filas>` filas / `<duración>`s en `<server>`. ¿La ejecuto?"
  - `multiSelect`: false.
  - `options`:
    1. "Proceder (Recomendado si esperás el costo)" — "Ejecuta con cost guard registrado en `EVIDENCE.md`."
    2. "Cancelar" — "No la ejecuta; podés reformular o usar muestreo."
  - `preview`: SQL de la query + plan EXPLAIN resumido (5-10 líneas).
- **Refina**: paso 3 ("aviso al usuario") del procedimiento en `qtc-analyze/skills/analyze-investigate/references/cost-guard.md`.
