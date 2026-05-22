# specialties/

Kinds graduables al cerrar sesión. Cada specialty declara cómo se materializa el artefacto final y su routing (hub vs fuente).

Contenido esperado (T2 PR2):

- `decision.md` — decisión arquitectónica (hub).
- `manual.md` — manual técnico (fuente).
- `script.md` — script SQL/bash (fuente).
- `especificacion.md` — spec de feature/system (hub).
- `conclusion.md` — conclusión de analyze (hub).
- `release.md` — release notes (fuente).

Routing automático lo provee `agent-workflow graduation-routing` según `workspace_mode` y kind. Sólo estos 6 graduan al cerrar — el resto queda en sesión.
