# workflows/

Flows del lifecycle: cómo se mueve una sesión por sus fases.

Contenido esperado (T2 PR2):

- `dev-workflow.md` — planning → execution → validation → closure; M1 ask antes de commit; gates por fase.
- `design-workflow.md` — discovery → design → spec → closure; produce DELIVERY.md graduable.
- `analyze-workflow.md` — discovery → evidence → findings → conclusions; produce CONCLUSIONS.md.
- `core-workflow.md` — sub-flow agnóstico embebido en los 3 anteriores (artefactos comunes).

Cada workflow declara: phases, artefactos requeridos, prompts (M1/M10/S2/S3/S6/S7) y transitions válidas.
