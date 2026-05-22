# M10 — next-step (cierre de planning)

Spec literal del prompt M10. Index: [`../prompts-catalog.md#m10--next-step-cierre-de-planning`](../prompts-catalog.md#m10--next-step-cierre-de-planning).

- **Cuándo**: en `skills/session/SKILL.md`, al cierre de la fase `planning` después de TASKS.md producido y antes de iniciar `execution`. Solo si TASKS.md tiene ≥1 task abierta.
- **Forma**: 1 question.
  - `header`: `next-step`.
  - `question`: "Plan listo. ¿Cómo arrancamos execution?"
  - `multiSelect`: false.
  - `options`:
    1. "Ejecutar todo end-to-end" — "Loop sobre tasks; pausa solo si M6 phase-gate u otro must se dispara."
    2. "T1+T2 en paralelo" — "Dispara las 2 primeras tareas independientes en agentes paralelos; consolida outputs antes de seguir."
    3. "Una task por vez, confirmá cada cierre" — "Loop con pausa explícita post-task."
  - **Other auto** = instrucción custom (ej. "primero T3, después el resto").
- **Recomendación dinámica**: el AI marca `(Recomendado)` en opción 1 si `tasks_count ≤5 ∧ eta_total ≤4h` (estima por TASKS.md: S=0.5h, M=2h, L=4h). Caso contrario, marca opción 2.
- **Si TASKS.md está vacío o ausente**: skip M10 con error informativo ("Plan ausente; arrancá execution con `agent-workflow phase-next` o regenerá TASKS.md").
- **Refina**: nueva sección "Cierre de planning" en `skills/session/SKILL.md`.
