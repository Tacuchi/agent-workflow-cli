# M11 — context (auto-trigger por carga de contexto)

Spec literal del prompt M11. Index: [`../prompts-catalog.md#m11--context-auto-trigger-por-carga-de-contexto`](../prompts-catalog.md#m11--context-auto-trigger-por-carga-de-contexto).

- **Cuándo**: en `skills/compact/SKILL.md`, cuando el AI estima carga de contexto >75% del modelo activo (heurística manual; no medición exacta de tokens). Early warning antes de truncamiento de tool calls.
- **Forma**: 1 question.
  - `header`: `context`.
  - `question`: "El contexto está al ~`<%>%`. ¿Compact ahora o seguimos?"
  - `multiSelect`: false.
  - `options`:
    1. "Compact ahora (Recomendado)" — "Persiste estado en CHECKPOINT.md y dispara `/compact`. El loop continúa post-compact con la sesión retomada."
    2. "Seguir, compact después" — "Continúa la tarea actual; intenta compact en próxima pausa natural (entre tasks)."
    3. "Cerrar sesión" — "Pasa a `closure`; útil si la tarea actual ya cumplió el OBJECTIVE."
  - **Other auto** = instrucción custom (ej. "compact + cerrá sesión").
- **Si la sesión está en `closure` activa**: skip M11 (closure ya dispara su propio compact opcional).
- **Refina**: nueva sección "Auto-trigger por contexto" en `skills/compact/SKILL.md`.
