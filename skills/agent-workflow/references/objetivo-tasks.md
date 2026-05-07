# Objetivo / Tasks / Decisions

Read-only parsers for the four canonical session artifacts.

| Artifact | Reader | Purpose |
|---|---|---|
| `OBJETIVO.md` | `objetivo-data` | requirement, type, modalidad, criterios |
| `TASKS.md` | `tasks-data` | open/closed counts, item list, optional verbose body |
| `DECISIONES.md` | `decisiones-list` | DEC-NNN headers + previews |
| `DEPENDENCIAS.md` | `dependencias-list` | dependency table rows |

All four accept `--code <sessionNNN>`. Without it, the active session is used (errors if there are 0 or >1 active sessions).

## objetivo-data

Parses `OBJETIVO.md` into structured JSON: requirement, contexto, criterios de aceptación (with checked/unchecked state), tipo (`feature`/`refactor`/`bugfix`), modalidad (`tecnica`/`datos`/`incidente`), temas.

```bash
agent-workflow objetivo-data --code session035 | jq '.criterios_aceptacion'
agent-workflow objetivo-data --code session035 | jq '.tipo'
```

## tasks-data

Parses `TASKS.md` into open/closed counts plus the full item list. Supports phased plans (`## Phase X — Title` sections) and surfaces them as task groups.

```bash
agent-workflow tasks-data --code session035
agent-workflow tasks-data --code session035 --only-open    # filter completed items
agent-workflow tasks-data --code session035 --verbose      # include raw markdown body
```

Output:

```json
{
  "code": "session035",
  "counts": { "total": 22, "open": 22, "closed": 0 },
  "phases": [
    { "name": "Phase 0 — Mapeo+Contrato", "open": 4, "closed": 0 },
    ...
  ],
  "items": [
    { "id": "T0.1", "phase": "Phase 0", "text": "...", "done": false }
  ]
}
```

## decisiones-list

Lists `DECISIONES.md` entries — DEC-NNN headers with short previews. Pass `--full` to include the full body of each decision.

```bash
agent-workflow decisiones-list --code session023
agent-workflow decisiones-list --code session023 --full
```

## dependencias-list

Lists `DEPENDENCIAS.md` rows as JSON — useful when a session declares cross-source dependencies.

```bash
agent-workflow dependencias-list --code session035
```
