# doctrine/

Reglas universales del lifecycle que aplican siempre, agnóstico de empresa.

Contenido esperado (T2 PR2):

- `commits-policy.md` — propose-then-execute, M1, sin firmas auto, ≤72 chars.
- `branch-verification.md` — gate de rama por fuente (casos A/B/C).
- `redaccion-simple.md` — estilo de prosa para artefactos.
- `sandbox-readonly-rules.md` — plan mode = sin mutaciones.
- `mcp-readonly.md` — MCP SELECT/EXPLAIN sí, DDL/DML no.
- `graduacion-routing.md` — defaults por kind + hub vs fuente.
- `prompts-catalog.md` — M1/M10/S2/S3/S6/S7 prompts canónicos.

Refs cruzadas (`[[name]]`) entre archivos permitidas. Léxico empresa-específico se inyecta vía `profile.lexicon_path`.
