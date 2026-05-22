---
name: export-qa-note
description: "[STUB] Genera una Nota de Entrega a QA (`.md`) consolidando el corpus de sesiones del workspace y `docs/`. Stub vacío sin lógica activa — implementación diferida a una sesión futura. Output previsto: `docs/funcional/NNN-export-qa-note-YYYY-MM-DD.md`. Read-only sobre el corpus. Invocado sólo vía `/agent-workflow:export-qa-note`. Creado en session081-dev-extend-export-family con `version: 0.1.0`."
version: 0.1.0
---

# Export QA Note — Stub vacío (sin lógica activa)

> **STUB**. Este skill **no genera output útil aún**. Existe como placeholder discoverable para que el catálogo `/agent-workflow:export-*` lo registre. La implementación se difiere a una sesión futura (`flow=design` o `flow=dev`).

## Alcance previsto

Generar un único `.md` con la **Nota de Entrega a QA**, dirigida al equipo de QA para enmarcar el alcance del testing de un release/feature. Suele acompañar a `/agent-workflow:export-scripts` con la diferencia que QA necesita criterios de aceptación + casos de prueba + golden paths, no el bundle SQL.

- **Input canónico**: corpus = sesiones del workflow + `docs/`. Ver `agent-workflow/docs/shared-contract/export-corpus-sources.md` (DEC-002 session081).
- **Subcarpetas de `docs/` que consumirá** (previstas): `docs/scripts/`, `docs/especificaciones/`, `docs/conclusiones/`.
- **Output previsto**: `<docs>/funcional/NNN-export-qa-note-YYYY-MM-DD.md` (sub-decisión a tomar en la sesión de implementación: ¿funcional/ o nueva subcarpeta `qa/`?).

## Estado

- Creado: session081-dev-extend-export-family (2026-05-21).
- Implementación: **diferida**. Cuando se aborde, abrir sesión `flow=design` para spec primero.

## Plan mode

Reglas generales en `skills/session/references/sandbox-readonly-rules.md`. Como el skill es un stub, en plan mode reportar `ok: false` con `reason: "stub not implemented yet"`.

## Recursos

- `agent-workflow/docs/shared-contract/export-corpus-sources.md` — contrato corpus canónico (DEC-002 session081).
- `.workflow/sessions/session081-dev-extend-export-family/OBJECTIVE.md` — alcance de la sesión que creó el stub.
