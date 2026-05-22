# S2 — topic-change-detection

Spec literal del prompt S2. Index: [`../prompts-catalog.md#s2--topic-change-detection`](../prompts-catalog.md#s2--topic-change-detection).

- **Cuándo**: durante `execution`, `agent-workflow topic-change-check` retorna `changed=true`.
- **Forma**: 1 question.
  - `header`: `topic-change`.
  - `question`: "El pedido nuevo se desvía del OBJECTIVE actual. ¿Cómo seguimos?"
  - `multiSelect`: false.
  - `options`:
    1. "Cerrar esta y abrir nueva (Recomendado si la divergencia es grande)" — "Cierra session<NNN>, crea nueva con el pedido como OBJECTIVE."
    2. "Extender el OBJECTIVE de la sesión actual" — "Suma el pedido a los criterios; mantiene 1 sola sesión."
    3. "Ignorar (no cambiar nada)" — "Mantiene OBJECTIVE original; el pedido se trata como nota informal."
- **Reemplaza**: prosa en `skills/session/SKILL.md` sección "Topic-change detection".
