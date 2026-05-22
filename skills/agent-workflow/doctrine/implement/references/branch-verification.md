# Verificación de rama de trabajo — Stub

> **Documento canónico** en `../session/references/branch-verification.md` (mismo plugin).
>
> El hook `branch-check.py` y el lifecycle `agent-workflow:session` apuntan a esa única fuente de verdad. Esta copia se mantiene como stub para no romper links viejos. No editar contenido aquí — cualquier cambio a la lógica de verificación se hace en `session/references/`.

## Resumen rápido (referencia mínima)

| Caso | Estado | Acción |
|---|---|---|
| A | `match=false, dirty=false` | Pedir confirmación al usuario para `git checkout <expected>`. |
| B | `match=false, dirty=true` | Pausar. Esperar que el usuario resuelva manualmente (commit/stash/discard). |
| C | flow=analyze + edición decidida | Preguntar nombre de rama, ofrecer `checkout` o `checkout -b` desde `main_branch`. |
| Cross | hub mode con divergencia no declarada | Hard gate. Resolver alineando o declarando divergencia explícita. |

Para el flujo completo ver el documento canónico.
