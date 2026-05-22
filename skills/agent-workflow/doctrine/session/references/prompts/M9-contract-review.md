# M9 — contract-review (RETIRADO)

> **RETIRADO** por DEC-002 de `session049-analyze-mejoras-flujos-qtc-runtime` (graduada como `docs/conclusiones/005-mejoras-flujos-qtc-runtime.md`). Implementado en `session050-dev-design-md-and-s7-gate`.
>
> **Reemplazo**: el gate de design review se movió de post-stub (M9, al cerrar Phase 0) a pre-stub (S7, antes de Phase 0). Ver `S7-design-review.md`.
>
> **Razón**: el usuario rechazó la doble-review en un mismo ciclo de desarrollo. La revisión post-implementación se delega al skill futuro `agent-workflow:review <sessionNNN>` (placeholder DEC-002 / R5 de CONCLUSIONS session049), que opera sobre sesiones cerradas en lugar de dentro de la misma sesión.
>
> **Patrón equivalente**: mismo mecanismo que M12 (eliminado por DEC-002 del catálogo). Este archivo se conserva como referencia histórica; las refs a M9 en doctrina activa fueron migradas a S7.

---

## Spec original (referencia histórica)

Index: [`../prompts-catalog.md#m9--contract-review-validación-opcional-al-cerrar-phase-0`](../prompts-catalog.md#m9--contract-review-validación-opcional-al-cerrar-phase-0).

- **Cuándo (legacy)**: en `qtc-dev/skills/implement` exclusivamente al cerrar la primera phase (Contrato) de una sesión `## Tipo: feature|refactor` — sección `## Phase 0 — Contrato` o sus sinónimos `## Fase 0`/`## Sprint 0`/`## Etapa 0`. Se disparaba **antes** de M6 si el spec del cableado tenía ≥1 endpoint o ≥1 interface no triviales.
- **Forma (legacy)**: 1 question + preview ASCII rico.
  - `header`: `contract`.
  - `question`: "Cableado FE↔BE↔DB listo (Phase 0). ¿Validás el contrato visualmente antes de Phase 1?"
  - `multiSelect`: false.
  - `options`:
    1. "Sí, lo pruebo (Recomendado)" — "Pausa el loop antes de M6. Vos abrís FE/BE/cliente HTTP y verificás que el skeleton responde con mocks. Cuando confirmes, dispara M6."
    2. "Saltar, confío en el spec" — "Va directo a M6 phase-gate."
  - **Other auto (legacy)** = nota libre (ej. "lo probaré al cerrar Phase 1, sigamos") — equivalente a saltar pero registra contexto.
- **Preview obligatorio (legacy)**: tabla del cableado declarado + fila Routing (v2.7+):

  ```
  Capa      Símbolo                           Estado
  ───────   ──────────────────────────────    ───────
  FE        CategoriasService.list()          mock []
  FE        CategoriasService.save(req)       throw new Error('not impl')
  BE        GET /api/categorias               501
  BE        PATCH /api/categorias/{id}        501
  DB        fn_categorias_listar              RETURN '[]'::jsonb
  Routing   FE → BE (navegación e2e)          /login → /home consume mock OK
  ```

- **Sesiones legacy** que referencian M9 en sus HISTORY refs siguen siendo legibles — ningún parser falla por una mención histórica. La doctrina activa ya no contiene refs a M9.
