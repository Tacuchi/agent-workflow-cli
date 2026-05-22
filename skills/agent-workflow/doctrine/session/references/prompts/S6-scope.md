# S6 — scope (auto-plan-decide retorna `full` con ETA >4h)

Spec literal del prompt S6. Index: [`../prompts-catalog.md#s6--scope-auto-plan-decide-retorna-full-con-eta-4h`](../prompts-catalog.md#s6--scope-auto-plan-decide-retorna-full-con-eta-4h).

- **Cuándo**: en `skills/session/SKILL.md` durante planning, `agent-workflow auto-plan-decide` retorna `decision=full` y la AI estima `eta_total > 4h` agregando estimas de TASKS.md (S=0.5h, M=2h, L=4h). Aviso anticipado de scope demasiado grande para una sola sesión.
- **Forma**: 1 question.
  - `header`: `scope`.
  - `question`: "Scope estimado: `<N>` tasks · ETA `<X>h`. ¿Cómo procedemos?"
  - `multiSelect`: false.
  - `options`:
    1. "Lite primero (3 tasks core) (Recomendado)" — "Reduce TASKS.md a las 3 más críticas; el resto queda parking. Cerramos rápido y abrimos sesión 2 si hace falta."
    2. "Full (proceder con TASKS.md actual)" — "Mantiene el plan completo; la sesión queda larga pero coherente."
    3. "Split en 2 sesiones" — "Divide TASKS.md en sessionA (T1-T<k>) + sessionB (T<k+1>-Tn) con dependencia explícita; descomposición por dependencias del DAG."
  - **Other auto** = instrucción custom (ej. "lite con T1, T3, T5").
- **Si `tasks_count ≤ 3`**: skip S6 (scope ya es lite por construcción, sin importar ETA).
- **Refina**: paso "Auto-plan output" en `skills/session/SKILL.md` planning phase.
