---
name: research
description: >
  Capacidad de investigación on-demand que los loops componen cuando necesitan evidencia para avanzar.
  Investiga INLINE dentro de la sesión activa (no crea una sesión aparte): lee el workspace + repos
  asociados + MCPs en modo read-only, produce ANALYSIS-FILE → CONCLUSIONS dentro de esa sesión.
  Concluye INCONCLUSIVE si la pregunta no puede responderse con las fuentes disponibles. Discrimina
  cuándo investigar ("¿puedo responder leyendo repo/datos?") vs cuándo preguntar al humano
  ("¿depende de lo que el usuario quiere?").
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
[pregunta del loop] → [investigar inline en la sesión activa] → [recolectar evidencia] → [sintetizar] → [CONCLUSIONS]
                                                          ↕
                                               [nueva hipótesis o gap] → [más evidencia o INCONCLUSIVE]
```

1. **Investigar inline** — no se crea una sesión aparte; los artefactos se escriben en la sesión activa del loop (`.workflow/sessions/NNN-<run>/`).
2. **Recolectar evidencia** — read-only: `Read`, `Grep`, `Glob`, MCP SELECT, `git log`.
3. **Escribir `ANALYSIS-FILE.md`** (scratchpad opcional) con hallazgos crudos.
4. **Sintetizar** en `CONCLUSIONS.md` con conclusiones evidenciadas.
5. **Reportar al loop**: `concluido` si converge; `inconclusive` si no hay material suficiente — el loop degrada/difiere el gap.

### Ask-vs-research discriminator (examples)

```
"¿qué convención de nombres usa este repo?"     → investigar (Grep + Read)
"¿qué endpoint necesita el spec?"               → investigar (leer spec + código)
"¿prefieres enfoque A o B?"                     → preguntar al humano
"¿cuál es el estado de la tabla X?"             → investigar (MCP read-only)
"¿qué tan urgente es esto para ti?"             → preguntar al humano
"¿el servicio Y ya tiene auth implementado?"    → investigar (leer código)
```

### Artifact schemas

`ANALYSIS-FILE.md` (scratchpad opcional) y `CONCLUSIONS.md` siguen las **plantillas canónicas** en `artifacts/artifacts-research/` — no se duplican aquí para evitar drift. Para research liviana basta `CONCLUSIONS.md`; `ANALYSIS-FILE.md` es opcional para investigaciones más profundas.

### DB rule (invariant #4)

- **Solo SELECT** — nunca DML/DDL.
- **Escribir la query primero** en el `SCRIPTS.sql` de la sesión activa (tipo A, read-only; ver la plantilla `artifacts/artifacts-core/SCRIPTS.sql`) con su header de propósito + MCP + origen.
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

### Inline research artifacts (en la sesión activa)

```
.workflow/sessions/NNN-<run>/      # la sesión del loop (refine/exec/quick)
├── ANALYSIS-FILE.md    # hallazgos crudos (scratchpad opcional)
├── CONCLUSIONS.md      # síntesis + recomendaciones para el loop
└── SCRIPTS.sql         # SQL read-only (tipo A), si se usó MCP
```

## Output

Produce, **inline en la sesión activa del loop** (`.workflow/sessions/NNN-<run>/`):
- `ANALYSIS-FILE.md` — hallazgos crudos sin sintetizar (opcional).
- `CONCLUSIONS.md` — conclusiones con evidencia + recomendaciones para el loop.
- `SCRIPTS.sql` — queries read-only (tipo A), solo si se usó MCP.

No gradua a `docs/` (invariant #1). El loop que compone esta capacidad consume las conclusiones y actua en consecuencia.

## Source

Reciclado de `analyze-investigate`, `analyze-synthesize` y `analyze-conclude` del bundle viejo. Se conserva: el modelo de investigacion divergente → sintesis → conclusiones; las reglas read-only; el cost guard de queries; la discriminacion de gaps. Se descarta: la terminología de `flow=analyze`, `EVIDENCE.md`/`FINDINGS.md` como nombres canónicos (ahora `ANALYSIS-FILE.md`/`CONCLUSIONS.md`), el lifecycle de sesiones legacy (la research ahora es **inline**, sin sesión propia), y la modulacion por modalidad (technical/incident/data) — la skill de research es de propósito general.
