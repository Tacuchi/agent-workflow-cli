# M6 — phase-gate (transición entre phases en implement)

Spec literal del prompt M6. Index: [`../prompts-catalog.md#m6--phase-gate-transición-entre-phases-en-implement`](../prompts-catalog.md#m6--phase-gate-transición-entre-phases-en-implement).

- **Cuándo**: en `qtc-dev/skills/implement` ejecutando una sesión `flow=dev` con `## Tipo: feature|refactor`, después de cerrar todas las tareas de una sección `## (Phase|Fase|Sprint|Etapa) X — Y` en TASKS.md y antes de abrir tasks de la siguiente. Las 4 variantes son sinónimos sin diferencia funcional — ver apéndice "Convención de naming phased".
- **Forma**: 1 question + preview opcional cuando current_phase=0 (cableado).
  - `header`: `phase-gate`.
  - `question`: "Phase `<X>` (`<title-actual>`) cerrada. ¿Avanzamos a Phase `<X+1>` (`<title-siguiente>`)?"
  - `multiSelect`: false.
  - `options`:
    1. "Avanzar a Phase `<X+1>` (Recomendado)" — "Continúa el loop con tareas de la siguiente phase."
    2. "Pausar — quiero probar el cableado antes" — "Detiene el loop. El usuario testea (FE/BE/DB según corresponda) y avisa cuando retomar."
    3. "Re-iterar Phase `<X>`" — "Re-abre tareas de la phase actual; útil si surgió algo que falta antes de avanzar."
  - **Other auto** = nota informativa libre (no avanza ni retrocede; queda registrada como contexto en DECISIONS si aporta).
- **Preview opcional** (cuando `current_phase=0`): tabla compacta de endpoints/interfaces declarados en Phase 0, ej:

  ```
  Layer       Item
  ─────────   ──────────────────────────────────
  FE service  CategoriasService.list/save/delete
  FE iface    CategoriaSaveRequest (sparse)
  BE Ctrl     CategoriasController @PatchMapping
  BE DTO      CategoriaSaveRequest record (nullable)
  DB fn       fn_categorias_listar (mock devuelve fila vacía)
  ```

- **Si todas las tasks de la phase quedan cerradas y no hay siguiente phase declarada en TASKS.md**: skip M6 y propagar a `validation` directamente.
- **Hasta 5 invocaciones por sesión phased completa (v2.7+)**: con el modelo extendido Phase 0-5 las transiciones posibles son 0→1, 1→2, 2→3, 3→4, 4→5. M6 puede dispararse en cada una. **Skip silencioso** cuando:
  - La phase siguiente está **vacía** (ej. Phase 4 — Seguridad placeholder sin tasks abiertas; Phase 3→Phase 5 directo si Phase 4 omitida).
  - La phase siguiente **no está declarada en TASKS.md** (ej. Phase 5 opt-in ausente; Phase 3→validation directo).
- **Refina**: nueva sección "Phased mode" en `qtc-dev/skills/implement/SKILL.md` (v2.7+ — 6 phases).
