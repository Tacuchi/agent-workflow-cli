---
name: spec-refine-loop
description: >-
  Refina un spec borrador (docs/specs/NNN-spec-<slug>.md) editándolo IN PLACE
  hasta dejarlo sin ambigüedad. Heir del chasis común de los loops
  (loops/CHASSIS.md — motor gap-driven convergente: session única con research
  inline, structured-choice ≤3 preguntas + control flow, artefactos como log
  vivo, compact/resume, convergence gate); aquí viven solo sus deltas SPEC:
  gap taxonomy de spec, analyze gate, sección ## UI spec vía la capacidad
  ui-design cuando el requerimiento involucra UI, y agrega Refinement
  decisions + Q&A traceability al spec — la marca de refinado que plan-new
  detecta. Lo arranca /w:spec-refine (o la escalación en vivo desde
  quick-loop); reanudable vía CHECKPOINT y re-corrible a demanda. Invocar cuando haya que refinar/desambiguar una especificación
  antes de planificar.
---

# spec-refine-loop

> **Heir** del chasis común — aquí **solo** los deltas de SPEC. El motor no se repite.

## Inherits

Leé **[`../CHASSIS.md`](../CHASSIS.md)** (instalación normal) **o** `CHASSIS.md` junto a este archivo (instalación aplanada) — el motor completo del loop (objetivo persistente + verification-first, gap-driven, session única + research inline, structured-choice + control `flow`, compact/resume, artefactos como log vivo, numeración, convergence gate), **siempre antes** de estos deltas.

## Flow
SPEC

## Layer
2 — la IA lo corre entero (gap-driven). El usuario no conduce el ciclo; solo responde preguntas de contenido y dirige el ciclo de vida por el control `flow`.

## Started by
`/w:spec-refine` — **reanudable**. Detecta el estado previo (vía CHECKPOINT) y arranca según corresponda (ver *Compact / resume — claves SPEC*).

También lo arranca la **escalación en vivo desde `quick-loop`** (gate de entrada o mid-loop — ver [`../quick-loop/SKILL.md`](../quick-loop/SKILL.md) § *Delta QUICK*): quick materializa el borrador (procedimiento de `spec-new`) y **carga este loop** sobre ese spec — misma semántica que si el usuario hubiera corrido `/w:spec-refine`.

## Reads
- `docs/specs/NNN-spec*.md` (glob — localiza el spec por número, también captura el legacy `NNN-spec.md`), **o** la ruta exacta pasada en el argumento del comando. **Siempre el spec mismo**: este loop lo edita in place, no hay un archivo "refined" aparte.

## Writes
Actualiza `docs/specs/NNN-spec-<slug>.md` **in place** (cuando el usuario elige `Guardar especificación refinada`): completa secciones y **agrega** `## Refinement decisions` + `## Q&A traceability`, cerrando `Open questions` a medida que se resuelven. Como sobrescribe un doc existente, **con confirmación** del usuario.

> **Invariante de boundary:** este loop escribe **solo** en `docs/specs`. Nunca gradúa/exporta otros artefactos a `docs/` — eso es trabajo de `export-*`, aparte (chasis § *docs/ boundary*).

## Internal sessions — instancia SPEC

Doctrina completa en el chasis (§ *Internal sessions* + *Numeración*). La instancia de este loop:

| Session | When | Artifacts | Role |
|---|---|---|---|
| **refine session** `NNN-<slug>-spec-refine/` | al arrancar el loop (o se reanuda) | `SESSION.md` · `CHECKPOINT.md` (· `BACKLOG.md` solo si difiere) | Dueña del run. Type = `refine`; descriptor `<slug>-spec-refine` (el `<slug>` sale del spec de entrada). |

> **Origin por escalación:** si el run nace de la escalación en vivo de `quick-loop`, el `## Origin` de la session registra "escalado desde `/w:quick`" + la session quick de origen si existe (sus `DECISION`/`SCRIPTS.sql` son contexto referenciable — no se migran).

> **Compat (legacy):** workspaces viejos pueden tener `NNN-spec.md` / `NNN-spec-refined.md` y sessions `*-research-*` aparte — son históricos y se dejan tal cual. El glob `NNN-spec*.md` igual encuentra el spec base, y re-correr spec-refine lo edita in place de ahí en adelante.

## Composes

El gap **UI sin especificar** (cuando el requerimiento involucra UI; ver *Gap taxonomy*) se resuelve **componiendo** la capacidad **`ui-design`** (default built-in `ui-spec`; rebindeable vía `.workflow/skills.toml`): autora el UI spec nativamente (estructura, vocabulario, formato Markdown). Es un tercer modo de resolución de gap (junto a *research* y *humano*): el loop aporta la iteración/Q&A que el viejo servicio no tenía (design-system, tema, variantes, desambiguación) **vía la misma structured-choice**, y lo integra como sección `## UI spec` del spec.

> **Dos niveles de la misma capacidad:** aquí (SPEC) produce la sección `## UI spec` del spec — el *qué* de la UI, grano grueso. En PLAN, `plan-new-loop`/`plan-refine-loop` componen la **misma** capacidad para producir **design SPECs por pantalla** (`NNN-SPEC-<SLUG>.md`, artefactos de su sesión — ver [`SPEC.md`](../../artifacts/artifacts-design/SPEC.md)), derivados de esta sección si existe.

Otras capacidades transversales que el motor usa siempre: `research` (research **inline** — chasis § *Research*), `sql` (regla BD en research — chasis). Todas se resuelven por config; `off` → el loop sigue sin la capacidad y, si era necesaria, lo dice o pregunta. La **prosa del spec** sigue las convenciones de redacción **ambientes** (el host auto-aplica una skill de writing instalada si está presente), no un rol compuesto.

> **Convenciones ambientes (no roles):** estándares de código/testing/redacción y `creating-tools` son skills standalone que el host auto-descubre por su `description` — el workflow no las bindea ni depende de ellas. Doctrina completa: [../../roles/README.md](../../roles/README.md).

## Deliverable schema (el spec, editado in place)

El spec se completa **in place**: mismas secciones del borrador **completadas** + dos nuevas que se **agregan** (`Refinement decisions`, `Q&A traceability`). NO se crea un archivo aparte.

```markdown
# Spec NNN — <slug>

> Refinado in place por spec-refine-loop

## Origin                 (opt. — se conserva del borrador)
## Requirement            (afinado, sin ambigüedad)
## Context                (completo)
## Scope                  (In / Out claros)
## Acceptance criteria    (testables, - [ ]; estilo EARS / Given-When-Then recomendado)
## Assumptions            (declarados)

## UI spec                (opt. — si involucra UI; vía capacidad ui-design / skill ui-spec)
Descripción estructurada en Markdown (pantallas → regiones/componentes). Ver [`ui-spec`](../../roles/ui-spec/SKILL.md).

## Refinement decisions   ← NEW (se AGREGA)
Qué se definió al refinar y por qué. Incluye lo resuelto vía research inline
(con referencia a las CONCLUSIONS de la session).

## Q&A traceability       ← NEW (se AGREGA)
Cada duda preguntada al humano + la respuesta elegida.

## Open questions         (idealmente "None"; lo que quede se difiere)
```

> **Marca de refinado (contrato con PLAN):** la presencia de `## Refinement decisions` + `## Q&A traceability` distingue un spec refinado de un borrador — plan-new lo detecta así, NO por el nombre del archivo; sin esas 2 secciones plan-new hace soft-suggest de spec-refine.

> **Acceptance criteria = criterios testables estáticos** (el "qué"): plan-exec los valida pero el avance se trackea en el PLAN (sus Tasks), no marcando estos `- [ ]` en el spec; el spec no muta por ejecución, solo por re-refine.

## Gap taxonomy (= weak sections of the schema)

`detect_gaps(work)` busca estas señales; cada una tiene un resolutor:

| Gap | Signal | Resolved by |
|---|---|---|
| Requirement vago | el qué/por qué ambiguo | **humano** |
| Context incompleto | sistemas/componentes sin identificar | **research** |
| Scope borroso | falta `Out`, o In/Out se solapan | **humano** |
| Criterios no testables | acceptance no verificable | **humano** (derivar + confirmar) |
| Open questions abiertas | dudas explícitas | según naturaleza |
| Supuestos ocultos | el spec asume cosas no dichas | **research** valida / **humano** confirma |
| Contradicción interna | secciones que se contradicen | **humano** |
| UI sin especificar *(si aplica)* | el requerimiento involucra UI pero falta `## UI spec` | **capacidad `ui-design`** |

## Sequence

```
spec-refine-loop(spec):
  input = glob(NNN-spec*.md) | argumento (ruta)         # siempre el spec mismo (in place)
  refine_session = create_or_resume("<slug>-spec-refine") # <slug> del spec de entrada; CLI antepone NNN global; resume localiza por descriptor/origin
  seed SESSION.Success criteria = acceptance criteria + checklist del analyze gate   # verification-first: ANTES de iterar
  work = read(input)  (+ aplicar avance del checkpoint si reanuda)
  attempts = {}                                         # anti-relanzamiento por gap
  repeat:
    gaps = detect_gaps(work)  menos los gaps "agotados"
    if gaps == ∅: break
    batch = top ≤3 gaps ; pending_human = []
    seed CHECKPOINT.Pending/Next = batch (refine_session) # ANTES: sembrar intención (artifact-first)
    para cada gap en batch:
      si gap = UI (requerimiento con UI, falta ## UI spec):
        componer ui-design → autora ## UI spec   # design-system/tema vía structured-choice (cuenta en el batch)
        work = integrate(work, ui)               # → ## UI spec
      si no, si factual(gap) y attempts[gap] < MAX:
        si requiere BD y >1 MCP sin default → encolar "elección MCP" en pending_human
        res = research_inline(gap)           # en la session actual: ANALYSIS-FILE → CONCLUSIONS (+SCRIPTS.sql read-only)
        si res.concluyente: work = integrate(work, res)    # → Refinement decisions
        si no: attempts[gap]++ ; si attempts[gap] >= MAX → pending_human.push(gap)
      si no:
        pending_human.push(gap)
    update CHECKPOINT (refine_session)        # DESPUÉS: Pending→Completed, en cada límite de gap (chasis § ciclo artifact-first)
    si pending_human no vacío:
      ans = structured_choice(contenido: pending_human (≤3), flow: [Compactar, Cerrar])
      switch(flow):
        Compactar → write CHECKPOINT (refine_session) ; compactar(arnés) ; continue
        Cerrar    → goto finalize
      work = integrate(work, ans)            # → Q&A traceability / Open questions
  # sin gaps materiales → analyze gate = Success criteria en verde (read-only) antes de ofrecer Guardar:
  issues = analyze(work)   # criterios trazan al Requirement · sin contradicciones · Scope coherente · Open questions cerradas/diferidas
  si issues: gaps += issues ; continue            # los hallazgos vuelven al loop como gaps
  ans = structured_choice(contenido: [Guardar refinada, Preguntar algo más],
                        flow: [Compactar, Cerrar])
  Guardar          → edit_in_place_with_confirm(spec)  # completa secciones + inserta UI spec/Refinement decisions/Q&A ; goto finalize
  Preguntar algo más → continue
  flow Compactar/Cerrar → manejar igual
finalize:
  write CHECKPOINT (refine_session)                     # persiste siempre
  si hay diferidos/followup → write/update BACKLOG (motivo + Open questions diferidas)
  cerrar refine_session ; reportar
```

## Compact / resume — claves SPEC

Mecanismo completo (3 casos, `Compactar`, re-run on demand con `--reopen`) en el chasis (§ *Compact / resume*). Claves SPEC:

- La **marca de trabajo previo** es la presencia de `## Refinement decisions` + `## Q&A traceability` en el spec (la *marca de refinado*, ver *Deliverable schema*).
- El re-refine on demand es **operación de primera clase** mientras el flujo siga en SPEC (nuevos requerimientos, cambios de scope, tras re-leer el spec): lee siempre el **spec mismo**, re-refinamiento incremental; al `Guardar`, edita in place con confirmación.

## Convergence / exit

- **Sin gaps materiales** → **analyze gate** (read-only) = **`Success criteria` en verde** (*verification-first*; la instancia SPEC del convergence gate del chasis): cada acceptance criterion traza al `Requirement`, sin contradicciones internas, `Scope` In/Out coherente, `Open questions` cerradas o explícitamente diferidas. Lo que falle **vuelve como gap**; si pasa → ofrece `Guardar especificación refinada`.
- `Guardar` → `edit_in_place_with_confirm(spec)` y `finalize`.
- `Cerrar` → `finalize` del chasis (persiste siempre `CHECKPOINT`; `BACKLOG` **solo si** hay diferidos — acá: motivo de cierre + `Open questions` diferidas).

## Integration (dónde aterriza cada resolución)

- Resuelto vía **research inline** → `## Refinement decisions` del spec (+ ref a las `CONCLUSIONS` de la session).
- Resuelto vía **humano** → `## Q&A traceability` del spec.
- Resuelto vía **capacidad `ui-design`** (gap UI) → sección `## UI spec` del spec.
- **Research inconclusa o sin resolver** → `## Open questions` del spec (diferido) + `BACKLOG.md` de la refine session (solo si queda algo diferido).
