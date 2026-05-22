# M2 — branch-caso-A (rama distinta, repo limpio)

Spec literal del prompt M2. Index: [`../prompts-catalog.md#m2--branch-caso-a-rama-distinta-repo-limpio`](../prompts-catalog.md#m2--branch-caso-a-rama-distinta-repo-limpio).

- **Cuándo**: una fuente tiene `match=false` y `dirty=false`.
- **Forma**: 1 question.
  - `header`: `branch:<alias>` (ej. `branch:core`).
  - `question`: "La fuente `<alias>` está en `<current>` pero esperaba `<expected>`. ¿Qué hago?"
  - `multiSelect`: false.
  - `options`:
    1. "Hacer checkout (Recomendado)" — "Ejecuta `git -C <path> checkout <expected>` y reintenta la acción."
    2. "Mantener current" — "Actualiza la sesión con `project-md-upsert --update-phase --branches <alias>:<current>` para que `<current>` sea la rama esperada."
    3. "Cancelar" — "Aborta la acción que disparó el check."
- **Detalles operacionales** en `branch-verification.md` Caso A.
