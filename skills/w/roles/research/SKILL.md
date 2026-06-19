---
name: research
description: >
  Capacidad de investigación on-demand que los loops componen cuando necesitan evidencia para avanzar.
  Crea una sesión de investigación, lee el workspace + repos asociados + MCPs en modo read-only,
  produce ANALYSIS-FILE → CONCLUSIONS. Cierra INCONCLUSIVE si la pregunta no puede responderse
  con las fuentes disponibles. Discrimina cuándo investigar ("¿puedo responder leyendo repo/datos?")
  vs cuándo preguntar al humano ("¿depende de lo que el usuario quiere?").
---

# research — On-demand investigation capability

## Role

`research` — implementación built-in por defecto. Rebindeable a otra skill (de tercero o `off`) en `.workflow/skills.toml`.

## Purpose

Resolver preguntas factuales sobre el sistema antes de actuar: leer el repo, rastrear datos vía MCP read-only, producir hallazgos sintetizados. **No crea artefactos de producción** — produce evidencia y conclusiones para que el loop que la compuso pueda avanzar con información de calidad.

El discriminador clave:

| La pregunta... | Acción |
|---|---|
| puede responderse leyendo repo / datos (hechos objetivos del sistema) | **investigar** |
| depende de preferencias, prioridades o decisiones del usuario | **preguntar al humano** vía `AskUserQuestion` |
| está parcialmente en el repo y parcialmente en intención del usuario | investigar primero, luego preguntar solo por la parte incierta |

## Composed by

Todos los loops la cargan on-demand:

| Loop | Cuándo la compone |
|---|---|
| `spec-refine-loop` | para entender el sistema existente antes de refinar un spec |
| `plan-new-loop` | para descubrir dependencias, integrations, convenciones del repo |
| `plan-exec-loop` | para investigar comportamiento real de un componente antes de modificarlo |
| `quick-loop` | para responder preguntas de orientación sobre el código o datos |

## Knowledge

### Investigation lifecycle

```
[pregunta del loop] → [crear sesión research] → [recolectar evidencia] → [sintetizar] → [CONCLUSIONS]
                                                          ↕
                                               [nueva hipótesis o gap] → [más evidencia o INCONCLUSIVE]
```

1. **Crear sesión research** en `.workflow/sessions/<slug>/` con `SESSION.md` (pregunta original + scope).
2. **Recolectar evidencia** — read-only: `Read`, `Grep`, `Glob`, MCP SELECT, `git log`.
3. **Escribir `ANALYSIS-FILE.md`** con hallazgos crudos.
4. **Sintetizar** en `CONCLUSIONS.md` con conclusiones evidenciadas.
5. **Cerrar** la sesión: estado `closed` si converge; `inconclusive` si no hay suficiente material.

### Ask-vs-research discriminator (examples)

```
"¿qué convención de nombres usa este repo?"     → investigar (Grep + Read)
"¿qué endpoint necesita el spec?"               → investigar (leer spec + código)
"¿prefieres enfoque A o B?"                     → preguntar al humano
"¿cuál es el estado de la tabla X?"             → investigar (MCP read-only)
"¿qué tan urgente es esto para ti?"             → preguntar al humano
"¿el servicio Y ya tiene auth implementado?"    → investigar (leer código)
```

### ANALYSIS-FILE.md schema

```markdown
# Analysis — <slug>

## Question

[La pregunta exacta que el loop planteó.]

## Sources consulted

- Codigo: <repo/path:lineas>
- BD (<mcp-name>): queries en queries/
- Git: <SHAs relevantes>
- Refs externas: <links si aplica>

## Finding 1: <titulo>

- **Que se observo**: ...
- **Donde**: <path o link>
- **Cuando**: <fecha si aplica>

## Finding N: ...

## Tentative hypotheses

- [hipotesis sin compromiso, para revisar en synthesis]

## Gaps

- [lo que no pudo leerse o no esta disponible]
```

### CONCLUSIONS.md schema

```markdown
# Conclusions — <slug>

## Summary

[1-2 oraciones: que se investigo y que se concluyó.]

## Conclusions

- **C1**: <conclusion + link a ANALYSIS-FILE#section>
- **C2**: ...

## Recommendations

- **R1**: <accion concreta para el loop que hizo la pregunta>

## Open (gaps)

- <pregunta sin responder si aplica>
```

### DB rule (invariant #4)

- **Solo SELECT** — nunca DML/DDL.
- **Escribir la query primero** en `.workflow/sessions/<slug>/queries/NNN-<slug>.sql` con header:
  ```sql
  -- Query: <proposito>
  -- MCP: <nombre>
  -- Fecha: YYYY-MM-DD
  -- Sesion: <slug>
  -- Costo estimado: <filas|N/A>
  ```
- **Si hay >1 MCP candidato sin default declarado**: preguntar al humano cuál usar antes de ejecutar.
- **Cost guard antes de ejecutar**:
  - `COUNT(*) ≤ 1.000` o lookup por PK → ejecutar directo.
  - `1.000–10.000` filas o seq scan tabla pequeña → avisar estimado al usuario.
  - `> 10.000` filas o seq scan tabla grande → confirmación explícita del usuario.
  - UPDATE/INSERT/DELETE → rechazar.

### Code reading rules

- Usar `Grep` y `Read` extensivamente. **Nunca** `Edit/Write` durante investigación.
- Citar con path + líneas: `src/services/Foo.java:142`.
- Si el código está disperso: `Glob` + `Grep` para acotar.

### Git read-only (git-safe, invariant #5)

Solo: `git log`, `git show`, `git diff`, `git blame`, `git branch --show-current`.
Nunca durante investigación: `commit`, `push`, `merge`, `rebase`, `reset`, `checkout`.

### Inconclusive closure

Si tras investigar los gaps persisten y no pueden cerrarse con las fuentes disponibles:
- Documentar los gaps en `CONCLUSIONS.md#Open`.
- Marcar sesión como `inconclusive`.
- Reportar al loop: qué se pudo y qué no — el loop decide si pregunta al humano.

### Research session artifacts

```
.workflow/sessions/<slug>/
├── SESSION.md          # pregunta original + scope + estado (open|closed|inconclusive)
├── ANALYSIS-FILE.md    # hallazgos crudos (equivale a EVIDENCE.md del modelo viejo)
├── CONCLUSIONS.md      # sintesis + recomendaciones para el loop
└── queries/            # SQL read-only (si se usó MCP)
    └── 001-<slug>.sql
```

## Output

Produce en `.workflow/sessions/<slug>/`:
- `ANALYSIS-FILE.md` — hallazgos crudos sin sintetizar.
- `CONCLUSIONS.md` — conclusiones con evidencia + recomendaciones para el loop.
- `queries/*.sql` — solo si se usó MCP.

No gradua a `docs/` (invariant #1). El loop que compone esta capacidad consume las conclusiones y actua en consecuencia.

## Source

Reciclado de `analyze-investigate`, `analyze-synthesize` y `analyze-conclude` del bundle viejo. Se conserva: el modelo de investigacion divergente → sintesis → conclusiones; las reglas read-only; el cost guard de queries; la discriminacion de gaps. Se descarta: la terminología de `flow=analyze`, `EVIDENCE.md`/`FINDINGS.md` como nombres canónicos (ahora `ANALYSIS-FILE.md`/`CONCLUSIONS.md`), el lifecycle de sesiones legacy, y la modulacion por modalidad (technical/incident/data) — la skill de research es de propósito general.
