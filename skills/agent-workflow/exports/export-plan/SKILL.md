---
name: export-plan
description: "Consolida N sesiones del workspace + `docs/planes/` ya graduados + `docs/decisiones/` / `docs/conclusiones/` para referencias en un plan ejecutable bajo `docs/planes/NNN-export-plan-YYYY-MM-DD.md`. Lee OBJECTIVE/TASKS/CONCLUSIONS de las sesiones fuente y deriva: Resumen · Fases · Tasks (con dependencias) · Riesgos · Refs. Frontmatter YAML con `state` (draft/active/done/archived) y `state_changes[]`. Read-only / reporte — no commitea ni ejecuta. Sexto comando de la familia `/agent-workflow:export-*` (F-A del roadmap session062). Invocado sólo vía `/agent-workflow:export-plan`. v1.1 (session081): corpus extendido a `docs/` además de sesiones (DEC-002) — ver `docs/shared-contract/export-corpus-sources.md`."
version: 1.1.0
---

# Export Plan — Consolidación de N sesiones en plan ejecutable

Consolida N sesiones (cerradas y/o activas con artefactos completos) en un único plan ejecutable bajo `docs/planes/NNN-export-plan-YYYY-MM-DD.md`. Es **solo lectura/reporte**: el usuario decide cuándo iniciar la ejecución (vía `/agent-workflow:session --from-plan` cuando F-E.3 esté operativo) y cuándo commitear el plan.

> Sexto comando de la familia `/agent-workflow:export-*`. Definido en `docs/conclusiones/008-roadmap-export-plan-lifecycle.md` (F-A). Bundle plugin v2.10.0 con F-B (export-conclusions), F-C (--sessions, ya operativo), F-E (lifecycle), F-F (BACKLOG.md).

## Excepción session-aware

Como otros export-*, requiere conocimiento del lifecycle. **No crea ni modifica sesiones**. Si el workspace no tiene sesiones con OBJECTIVE+TASKS → abortar y sugerir `/agent-workflow:session create`.

**Solo formato actual (v0.9+)**: sesiones legacy abortan; migrar con `/agent-workflow:migrate --upgrade-topology`.

**Consumo de CLI `agent-workflow`** (no leer paths hardcodeados):

- `agent-workflow release-data --include-graduated [--sessions NNN[,NNN]] [--since sessionNNN] [--source alias]` — dump consolidado del corpus.
- `agent-workflow session-artifacts --code <NNN>` — lectura lazy de OBJECTIVE/TASKS/DECISIONS/CONCLUSIONS.
- `agent-workflow next-number docs/planes` — numeración determinística del plan.
- Resolución hub-aware de `docs/planes/` la maneja el CLI internamente.

## When to use

- "Quiero un plan ejecutable a partir de estas sesiones de análisis".
- "Tengo N sesiones cerradas (analyze + dev) y necesito consolidar las acciones derivadas".
- "Diseñé en session050 y session055 — generame el plan para arrancar a ejecutar".
- "Vamos a planificar el próximo sprint a partir del corpus".
- Antes de iniciar una sesión `dev` que va a tomar varios sub-temas.

## Qué hace este skill

1. Lee sesiones (`.workflow/sessions/`) filtradas por `--sessions`/`--since`/`--source`.
2. Para cada sesión: lee OBJECTIVE.md (intent), TASKS.md (acciones), CONCLUSIONS.md (recommendations si analyze), DECISIONS.md (constraints), **BACKLOG.md** (tasks abiertas heredadas — F-F, opcional lazy).
3. Sintetiza:
   - **Resumen**: objetivo común derivado del corpus.
   - **Fases**: heurística por flow (dev → planning/exec/validation/closure; analyze → planning si no hay TASKS).
   - **Tasks**: unión de TASKS abiertas + recommendations cerradas como tareas pendientes + **items de BACKLOG.md** (`Deferred` y `Followups`) si presente. Reordering por dependencias detectadas. Las entradas heredadas de BACKLOG llevan sufijo `[backlog]` para trazabilidad.
   - **Dependencias externas**: extraídas de OBJECTIVE/DECISIONS.
   - **Riesgos**: extraídos de FINDINGS/CONCLUSIONS de sesiones analyze.
   - **Refs**: `file:line` al OBJECTIVE/TASKS/CONCLUSIONS de cada sesión fuente.
4. Calcula `eta_total` sumando ETAs declaradas en TASKS.md de cada sesión.
5. Resuelve el NNN con `agent-workflow next-number docs/planes`.
6. Aplica la plantilla `references/template-plan.md`.
7. Si `--dry-run`: imprime el plan a stdout sin escribir.
8. Si no `--dry-run`: escribe `docs/planes/NNN-<slug>-YYYY-MM-DD.md` con `state: draft`.

## Qué NO hace

- Ejecutar commits, merges, push (ver `agent-workflow:commits-policy`).
- Iniciar la sesión `dev` que ejecutará el plan (eso lo hace `/agent-workflow:session --from-plan <NNN>` cuando F-E.3 esté operativo).
- Cambiar estado del plan automáticamente más allá de `null → draft`. El resto de transiciones (draft→active, active→done) las maneja `references/state-transitions.md`.
- Modificar OBJECTIVE/TASKS/etc. de las sesiones fuente.
- Tocar `docs/conclusiones/`, `docs/decisiones/`, `docs/scripts/`.

## Sandbox read-only

`../session/references/sandbox-readonly-rules.md`. Plan describe NNN resuelto + sesiones incluidas + secciones del plan + estructura del frontmatter YAML + criterio de aceptación.

## Estilo de comunicación

`../session/references/communication-style.md`. Confirmación antes de escribir el plan; si declina, ejecutar como `--dry-run`. Audiencia técnica/PM — términos del dominio (`OBJECTIVE`, `TASKS`, `flow`, `phase`) autorizados.

## Entrada

```
/agent-workflow:export-plan [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
                 [--slug <kebab>] [--dry-run]
```

| Flag | Comportamiento |
|---|---|
| `--sessions NNN[,NNN]` | Filtro discreto por código. Toma precedencia sobre `--since`. |
| `--since sessionNNN` | Sesiones posteriores a NNN (inclusive). Ignorado si `--sessions` presente. |
| `--source <alias>` | Limita a fuente específica (hub mode). |
| `--slug <kebab>` | Override del slug del filename (default: `export-plan`). |
| `--dry-run` | Reporte propositivo sin escribir el plan. |

Sin args: incluye todas las sesiones cerradas + activas con artefactos completos.

Ejemplo: `/agent-workflow:export-plan --sessions 055,061 --slug runtime-evolution` genera `docs/planes/NNN-runtime-evolution-YYYY-MM-DD.md`.

## Flujo

### Paso 1 — Resolver contexto

```
agent-workflow release-data --include-graduated [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
```

Output: `{workspace_mode, source_alias, docs_root, sessions[], sessions_count, legacy_sessions}`.

**Sesiones legacy**: si `legacy_sessions` no vacío → abortar:

> Sesiones en formato legacy detectadas: sessionXXX, sessionYYY. Migrar con `/agent-workflow:migrate --upgrade-topology` antes de export-plan.

**Corpus vacío**: si `sessions_count == 0` → abortar con mensaje:

> Sin sesiones que cumplan el filtro. Ajustá `--sessions` o `--since`.

### Paso 2 — Recolectar artefactos por sesión

Por cada sesión del corpus:

```
agent-workflow session-artifacts --code <NNN>
```

Recolectar:
- `OBJECTIVE.md` body (requirement + acceptance criteria + topics).
- `TASKS.md` (cerradas y abiertas).
- `CONCLUSIONS.md` si presente (recommendations).
- `DECISIONS.md` headers (constraints derivadas).
- `FINDINGS.md` si presente (riesgos derivados).
- `BACKLOG.md` si presente (Deferred + Followups como tasks heredadas; Discarded para trazabilidad).

### Paso 3 — Síntesis

#### 3.1 Resumen

Síntesis 2-3 párrafos derivada de los OBJECTIVEs de las sesiones fuente. Lenguaje del usuario (ES default). Sin jerga inventada.

#### 3.2 Fases

Heurística por flow predominante del corpus:

| Flow predominante | Fases sugeridas |
|---|---|
| `dev` (mayoría) | planning · execution · validation · closure |
| `analyze` (mayoría) | planning · evidence · synthesis · graduación |
| `design` (mayoría) | discovery · design · delivery |
| Mezcla | planning · execution · validation · closure (default genérico) |

Por cada fase: nombre, criterios de entrada, criterios de salida.

#### 3.3 Tasks

Tabla MD con columnas: `ID | Task | ETA | Fase | Depende de | Sesión origen`.

Reglas:
- Renumerar `T1...TN` globales.
- Preservar el ID original como sufijo en "Sesión origen" (`session055:T3`).
- Detectar dependencias por menciones cruzadas en TASKS/DECISIONS.
- Marcar `[done]` las tareas ya cerradas en sus sesiones origen (mantener trazabilidad).

#### 3.4 Dependencias externas

Lista de bullets: librerías/servicios externos mencionados en DECISIONS o OBJECTIVE.

#### 3.5 Riesgos

De FINDINGS/CONCLUSIONS de sesiones analyze:
- `R1 — descripción` + `Mitigación: ...`

#### 3.6 Refs

Cada sesión origen como bullet con paths relativos:

```
- session055-analyze-docs-from-sessions [`OBJECTIVE`](../.workflow/sessions/session055-analyze-docs-from-sessions/OBJECTIVE.md) · [`CONCLUSIONS`](.../CONCLUSIONS.md)
```

### Paso 4 — Resolver NNN + filename

```
agent-workflow next-number docs/planes
```

Output: `next` (NNN). Filename:

```
docs/planes/<NNN>-<slug>-YYYY-MM-DD.md
```

Donde `<slug>` = `--slug` arg o default `export-plan`. `YYYY-MM-DD` = fecha del sistema.

### Paso 5 — Aplicar plantilla

Leer `references/template-plan.md` y rellenar campos derivados. Estructura final del MD:

1. Frontmatter YAML (state, sessions, created, slug, state_changes, eta_total, dependencies_external, risks).
2. `# Plan — <título derivado>`.
3. `## Resumen`.
4. `## Fases`.
5. `## Tasks` (tabla).
6. `## Dependencias externas`.
7. `## Riesgos`.
8. `## Refs`.

### Paso 6 — Escribir o reportar

Si `--dry-run`: print a stdout. Si no: `Write` el archivo.

**NUNCA commitear**. Reportar al usuario:

> Plan escrito en `docs/planes/NNN-<slug>-YYYY-MM-DD.md` con state=draft. Sin commit. Cuando estés listo, podés:
> - Iniciar ejecución: `/agent-workflow:session --from-plan NNN` (cuando F-E.3 esté operativo).
> - Refinar el plan editándolo directamente.
> - Archivar si supersede uno previo: ver `references/state-transitions.md`.

## Estados del plan

Definidos en `references/state-transitions.md`. Resumen:

- `null → draft`: este skill al crear.
- `draft → active`: `/agent-workflow:session --from-plan` (futuro F-E.3).
- `active → done`: `AskUserQuestion plan-state` cuando todas las tasks cerradas.
- `* → archived`: manual o por re-emit.

## Plan mode

Describir en el plan file: NNN del plan, sesiones del corpus, sección por sección lo que se generaría, frontmatter YAML preview. NO escribir el archivo.

## Recursos

- `references/template-plan.md` — plantilla canónica del plan.
- `references/state-transitions.md` — árbol de decisión G3 + spec `AskUserQuestion plan-state`.
- `../session/references/sandbox-readonly-rules.md` — reglas de plan mode.
- `../session/references/communication-style.md` — estilo de prosa.
- `../redaccion-simple/SKILL.md` — guía transversal de redacción.
- `docs/conclusiones/008-roadmap-export-plan-lifecycle.md` — diseño F-A.
- Sibling: `agent-workflow/skills/export-scripts/SKILL.md`, `export-report/SKILL.md`, `export-tech-manuals/SKILL.md`, `export-arq/SKILL.md`.
