---
name: export-requirement
description: "[STUB] Genera un Requerimiento Funcional (`.md`) consolidando el corpus de sesiones del workspace y `docs/`. Stub vacío sin lógica activa — implementación diferida a una sesión futura. Output previsto: `docs/funcional/NNN-export-requirement-YYYY-MM-DD.md`. Read-only sobre el corpus. Invocado sólo vía `/agent-workflow:export-requirement`. Creado en session081-dev-extend-export-family con `version: 0.1.0`."
version: 0.1.0
---

# Export Requirement — Stub vacío (sin lógica activa)

> **STUB**. Este skill **no genera output útil aún**. Existe como placeholder discoverable para que el catálogo `/agent-workflow:export-*` lo registre. La implementación se difiere a una sesión futura (`flow=design` o `flow=dev`).

## Alcance previsto

Generar un único `.md` con el **Requerimiento Funcional** consolidado del workspace, dirigido a stakeholders de negocio/producto (no técnico). Audiencias típicas: PO, líder de área, auditoría funcional.

- **Input canónico**: corpus = sesiones del workflow + `docs/`. Ver `agent-workflow/docs/shared-contract/export-corpus-sources.md` (DEC-002 session081).
- **Subcarpetas de `docs/` que consumirá** (previstas): `docs/especificaciones/`, `docs/decisiones/`, `docs/funcional/`.
- **Output previsto**: `<docs>/funcional/NNN-export-requirement-YYYY-MM-DD.md`.

## Estado

- Creado: session081-dev-extend-export-family (2026-05-21).
- Implementación: **diferida**. Cuando se aborde, abrir sesión `flow=design` para spec primero (siguiendo el patrón session056 → session057 que sí funcionó para `export-report`).

## Plan mode

Reglas generales en `skills/session/references/sandbox-readonly-rules.md`. Como el skill es un stub, en plan mode reportar `ok: false` con `reason: "stub not implemented yet"` y referenciar esta sesión.

## Recursos

- `agent-workflow/docs/shared-contract/export-corpus-sources.md` — contrato corpus canónico (DEC-002 session081).
- `.workflow/sessions/session081-dev-extend-export-family/OBJECTIVE.md` — alcance de la sesión que creó el stub.
