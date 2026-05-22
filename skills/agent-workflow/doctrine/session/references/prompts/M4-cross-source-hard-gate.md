# M4 — cross-source-hard-gate (hub mode con divergencia)

Spec literal del prompt M4. Index: [`../prompts-catalog.md#m4--cross-source-hard-gate-hub-mode-con-divergencia`](../prompts-catalog.md#m4--cross-source-hard-gate-hub-mode-con-divergencia).

- **Cuándo**: workspace `Mode: hub` y `cross_source_consistent=false` reportado por `agent-workflow sources`.
- **Forma**: 1 question + (si elige alinear) prompt encadenado.

**Prompt 1**:
- `header`: `cross-branch`.
- `question`: "Las fuentes apuntan a ramas distintas. ¿Cómo resolvés?"
- `multiSelect`: false.
- `options`:
  1. "Alinear todas a una misma rama (Recomendado)" — "Preguntará cuál rama y aplicará Caso A por fuente divergente."
  2. "Declarar divergencia explícita" — "Re-crea la sesión con `--branches alias:rama` distintos, o actualiza con `project-md-upsert --update-phase`."
  3. "Cancelar" — "Aborta y deja al usuario decidir manualmente."
- **`preview`** opcional (ASCII): tabla `alias → current → expected` de `divergent_sources`. Ej:

  ```
  alias       current             expected
  ─────────   ───────────────     ─────────────
  core        certificacion       certificacion
  dev         feature/foo         certificacion
  analyze     feature/foo         certificacion
  ```

**Prompt 2** (solo si elige "Alinear todas"):
- `header`: `target-branch`.
- `question`: "¿A qué rama alineamos las fuentes divergentes?"
- `options` (≤4):
  1. "Current consensus" — la rama con más fuentes apuntando.
  2. "Expected (de la sesión)" — la rama declarada en `Status → Sesiones activas`.
  3. Otras candidates concretas si las hay.
- **Other auto** = nombre de rama custom.
