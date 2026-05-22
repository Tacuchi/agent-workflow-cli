# M3 — branch-caso-C (analyze pasa a editar)

Spec literal del prompt M3. Index: [`../prompts-catalog.md#m3--branch-caso-c-analyze-pasa-a-editar`](../prompts-catalog.md#m3--branch-caso-c-analyze-pasa-a-editar).

- **Cuándo**: durante `execution` de una sesión `flow=analyze`, el usuario decide editar código.
- **Forma**: 2 prompts encadenados.

**Prompt 1 — nombre de rama de trabajo**:
- `header`: `work-branch`.
- `question`: "¿Cómo se llama la rama de trabajo para `<alias>`?"
- `multiSelect`: false.
- `options`:
  1. "Usar `feature/session<NNN>-<slug>` (Recomendado)" — "Sugerencia por convención."
  2. "Otra (escribir abajo)" — "Use el campo libre debajo para especificar otro nombre."
- **Other auto** = el usuario escribe el nombre alternativo de la rama.

**Prompt 2 — checkout o create**:

Si `git -C <path> rev-parse --verify <work_branch>` exit 0 (rama existe):
- `header`: `checkout`.
- `question`: "La rama `<work_branch>` existe en `<alias>`. ¿Hago `git checkout`?"
- `options`:
  1. "Sí, checkout (Recomendado)".
  2. "Cancelar".

Si exit ≠ 0 (no existe):
- `header`: `branch-new`.
- `question`: "La rama `<work_branch>` no existe en `<alias>`. ¿La creo desde `<main_branch>`?"
- `options`:
  1. "Sí, `checkout -b <work_branch> <main_branch>` (Recomendado)".
  2. "Cancelar".

Tras el checkout/create, registrar en AW-PROJECT.Status vía `project-md-upsert --update-phase <folder> --branches <alias>:<work_branch>`. Detalles en `branch-verification.md` Caso C.
