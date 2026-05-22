# M8 — refactor-cleanup (eliminación de paths legacy)

Spec literal del prompt M8. Index: [`../prompts-catalog.md#m8--refactor-cleanup-eliminación-de-paths-legacy`](../prompts-catalog.md#m8--refactor-cleanup-eliminación-de-paths-legacy).

- **Cuándo**: en `qtc-dev/skills/refactor` después de Phase 2 cerrada y validación e2e confirmada por el usuario (`status: validating` → `completed`).
- **Forma**: 1 question.
  - `header`: `cleanup`.
  - `question`: "Refactor de `<feature>` validado e2e. ¿Elimino `<path>-legacy/` definitivamente?"
  - `multiSelect`: false.
  - `options`:
    1. "Sí, eliminar legacy (Recomendado)" — "Ejecuta `git rm -r <path>-legacy/`. REFACTOR.md actualiza `legacy_purged: true` y queda en la sesión (no se gradúa con kind dedicado — DEC-003)."
    2. "Mantener temporalmente" — "Deja legacy en disco; REFACTOR.md marca `legacy_purged: false` con TODO. Cleanup queda para sesión follow-up."
    3. "Cancelar" — "No toca nada. El closure no completa hasta resolver."
  - **Other auto** = motivo del retraso del cleanup (se registra en REFACTOR.md como nota).
- **Si `status` no es `validating`**: skip M8 con error informativo ("Cleanup requiere validación e2e previa; estado actual: `<status>`").
- **Refina**: paso "Cleanup" en `qtc-dev/skills/refactor/SKILL.md`.
