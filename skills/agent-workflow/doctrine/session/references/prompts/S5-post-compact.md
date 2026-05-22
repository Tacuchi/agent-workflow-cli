# S5 — post-compact (PostCompact hook)

Spec literal del prompt S5. Index: [`../prompts-catalog.md#s5--post-compact-postcompact-hook`](../prompts-catalog.md#s5--post-compact-postcompact-hook).

- **Cuándo**: el PostCompact hook dispara tras `/compact` o `/agent-workflow:compact`. La SKILL `compact` (o `resume` si el hook delega) ya leyó CHECKPOINT.md y va a presentar resumen al usuario antes de proseguir.
- **Forma**: 1 question.
  - `header`: `post-compact`.
  - `question`: "Compact aplicado. ¿Cómo seguimos?"
  - `multiSelect`: false.
  - `options`:
    1. "Retomar misma sesión" — "Continúa el loop sobre la próxima task abierta del TASKS.md."
    2. "Abrir nueva sesión" — "Cierra esta como `paused` (graduación postergada) y dispara `/agent-workflow:session "<texto>"`."
    3. "Solo recapitular, después decido" — "Imprime resumen del CHECKPOINT y pausa el loop."
  - **Other auto** = instrucción custom (ej. "retomá pero salteá a la T5").
- **Recomendación dinámica**: el AI marca `(Recomendado)` en opción 1 si CHECKPOINT.md indica `tasks_open ≥ 1`; caso contrario marca opción 2.
- **Si CHECKPOINT.md ausente o ilegible**: skip S5 con error informativo y fallback a `session-resume` base.
- **Refina**: paso "Tras compact" en `skills/compact/SKILL.md` y/o sección "PostCompact hook" en `skills/resume/SKILL.md`.
