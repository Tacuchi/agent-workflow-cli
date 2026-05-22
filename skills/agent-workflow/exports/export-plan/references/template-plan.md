# Template — Plan ejecutable (output de `/agent-workflow:export-plan`)

Plantilla canónica del archivo generado en `docs/planes/NNN-<slug>-YYYY-MM-DD.md`. El skill `export-plan` la aplica reemplazando los placeholders con datos derivados del corpus.

## Estructura

````markdown
---
state: draft
sessions: [<NNN1>, <NNN2>, ...]
created: <YYYY-MM-DD>
slug: <kebab-slug>
eta_total: <Nh|Nd>
state_changes:
  - {from: null, to: draft, when: <YYYY-MM-DDThh:mm:ssZ>, trigger: 'export-plan create'}
dependencies_external: []
risks: []
---

# Plan — <Título derivado del corpus>

## Resumen

<2-3 párrafos. Objetivo común derivado de los OBJECTIVEs de las sesiones fuente. Audiencia. Output esperado del plan. Sin jerga inventada.>

## Fases

### <Fase 1 — nombre>

- **Entrada**: <criterios>
- **Salida**: <criterios>

### <Fase 2 — nombre>

- **Entrada**: <criterios>
- **Salida**: <criterios>

<repetir por fase>

## Tasks

| ID  | Task                                    | ETA | Fase     | Depende de | Sesión origen        |
|-----|-----------------------------------------|-----|----------|------------|----------------------|
| T1  | <descripción accionable>                | 1h  | planning | —          | session055:T3        |
| T2  | <descripción accionable>                | 2h  | exec     | T1         | session057:T1        |
| T3  | <descripción accionable> [done]         | 0.5h| exec     | —          | session061:T2        |
| ... | ...                                     | ... | ...      | ...        | ...                  |

Total: ≈<N>h en <M> tareas (<M_open> abiertas, <M_done> ya cerradas en sus sesiones origen).

## Dependencias externas

- <Librería/servicio/equipo>: <razón + bloqueante o no>
- ...

## Riesgos

- **R1 — <descripción corta>**. Mitigación: <acción>. Origen: `<sessionXXX-...>:FINDINGS.md#F-X`.
- ...

## Refs

- `session055-analyze-docs-from-sessions` — [`OBJECTIVE`](../.workflow/sessions/session055-analyze-docs-from-sessions/OBJECTIVE.md) · [`CONCLUSIONS`](../.workflow/sessions/session055-analyze-docs-from-sessions/CONCLUSIONS.md)
- `session057-dev-export-func` — [`OBJECTIVE`](../.workflow/sessions/session057-dev-export-func/OBJECTIVE.md) · [`TASKS`](../.workflow/sessions/session057-dev-export-func/TASKS.md)
- ...
````

## Reglas de uso

- **Frontmatter obligatorio**: `state`, `sessions`, `created`, `slug`, `state_changes` siempre presentes.
- **Frontmatter opcional**: `eta_total`, `dependencies_external`, `risks` — incluir si hay datos derivables; omitir si vacío.
- **Idioma**: ES default (idioma del usuario en el hub). Headers EN canon (`Plan`, `Resumen`, `Fases`, `Tasks`, etc. quedan EN porque son discriminators canónicos).
- **Tabla Tasks**: usar pipes Markdown estándar. Marcar `[done]` las tareas ya cerradas en sus sesiones origen (sufijo después de la descripción).
- **Refs**: paths relativos desde `docs/planes/NNN-*.md` (sube `..` para llegar al workspace root, luego baja a `.workflow/sessions/...`).
- **state_changes[]**: append-only. Cada transición añade un objeto. Nunca borrar entradas previas (auditoría).

## Ejemplo mínimo (smoke test)

````markdown
---
state: draft
sessions: [055, 061]
created: 2026-05-18
slug: export-plan
eta_total: 6h
state_changes:
  - {from: null, to: draft, when: '2026-05-18T22:00:00Z', trigger: 'export-plan create'}
---

# Plan — Consolidación familia export-* + scripts

## Resumen

Consolidación de la propuesta familia `/agent-workflow:export-*` (session055) y el dev de export-scripts (session061) en un plan ejecutable que cubra los gaps restantes del bundle. Audiencia: equipo runtime agent-workflow. Output esperado: 2-3 sesiones dev secuenciadas que cierren docs/conclusiones/007.

## Fases

### planning
- **Entrada**: session055 cerrada con CONCLUSIONS graduada.
- **Salida**: TASKS.md aprobado por usuario.

### exec
- **Entrada**: planning ok.
- **Salida**: skills + commands creados, tests verdes.

### closure
- **Entrada**: exec ok.
- **Salida**: HISTORY actualizada, CHECKPOINT.md, plan en state `done`.

## Tasks

| ID | Task | ETA | Fase | Depende de | Sesión origen |
|----|------|-----|------|------------|---------------|
| T1 | Validar contrato familia export-* en propuesta 007 | 1h | planning | — | session055:T2 |
| T2 | Implementar skill export-plan | 4.5h | exec | T1 | (nueva) |
| T3 | Implementar skill export-conclusions | 3h | exec | T1 | (nueva) |

Total: ≈8.5h en 3 tareas (3 abiertas).

## Dependencias externas

- Ninguna externa al runtime agent-workflow.

## Riesgos

- **R1 — Mismatch con propuesta 007 (familia cerrada en 4 comandos)**. Mitigación: actualizar 007 o emitir Propuesta 008. Origen: `session055-analyze-docs-from-sessions:CONCLUSIONS.md#R7`.

## Refs

- `session055-analyze-docs-from-sessions` — [`OBJECTIVE`](../.workflow/sessions/session055-analyze-docs-from-sessions/OBJECTIVE.md) · [`CONCLUSIONS`](../.workflow/sessions/session055-analyze-docs-from-sessions/CONCLUSIONS.md)
- `session061-dev-export-scripts` — [`OBJECTIVE`](../.workflow/sessions/session061-dev-export-scripts/OBJECTIVE.md)
````
