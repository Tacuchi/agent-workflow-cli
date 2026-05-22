# S7 — design-review (gate de aprobación del DESIGN.md antes de Phase 0)

Spec literal del prompt S7. Index: [`../prompts-catalog.md#s7--design-review-gate-de-aprobación-del-designmd-antes-de-phase-0`](../prompts-catalog.md#s7--design-review-gate-de-aprobación-del-designmd-antes-de-phase-0).

- **Cuándo**: en `skills/session/SKILL.md` al cerrar planning, tras producir `DESIGN.md`, antes de M10. Aplica a `flow=dev` con `## Type: feature|refactor` (resuelto vía Capa 1/2/3 — ver `skills/dev-workflow/SKILL.md` §"Resolución del `## Type`"). Always-on para esos tipos; confirmación explícita obligatoria.
- **Skip silencioso**: `## Type: bugfix|chore` (en esos casos DESIGN.md no se produce y este gate no aplica).
- **Forma**: 1 question + preview ASCII opcional (resumen 1-pantalla del DESIGN.md).
  - `header`: `design-review`.
  - `question`: "DESIGN.md listo. ¿Lo revisás antes de que arranque a codear?"
  - `multiSelect`: false.
  - `options`:
    1. "Sí, lo reviso (Recomendado)" — "Pausa el loop. Abrí `DESIGN.md`, editá o comentá. Cuando decís 'listo / sigamos / ok / approved', arranca Phase 0."
    2. "Approve as-is" — "Aprobás el diseño tal cual sin editarlo. Va directo a Phase 0."
    3. "Refinar antes" — "El AI pregunta qué sección/decisión ajustar (sub-prompt libre, no estructurado), itera `DESIGN.md` y vuelve a disparar S7 con el doc actualizado."
  - **Other auto** = feedback puntual aplicado al `DESIGN.md` con re-disparo de S7. Ej: "renombrá `PdfRenderer` a `HtmlToPdfRenderer` y seguí" → el AI aplica al doc, dispara S7 nuevamente, el usuario confirma con opción 1 o 2.
- **Preview ASCII (opcional pero recomendado)**:

  ```
  Design summary — session<NNN>
  ─────────────────────────────
  Sections: Context · Goals · Non-goals · Current/Target ·
            New interfaces · Wiring · <N> decisions · <M> open questions

  Top 3 decisions:
    1. <decisión 1 título>
    2. <decisión 2 título>
    3. <decisión 3 título>

  Open questions:
    - <pregunta 1>
    - <pregunta 2>
    (si M=0, mostrar "None")
  ```

- **Confirmación obligatoria**: el gate no avanza a Phase 0 hasta señal explícita del usuario. Sin timeout ni silent skip. Las opciones 1/2 cuentan como confirmación; la opción 3 + Other son loops de iteración que terminan en confirmación 1 o 2 eventualmente.
- **Refina**: paso "Cierre de planning" en `skills/session/SKILL.md` (producir DESIGN.md antes de M10 si flow=dev y type feature|refactor).
- **Reemplaza**: M9 (contract-review). M9 disparaba al CIERRE de Phase 0 (post-stub). S7 dispara ANTES de Phase 0 (pre-stub). La validación post-implementación se delega al skill futuro `agent-workflow:review <sessionNNN>` (placeholder DEC-002 de session049-analyze-mejoras-flujos-qtc-runtime, R5 de CONCLUSIONS).
