# Template — Documento curado (output de `/agent-workflow:export-conclusions`)

Plantilla canónica del archivo generado en `docs/conclusiones/NNN-<slug>-YYYY-MM-DD.md`. El skill `export-conclusions` la aplica reemplazando los placeholders con datos derivados del corpus.

## Estructura

````markdown
---
sessions: [<NNN1>, <NNN2>, ...]
created: <YYYY-MM-DD>
slug: <kebab-slug>
recommendations_count: <N>
roadmap_present: <true|false>
conflicts_count: <N>
---

# Conclusiones consolidadas — <Título derivado del dominio común>

## Resumen ejecutivo

<2-3 párrafos. Dominio común derivado de los Summary/Modality de las CONCLUSIONS.md fuente. Audiencia. Estado del dominio antes/después.>

## Sesiones consolidadas

| Code | Flow | Slug | Modalidad CONCLUSIONS | C-items | R-items |
|------|------|------|------------------------|---------|---------|
| 055  | analyze | docs-from-sessions | technical | 8 | 7 |
| 057  | dev  | export-func        | (n/a)     | — | — |
| 061  | dev  | export-scripts     | (n/a)     | — | — |
| 062  | analyze | export-plan-lifecycle | technical | 8 | 8 |

> Sesiones del corpus inicial que no aparecen acá fueron descartadas por **no tener CONCLUSIONS.md**.

## Conclusions (por sesión)

> No se deduplican — son específicos del análisis original. Se preservan con trazabilidad.

### session055-analyze-docs-from-sessions

- **C1** — <texto>. [`origen`](../.workflow/sessions/session055-analyze-docs-from-sessions/CONCLUSIONS.md#c1)
- **C2** — <texto>.
- ...

### session062-analyze-export-plan-lifecycle

- **C1** — <texto>.
- ...

## Recommendations consolidadas (deduplicadas)

> Aplicó dedup por slug (ver `references/dedup-rules.md`). Cada entry preserva `origins[]`.

### R1-consolidado — <slug derivado>

- **Origen**: session055:R3 + session062:R7
- **Síntesis**: <párrafo unificador de los R-items origen>.
- **Acción sugerida**: <accionable concreto>.
- **Responsable sugerido**: <rol/equipo, opcional>.

### R2-consolidado — <slug>

...

## R-Conflicts detectados (si aplica)

> Acciones contradictorias bajo mismo slug. Queda al usuario decidir.

### R-Conflict#1 — <slug>

- **Origen A**: session057:R2 → "Refactorizar X usando estrategia Y".
- **Origen B**: session061:R4 → "Mantener X como está; migrar Y primero".
- **Decisión sugerida**: <propuesta del AI o "queda al usuario">.

## Roadmap derivado (opcional)

> Solo se incluye si ≥3 R-items consolidados. Re-secuenciado por dependencias detectadas.

| Sprint | Sesión sugerida                          | R-items que cubre | ETA  | Dependencia |
|--------|------------------------------------------|-------------------|------|-------------|
| 1      | sessionNNN-dev-<slug-A>                  | R1, R3            | ≈4h  | —           |
| 2      | sessionNNN-dev-<slug-B>                  | R2                | ≈3h  | S1 ok       |
| 3      | sessionNNN-design-<slug-C>               | R4, R5            | ≈2h  | S1 ok       |

Total: ≈9h en 3 sesiones derivadas.

## Refs

- `session055-analyze-docs-from-sessions` — [`CONCLUSIONS`](../.workflow/sessions/session055-analyze-docs-from-sessions/CONCLUSIONS.md)
- `session062-analyze-export-plan-lifecycle` — [`CONCLUSIONS`](../.workflow/sessions/session062-analyze-export-plan-lifecycle/CONCLUSIONS.md)
- ...

## Sesiones excluidas del corpus

> Listadas para trazabilidad — no tenían CONCLUSIONS.md al momento del export.

- session057-dev-export-func (`flow=dev`, sin CONCLUSIONS por diseño)
- session061-dev-export-scripts (`flow=dev`, sin CONCLUSIONS por diseño)
````

## Reglas de uso

- **Frontmatter obligatorio**: `sessions`, `created`, `slug`, `recommendations_count`, `roadmap_present`, `conflicts_count`.
- **Idioma**: ES default. Headers EN canon (`Resumen ejecutivo`, `Sesiones consolidadas`, `Conclusions`, `Recommendations consolidadas`, `Refs`).
- **C-items**: preservar 1-a-1 con sesión origen. No deduplicar.
- **R-items**: aplicar dedup según `references/dedup-rules.md`. Cada R consolidado lista `origins[]` para trazabilidad.
- **R-Conflicts**: bloque separado al final del consolidado. Decisión queda al usuario.
- **Roadmap**: omitir sección entera si `<3 R-items consolidados`.
- **Sesiones excluidas**: incluir solo si hubo descartes (≥1 sesión sin CONCLUSIONS.md filtrada).

## Ejemplo mínimo (1 sesión input)

Cuando solo hay 1 sesión con CONCLUSIONS.md (caso pesimista), el skill genera igual el documento — sin dedup ni roadmap derivado:

````markdown
---
sessions: [062]
created: 2026-05-18
slug: export-conclusions
recommendations_count: 8
roadmap_present: true
conflicts_count: 0
---

# Conclusiones consolidadas — Roadmap export-plan lifecycle

## Resumen ejecutivo

Single-session consolidation de session062 (analyze del lifecycle post-familia export-*). Sin dedup ni roadmap derivado porque hay 1 sola sesión fuente. El output replica la estructura del input añadiendo trazabilidad explícita.

## Sesiones consolidadas

| Code | Flow | Slug | Modalidad | C-items | R-items |
|------|------|------|-----------|---------|---------|
| 062 | analyze | export-plan-lifecycle | technical | 8 | 8 |

## Conclusions (por sesión)

### session062-analyze-export-plan-lifecycle
- **C1** — `export-plan` cubre un gap real cross-sesión.
- ... (los 8 C-items del original)

## Recommendations consolidadas (deduplicadas)

### R1-consolidado — bundle-plugin-v2-10-0
- **Origen**: session062:R1
- **Síntesis**: Bundle aditivo F-A + F-B + F-C + F-E + F-F como plugin v2.10.0 + CLI v6.1.0.
- ... (los 8 R-items del original, cada uno como consolidado de 1 origen)

## Roadmap derivado (opcional)

(El roadmap original de session062 se preserva tal cual)

## Refs

- `session062-analyze-export-plan-lifecycle` — [`CONCLUSIONS`](../.workflow/sessions/session062-analyze-export-plan-lifecycle/CONCLUSIONS.md)
````

Nota: para single-session, considerar primero `graduate --kind conclusion --session 062` (copia tal cual, sin curación). Use `export-conclusions` cuando hay valor en la versión "curada con trazabilidad explícita" incluso single-session, o cuando se anticipan más sesiones del dominio (re-emit posterior agrega trazabilidad).
