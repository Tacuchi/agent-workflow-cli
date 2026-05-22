# S4 — resume (sesión sin args + ≥2 sesiones activas)

Spec literal del prompt S4. Index: [`../prompts-catalog.md#s4--resume-sesión-sin-args--2-sesiones-activas`](../prompts-catalog.md#s4--resume-sesión-sin-args--2-sesiones-activas).

- **Cuándo**: en `skills/session/SKILL.md`, el usuario invoca `/agent-workflow:session` sin args y `agent-workflow resume-summary` retorna `active_sessions.length ≥ 2`. Reemplaza la heurística silenciosa de "elegir la última".
- **Forma**: 1 question + preview opcional.
  - `header`: `resume`.
  - `question`: "Hay `<N>` sesiones activas. ¿Cuál retomamos?"
  - `multiSelect`: false.
  - `options` (≤4):
    1. "<sessionXXX-flow-slug> (Recomendado por última actividad)" — "<phase> · <last-activity>."
    2. "<sessionYYY-flow-slug>" — "<phase> · <last-activity>."
    3. "<sessionZZZ-flow-slug>" — "<phase> · <last-activity>."
    4. "Abrir nueva sesión" — "Dispara el flujo de creación con prompt de OBJECTIVE."
  - **Other auto** = nombre de sesión custom (folder slug exacto).
- **Preview opcional** (multi-sesión): tabla compacta `code · phase · last-activity · open-tasks` de las 3 más recientes. Ej:

  ```
  code      phase       last-activity       open-tasks
  ───────   ─────────   ─────────────────   ──────────
  002-dev   execution   2026-05-06 10:23    4/7
  003-dev   planning    2026-05-05 18:11    7/7
  001-ana   closure     2026-05-06 01:08    0/7 (graduada)
  ```

- **Si `active_sessions.length = 1`**: skip S4 silencioso, retomar directo. **Si = 0**: skip y abrir nueva sin preguntar.
- **Refina**: paso "Detectar sesión activa" en `skills/session/SKILL.md` flujo "retomar".
