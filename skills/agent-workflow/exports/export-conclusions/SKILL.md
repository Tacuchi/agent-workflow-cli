---
name: export-conclusions
description: "Consolida N sesiones del workspace (con `CONCLUSIONS.md` presente) + `docs/conclusiones/` ya graduadas en un documento curado bajo `docs/conclusiones/NNN-export-conclusions-YYYY-MM-DD.md`. Sintetiza Resumen ejecutivo · C-items por sesión · R-items deduplicados cross-session · Roadmap derivado opcional. Aplica algoritmo de dedup por slug + cross-slug similarity opcional. Complementa `graduate --kind conclusion` (single-session) — no lo reemplaza. Read-only / reporte — no commitea. Séptimo comando de la familia `/agent-workflow:export-*` (F-B del roadmap session062). Invocado sólo vía `/agent-workflow:export-conclusions`. v1.1 (session081): corpus extendido a `docs/` además de sesiones (DEC-002) — ver `docs/shared-contract/export-corpus-sources.md`."
version: 1.1.0
---

# Export Conclusions — Consolidación de N CONCLUSIONS.md en documento curado

Consolida N sesiones (típicamente analyze) que tengan `CONCLUSIONS.md` presente en un único documento curado bajo `docs/conclusiones/NNN-export-conclusions-YYYY-MM-DD.md`. Es **solo lectura/reporte**: el usuario decide cuándo commitear el documento.

> Séptimo comando de la familia `/agent-workflow:export-*`. Definido en `docs/conclusiones/008-roadmap-export-plan-lifecycle.md` (F-B). Bundle plugin v2.10.0 con F-A (export-plan), F-C (--sessions, operativo), F-E (lifecycle), F-F (BACKLOG.md).

## Excepción session-aware

Como otros export-*, requiere conocimiento del lifecycle. **No crea ni modifica sesiones**. Si el corpus filtrado no tiene ninguna sesión con `CONCLUSIONS.md` → abortar limpio.

**Solo formato actual (v0.9+)**: sesiones legacy abortan; migrar con `/agent-workflow:migrate --upgrade-topology`.

**Consumo de CLI `agent-workflow`** (no leer paths hardcodeados):

- `agent-workflow release-data --include-graduated [--sessions NNN[,NNN]] [--since sessionNNN] [--source alias]` — dump consolidado.
- `agent-workflow session-artifacts --code <NNN>` — lectura lazy. Verificar presencia de `CONCLUSIONS.md`.
- `agent-workflow next-number docs/conclusiones` — numeración determinística.
- Resolución hub-aware de `docs/conclusiones/` la maneja el CLI internamente.

## When to use

- "Tengo 3-5 sesiones analyze sobre el mismo dominio — necesito fusionar sus CONCLUSIONS.md en un documento curado".
- "Roadmap de evolución del runtime: consolidar conclusions de las propuestas + audits".
- "Comité técnico necesita un brief con los R-items deduplicados de las últimas N sesiones".
- Antes de planificar un sprint multi-sesión.

## Qué hace este skill

1. Lee sesiones (`.workflow/sessions/`) filtradas por `--sessions`/`--since`/`--source`.
2. **Filtra el corpus**: descarta sesiones sin `CONCLUSIONS.md`. Si el corpus filtrado queda vacío → abortar.
3. Para cada sesión incluida: lee CONCLUSIONS.md, extrae C-NNN headers + R-NNN headers + Resumen + Trazabilidad.
4. Aplica algoritmo de dedup (ver `references/dedup-rules.md`):
   - Extrae slug del primer fragmento textual de cada R-NNN.
   - Agrupa por slug exacto.
   - Cross-slug similarity opcional (threshold cosine ≥0.7) → merge sugerido.
   - Conflict resolution: si 2 R-items mismo slug pero acciones contradictorias → marca como `## R-Conflict`.
5. Sintetiza:
   - **Resumen ejecutivo** del dominio común (LLM, 2-3 párrafos).
   - **Tabla de sesiones consolidadas** (counts de C-items y R-items por sesión).
   - **C-items por sesión** (preservar trazabilidad — no dedup en C-items).
   - **R-items consolidados** (dedup aplicado, con `origins[]`).
   - **Roadmap derivado** opcional (si ≥3 R-items consolidados → secuenciar por dependencias).
   - **Refs**: links a CONCLUSIONS.md de cada sesión origen.
6. Resuelve NNN con `agent-workflow next-number docs/conclusiones`.
7. Aplica plantilla `references/template-conclusions.md`.
8. Si `--dry-run`: imprime a stdout. Si no: escribe `docs/conclusiones/NNN-<slug>-YYYY-MM-DD.md`.

## Qué NO hace

- Ejecutar commits, merges, push.
- Modificar CONCLUSIONS.md de las sesiones fuente.
- Reemplazar `graduate --kind conclusion` (sigue siendo el path para "graduar 1 CONCLUSIONS.md tal cual").
- Cambiar el counter de `docs/conclusiones/` (coexiste con NNN-<slug>.md de graduate).
- Inferir conclusions ausentes (si una sesión no tiene CONCLUSIONS.md, queda fuera del corpus).

## Diferenciación con `graduate --kind conclusion`

| Aspecto | `agent-workflow graduate --kind conclusion --session NNN` | `/agent-workflow:export-conclusions --sessions NNN[,NNN]` |
|---|---|---|
| Input | 1 sesión | N sesiones (corpus filtrado) |
| Output | `docs/conclusiones/NNN-<slug>.md` (copia tal cual) | `docs/conclusiones/NNN-export-conclusions-YYYY-MM-DD.md` (documento curado nuevo) |
| Dedup R-items | No aplica | Sí, por slug + cross-slug |
| Roadmap | El de la sesión origen | Derivado cross-session |
| Trazabilidad | Trivial (1 origen) | Matriz multi-origen |
| Cuándo usar | Promover 1 análisis al canon | Consolidar dominio multi-análisis |

Ambos **coexisten** bajo `docs/conclusiones/` con NNNs distintos del mismo counter (`next-number docs/conclusiones` los distribuye secuencialmente sin colisión).

## Sandbox read-only

`../session/references/sandbox-readonly-rules.md`. Plan describe NNN, sesiones del corpus (filtradas por CONCLUSIONS presence), secciones del MD, R-items consolidados esperados, conflicts detectados.

## Estilo de comunicación

`../session/references/communication-style.md`. Confirmación antes de escribir. Audiencia: PMs / leads / arquitectos. Términos del dominio (`CONCLUSIONS`, `R-items`, `roadmap`, `dedup`) autorizados.

## Entrada

```
/agent-workflow:export-conclusions [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
                        [--slug <kebab>] [--dry-run]
```

| Flag | Comportamiento |
|---|---|
| `--sessions NNN[,NNN]` | Filtro discreto. Precede a `--since`. |
| `--since sessionNNN` | Sesiones posteriores a NNN. Ignorado si `--sessions` presente. |
| `--source <alias>` | Limita a fuente específica (hub mode). |
| `--slug <kebab>` | Override del slug del filename (default: `export-conclusions`). |
| `--dry-run` | Reporte propositivo sin escribir. |

Sin args: incluye todas las sesiones del workspace con `CONCLUSIONS.md` presente.

Ejemplo: `/agent-workflow:export-conclusions --sessions 049,051,062 --slug runtime-evolution-roadmap`.

## Flujo

### Paso 1 — Resolver contexto

```
agent-workflow release-data --include-graduated [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
```

### Paso 2 — Filtrar corpus por presencia de CONCLUSIONS.md

Para cada sesión del corpus inicial:

```
agent-workflow session-artifacts --code <NNN>
```

Verificar `artifacts.conclusions !== null`. Descartar las que no.

**Abort si corpus filtrado vacío**:

> Sin sesiones con `CONCLUSIONS.md` en el filtro. Ajustá `--sessions`/`--since`, o generá `CONCLUSIONS.md` en alguna sesión analyze (vía `agent-workflow:analyze-conclude`).

### Paso 3 — Síntesis + dedup

Aplicar `references/dedup-rules.md` para los R-items. Mantener C-items 1-a-1 con trazabilidad a sesión origen (no se deduplican porque son específicos del análisis).

### Paso 4 — Resolver NNN + filename

```
agent-workflow next-number docs/conclusiones
```

Filename: `docs/conclusiones/<NNN>-<slug>-YYYY-MM-DD.md`. Default slug: `export-conclusions`.

### Paso 5 — Aplicar plantilla

`references/template-conclusions.md` con frontmatter mínimo:

```yaml
---
sessions: [055, 057, 061]
created: 2026-05-18
slug: export-conclusions
recommendations_count: 7
roadmap_present: true
---
```

### Paso 6 — Escribir o reportar

Si `--dry-run`: print stdout. Si no: `Write`. **NUNCA commitear**. Reportar:

> Documento escrito en `docs/conclusiones/NNN-<slug>-YYYY-MM-DD.md`. Sin commit. Para promover una conclusión single-session, seguir usando `agent-workflow graduate --kind conclusion`.

## Plan mode

Describir NNN del export, sesiones incluidas (post-filtro CONCLUSIONS presence), secciones del MD, R-items que se consolidarían, conflicts detectados. NO escribir.

## Recursos

- `references/template-conclusions.md` — plantilla canónica del output.
- `references/dedup-rules.md` — algoritmo de dedup R-NNN + matriz trazabilidad.
- `../session/references/sandbox-readonly-rules.md` — reglas de plan mode.
- `../session/references/communication-style.md` — estilo de prosa.
- `../redaccion-simple/SKILL.md` — guía transversal de redacción.
- `../analyze-conclude/SKILL.md` — skill que genera el `CONCLUSIONS.md` input.
- `docs/conclusiones/008-roadmap-export-plan-lifecycle.md` — diseño F-B.
- Sibling: `agent-workflow/skills/export-plan/SKILL.md` (mismo patrón estructural).
