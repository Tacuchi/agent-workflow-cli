# M5 — modality-analyze (standalone o sesión nueva sin modality)

Spec literal del prompt M5. Index: [`../prompts-catalog.md#m5--modality-analyze-standalone-o-sesión-nueva-sin-modality`](../prompts-catalog.md#m5--modality-analyze-standalone-o-sesión-nueva-sin-modality).

- **Cuándo**: `/agent-workflow:session` con flow=analyze pero sin `## Modality` declarada en el OBJECTIVE (legacy: `## Modalidad` en OBJETIVO.md).
- **Forma**: 1 question.
  - `header`: `modality`.
  - `question`: "¿Qué modalidad de análisis usás?"
  - `multiSelect`: false.
  - `options`:
    1. "Technical (propuesta)" — "Pregunta arquitectónica/diseño; produce `CONCLUSIONS.md` con `## Modality: technical` (legacy: `tecnica`)."
    2. "Data" — "Análisis cuantitativo; produce `CONCLUSIONS.md` con `## Modality: data` (legacy: `datos`)."
    3. "Incident (Post-mortem)" — "Retrospectiva de falla; produce `CONCLUSIONS.md` con `## Modality: incident` (legacy: `incidente`)."
- **Valor persistido**: el AI siempre escribe el valor canónico EN (`technical`/`data`/`incident`) en el OBJECTIVE.md. Los valores ES legacy se aceptan sólo en lectura (sesiones pre-R3).
- **Reemplaza**: prosa en `qtc-analyze/skills/analyze-workflow/SKILL.md` paso 2 del modo standalone. CONCLUSIONS.md vive en la sesión por default; gradúa opt-in con `kind=conclusion` a `docs/conclusiones/`.
