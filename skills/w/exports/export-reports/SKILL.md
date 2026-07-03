---
name: export-reports
description: "Informe ejecutivo/funcional (audiencia gerencia/comité) que consolida N sesiones del workspace bajo `docs/reports/NNN-<slug>-YYYY-MM-DD.md`. Lee el corpus: el spec (`docs/specs`), `CONCLUSIONS` (research), `DECISION`, el estado del plan-doc + el resto de `docs/` para contexto. Sintetiza: qué se hizo, decisiones clave, resultados/conclusiones, pendientes/roadmap — con dedup de recomendaciones cross-session. Audiencia ajustable vía `--audience` (gerencia ≈ corto; tecnica ≈ detallado). Funde el espíritu de los viejos export-report (ejecutivo) y export-conclusions (dedup de R-items) en una sola salida a `docs/reports`. Read-only/reporte: no commitea ni muta sesiones. La prosa sigue las convenciones de redacción ambientes (el host auto-aplica una skill de writing instalada si está presente). Úsalo para 'informe ejecutivo', 'qué se hizo este trimestre para gerencia', 'brief con recomendaciones consolidadas'. Invocado por el usuario vía `/w:export-reports`."
---

# export-reports — Informe ejecutivo/funcional desde el corpus de sesiones + `docs/`

Genera un único `.md` que consolida N sesiones del workspace en un informe **ejecutivo/funcional**: qué se hizo, decisiones clave, resultados/conclusiones y pendientes/roadmap. **Read-only / reporte** — no commitea, no muta sesiones ni el corpus.

> Familia `export-*` (la única vía artefacto→`docs/`). **Funde** el espíritu de dos viejos exports en una sola salida a `docs/reports`: `export-report` (informe ejecutivo con tabla de componentes + diagrama de flujo) y `export-conclusions` (dedup de R-items cross-session). Modernizado: `docs/reports` en inglés, sin modos project/hub, y la prosa sigue las convenciones de redacción **ambientes** (el host auto-aplica una skill de writing instalada si está presente), no un rol propio. Diseño: `docs/referencias/workflow-exports/export-reports.md`.

## Category

`docs/reports` — **única** carpeta `docs/` que este export escribe.

## Writing (convención ambiente, no rol)

La redacción del informe sigue las convenciones de redacción **ambientes**: el host auto-aplica una skill de writing instalada (si está presente) por su `description` — traducción técnico→ejecutiva, cota de longitud por audiencia, frases cortas, listas sobre prosa, sin relleno. Este export **no** compone un rol `writing` ni lo bindea; es **indiferente** a qué skill de redacción exista. Una familia útil vive en el plugin `dev-conventions` del marketplace, pero el export **no depende** de él.

## When to use

- "Informe ejecutivo", "documento funcional", "qué se hizo este trimestre para gerencia".
- Brief con las **recomendaciones consolidadas** (deduplicadas) de las últimas N sesiones.
- Re-generar tras un nuevo período (mes / trimestre); antes de un comité de seguimiento.

## What it does

1. Lee el corpus de sesiones filtrado: el spec (`docs/specs`), `CONCLUSIONS` (research), `DECISION`, el estado del plan-doc.
2. Lee el resto de `docs/` (specs, plans, reports previos) para contexto.
3. Resuelve la audiencia/longitud (`--audience`).
4. Sintetiza: Resumen ejecutivo · Qué se hizo (agrupado por capacidad de negocio, no por sesión) · Decisiones clave · Resultados/conclusiones · Pendientes/Roadmap.
5. **Deduplica** las recomendaciones (R-items) cross-session por slug, anotando los orígenes.
6. Escribe `docs/reports/NNN-<slug>-YYYY-MM-DD.md`.

## What it does NOT do

- Ejecutar commits, merges, push, SQL ni envío de correos / creación de PRs.
- Mutar sesiones, el corpus ni el plan-doc (solo lectura).
- Escribir cualquier carpeta `docs/` que no sea `docs/reports/` (invariante: una categoría).
- Inventar logros, métricas o recomendaciones: las secciones condicionales (p.ej. "Oportunidades de mejora"/Roadmap) **solo** aparecen si el corpus tiene items abiertos detectables.
- Generar diagramas técnicos avanzados (C4/erDiagram extenso) — esos viven en `export-diagrams`; aquí, como mucho, un `flowchart LR` simple de síntesis ejecutiva.
- Sobrescribir reports previos (siempre next-number).

## Read-only sandbox

En plan mode **describe**, no escribe: la audiencia/longitud resuelta, las sesiones del corpus que entrarían tras los filtros, las secciones que aparecerían, los R-items que se consolidarían (y conflictos detectados), y la longitud estimada. **No** ejecuta `Write` ni `aw next-number` con efecto.

## Inputs

**CLI `agent-workflow` (alias `aw`)** — no leer paths hardcodeados:

- `aw sessions` / `aw release-data [--since sessionNNN] [--source <alias>]` — enumera + filtra el corpus.
- `aw session-artifacts --code <NNN> --dump objetivo,conclusiones,decisiones` — devuelve `{path, content, size}` de `SESSION` (spec referido), `CONCLUSIONS` y `DECISION`; el estado del plan-doc se lee por su path.
- `aw next-number docs/reports` — numeración determinística (la resolución de la carpeta destino la maneja el CLI).

**Filesystem**:

- `docs/specs`, `docs/plans`, `docs/reports/*` — contexto + no colisionar.

**Args** (sin *structured-choice* de ciclo de vida — capacidad del arnés; ver [`../../harness/SKILL.md`](../../harness/SKILL.md)):

```
/w:export-reports [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
                  [--audience gerencia|tecnica] [--slug <kebab>] [--dry-run]
```

| Flag | Comportamiento |
|---|---|
| `--sessions NNN[,NNN]` | Filtro discreto por código (precede a `--since`) |
| `--since sessionNNN` | Solo sesiones posteriores a NNN (exclusivo: la propia NNN no entra; usá `--sessions` para incluirla) |
| `--source <alias>` | Limita a una fuente (workspace multi-fuente) |
| `--audience gerencia\|tecnica` | Modula longitud/léxico: `gerencia` ≈ corto/ejecutivo; `tecnica` ≈ detallado |
| `--slug <kebab>` | Override del slug del filename (default: `export-reports`) |
| `--dry-run` | Reporte propositivo sin escribir |

Sin args: todo el corpus, audiencia ejecutiva por default. *(Si algún flag exacto difiere en el CLI runtime, ajustar al contrato real de `aw`.)*

## Flow

### Paso 1 — Resolver contexto y filtrar corpus

`aw sessions` / `release-data` aplicando `--sessions`/`--since`/`--source`. Si el conjunto resultante está vacío → **abortar** con mensaje explícito ("No hay sesiones en el rango declarado"). La resolución de la carpeta destino la maneja el CLI.

### Paso 2 — Recolectar inputs por sesión

Por sesión filtrada (`aw session-artifacts --code <NNN> --dump objetivo,conclusiones,decisiones`): el spec referido (qué se planteó), `CONCLUSIONS` (cierre técnico / R-items), `DECISION` (qué se decidió), estado del plan-doc (qué se entregó / qué queda). Recoger también componentes impactados (fuentes tocadas) para la tabla de síntesis.

### Paso 3 — Dedup de recomendaciones (cross-session)

Extraer los R-items de `CONCLUSIONS`/`DECISION` (pendientes, diferidos, "próximos pasos"). Agrupar por slug; merge de duplicados anotando `origins[]`; si dos R-items del mismo slug se contradicen, marcarlos como conflicto para resolución explícita. **No** deduplicar los C-items (son específicos de cada análisis: se preservan con trazabilidad).

### Paso 4 — Sintetizar (prosa: convenciones ambientes)

Render aplicando las convenciones de redacción ambientes (host): Resumen ejecutivo · Qué se hizo (agrupado por capacidad de negocio, **no** por sesión) · Componentes impactados (tabla) · Decisiones clave · Resultados/conclusiones · Pendientes/Roadmap (solo si hay R-items). Traducción técnico→ejecutiva y cota de longitud por `--audience`. Opcional: un `flowchart LR` simple de síntesis (con link `mermaid.ink`); el diagrama técnico detallado es de `export-diagrams`.

### Paso 5 — Escribir o reportar

`aw next-number docs/reports` → `docs/reports/NNN-<slug>-YYYY-MM-DD.md`. Si `--dry-run`: imprimir; no escribir. **NUNCA commitear**. Resumen al usuario: ruta, audiencia/longitud, sesiones cubiertas (count + rango), R-items consolidados, y nota si se omitió una sección condicional.

## Output location

`docs/reports/NNN-<slug>-YYYY-MM-DD.md` (default slug `export-reports`).

## Re-run

Idempotente funcional: cada invocación toma el siguiente `NNN`; no sobrescribe reports previos. Para regenerar el último: borrar el archivo y re-invocar.

## Resources

- Design: `docs/referencias/workflow-exports/export-reports.md` · familia: [`../README.md`](../README.md).
- Redacción: convención **ambiente** (no rol) — el host auto-aplica una skill de writing instalada si está presente.
- Insumos: spec (`docs/specs`), `CONCLUSIONS`/`DECISION` (ver `docs/referencias/workflow-artifacts/`), plan-doc (`docs/plans`).
- Siblings: [`../export-scripts/SKILL.md`](../export-scripts/SKILL.md) · [`../export-manuals/SKILL.md`](../export-manuals/SKILL.md) · [`../export-diagrams/SKILL.md`](../export-diagrams/SKILL.md).
