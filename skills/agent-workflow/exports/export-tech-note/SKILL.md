---
name: export-tech-note
description: "[STUB] Genera una Nota Técnica (`.md`) consolidando el corpus de sesiones del workspace y `docs/`. Stub vacío sin lógica activa — implementación diferida a una sesión futura. Output previsto: `docs/manuales/NNN-export-tech-note-YYYY-MM-DD.md` o `docs/funcional/`. Read-only sobre el corpus. Invocado sólo vía `/agent-workflow:export-tech-note`. Creado en session081-dev-extend-export-family con `version: 0.1.0`."
version: 0.1.0
---

# Export Tech Note — Stub vacío (sin lógica activa)

> **STUB**. Este skill **no genera output útil aún**. Existe como placeholder discoverable para que el catálogo `/agent-workflow:export-*` lo registre. La implementación se difiere a una sesión futura (`flow=design` o `flow=dev`).

## Alcance previsto

Generar un único `.md` con una **Nota Técnica** consolidada del workspace, dirigida a stakeholders técnicos (devs, líderes técnicos, soporte). Más compacta que `export-tech-manuals` (que es un manual completo); más profunda que `export-report` (que es ejecutivo no técnico).

- **Input canónico**: corpus = sesiones del workflow + `docs/`. Ver `agent-workflow/docs/shared-contract/export-corpus-sources.md` (DEC-002 session081).
- **Subcarpetas de `docs/` que consumirá** (previstas): `docs/manuales/`, `docs/decisiones/`, `docs/conclusiones/`, `docs/arq/`.
- **Output previsto**: `<docs>/manuales/NNN-export-tech-note-YYYY-MM-DD.md` (sub-decisión a tomar en la sesión de implementación: ¿manuales/ o funcional/ técnica?).

## Estado

- Creado: session081-dev-extend-export-family (2026-05-21).
- Implementación: **diferida**. Cuando se aborde, abrir sesión `flow=design` para spec primero.

## Plan mode

Reglas generales en `skills/session/references/sandbox-readonly-rules.md`. Como el skill es un stub, en plan mode reportar `ok: false` con `reason: "stub not implemented yet"`.

## Recursos

- `agent-workflow/docs/shared-contract/export-corpus-sources.md` — contrato corpus canónico (DEC-002 session081).
- `.workflow/sessions/session081-dev-extend-export-family/OBJECTIVE.md` — alcance de la sesión que creó el stub.
