---
name: spec-refine-loop
description: >-
  El CHASIS de los loops de agent-workflow. Refina un spec borrador
  (docs/specs/NNN-spec-<slug>.md) editándolo IN PLACE hasta dejarlo sin
  ambigüedad, mediante un motor gap-driven convergente: detecta
  huecos/ambigüedades, los resuelve preguntando al humano (lo que depende de su
  intención) o investigando de forma autónoma INLINE en la propia session
  (lo que se responde leyendo el repo/datos), integra y repite hasta converger.
  Compone la capacidad ui-design (built-in ui-spec) cuando el requerimiento
  involucra UI. Lo arranca el comando /w:spec-refine y es reanudable vía
  CHECKPOINT. Usa structured-choice con ≤3 preguntas de contenido + 1 control flow
  (Compactar/Cerrar) siempre presente; mantiene sus artefactos como log vivo
  (CHECKPOINT siempre, BACKLOG solo si difiere). Es el patrón de referencia que
  heredan plan-new-loop, plan-exec-loop y quick-loop. Invocar cuando haya que
  refinar/desambiguar una especificación antes de planificar.
---

# spec-refine-loop

> **El CHASIS.** Primer loop diseñado en detalle; patrón de referencia que heredan los demás loops (`plan-new-loop`, `plan-exec-loop`, `quick-loop`). Si editas el motor, edítalo aquí.

## Flow
SPEC

## Layer
2 — la IA lo corre entero (gap-driven). El usuario no conduce el ciclo; solo responde preguntas de contenido y dirige el ciclo de vida por el control `flow`.

## Started by
`/w:spec-refine` — **reanudable**. Detecta el estado previo (vía CHECKPOINT) y arranca según corresponda (ver *Compact / resume*).

## Reads
- `docs/specs/NNN-spec*.md` (glob — localiza el spec por número, también captura el legacy `NNN-spec.md`), **o** la ruta exacta pasada en el argumento del comando. **Siempre el spec mismo**: este loop lo edita in place, no hay un archivo "refined" aparte.

## Writes
Actualiza `docs/specs/NNN-spec-<slug>.md` **in place** (cuando el usuario elige `Guardar especificación refinada`): completa secciones y **agrega** `## Refinement decisions` + `## Q&A traceability`, cerrando `Open questions` a medida que se resuelven. Como sobrescribe un doc existente, **con confirmación** del usuario.

> **Invariante de boundary:** este loop escribe **solo** en `docs/specs`. Nunca gradúa/exporta otros artefactos a `docs/` — eso es trabajo de `export-*`, aparte.

## Objetivo persistente (chasis — heredado por todos los loops)

Un loop **es un objetivo persistente**: existe para cumplir el `SESSION.Objective` declarado al arrancar, y **no se considera terminado hasta que el convergence gate confirma que el objetivo se cumplió**. La iteración gap-driven es el *método*; los artefactos son el *registro*; el objetivo persistente es el *frame* que los gobierna.

Está **modelado en cómo se comporta el `/goal` de Claude Code** (declarás un objetivo, el agente no para hasta cumplirlo, auto-completa al cumplirse, con corte explícito para abortar antes) pero como **doctrina agnóstica, no una dependencia del host**: el "no parar hasta converger" lo sostiene el propio loop (su `repeat:` + el convergence gate), no un Stop hook del arnés — ningún host necesita `/goal`. Y, a diferencia del `/goal` pelado, **deja registro durable** (artifact-first) que sobrevive compactación y resume.

| Comportamiento de `/goal` (ejemplo) | Análogo agnóstico en el loop |
|---|---|
| declarar el objetivo | `SESSION.Objective` |
| no parar hasta cumplirlo | `repeat:` gap-driven hasta `gaps == ∅` |
| objetivo cumplido → auto-clear | **convergence gate** pasa → `finalize` |
| `/goal clear` (abortar antes) | control `flow` `Cerrar` |
| la directiva sobrevive el contexto | `CHECKPOINT` + resume |

> Los heirs heredan el frame: `plan-new`/`plan-exec` persiguen el plan hasta su gate; `quick-loop` es la encarnación más directa (el prompt *es* el objetivo) — el "símil a `/goal`" del modelo.

## Verification-first (chasis — heredado por todos los loops)

El objetivo persistente necesita una **condición de término checkable** — si no, el loop no sabe cuándo cumplió (o persigue un blanco que inventó). Esa condición se **siembra ANTES de ejecutar**, no se improvisa al final: es **TDD generalizado**. Junto con artifact-first (sección siguiente) son los **dos sembrados** de cada gap/fase: *cómo sabré que funcionó* + *qué voy a hacer*.

**Dónde vive:** en `SESSION.Success criteria` (ver [`../../artifacts/artifacts-core/SESSION.md`](../../artifacts/artifacts-core/SESSION.md)) — checklist `[ ]` de criterios **falsables** (que *pueden* fallar). `CHECKPOINT.Pending/Completed` trackea el avance **red→green**. Dos formas según el deliverable:

| Deliverable | Criterio = | Ciclo |
|---|---|---|
| código / script / fix / feature | **tests ejecutables** (unit, build, lint, repro del bug) | TDD literal: red → green → refactor |
| migración BD (no ejecutable; invariante 4) | **rúbrica**: `SCRIPTS.sql` válido + revisado (no se ejecuta) | rúbrica |
| spec / plan | **rúbrica** = los acceptance criteria del documento (referenciados, no duplicados) | rúbrica |
| análisis / diseño | **rúbrica falsable por inspección** (ej. "todos los afectados con `file:line`"; "cada decisión: rationale + ≥1 alternativa") | rúbrica |

**Forma y peso escalan** (preserva la *ceremonia mínima* de quick): un chore es "tests/build existentes siguen verdes" (una línea); un feature, acceptance tests reales. No es "siempre escribir tests nuevos" — es "**siempre declarar el check antes**". Para deliverables **subjetivos** (análisis/diseño) la IA **propone** la rúbrica y el **humano la ratifica** (structured-choice) antes de perseguirla. **Criterio irresoluble** (sin evidencia, BD no disponible) → cierra `inconcluso` + el loop **degrada** (humano, o difiere a `Open questions`/`BACKLOG`); nunca itera en falso.

> El **convergence gate** (sección *Convergence / exit*) es, operacionalmente, **"todos los `Success criteria` en verde"**. Los gates por-heir (analyze gate, coherencia del plan, validación final, validación puntual proporcional) son **instancias** de esto, con los criterios sembrados al inicio.

## Artifacts as a live log — ciclo artifact-first (chasis — heredado por todos los loops)

El loop trabaja **artifact-first**: el artefacto se **siembra antes** de ejecutar y se **actualiza después**, no solo al cerrar. Cada gap/fase/tarea corre el ciclo de **3 tiempos**:

1. **ANTES — sembrar la intención.** Antes de ejecutar, deja en el artefacto lo que se **va a** hacer: `CHECKPOINT.Pending`/`Next` = el trabajo inminente (`SESSION.Objective` ya fijó el qué del run).
2. **EJECUTAR.** Resolver el gap / correr la fase / editar el código.
3. **DESPUÉS — llevar al estado real.** `CHECKPOINT.Pending → Completed`; `DECISION` lo no obvio **a medida que se toma**; `BACKLOG` **solo si** algo queda diferido/followup (`session-close` ya no fabrica un BACKLOG vacío).

> El artefacto expresa la **intención** (Pending/Next, antes) y luego el **resultado** (Completed/DECISION, después), en **cada** límite de gap/fase — no solo al `Compactar`/`Cerrar`. Los artefactos de session son el registro vivo del run; el spec/plan es la **base guía**.

## Internal sessions (managed)

El loop crea y maneja su session en `.workflow/sessions/`. El usuario nunca la crea.

| Session | When | Artifacts | Role |
|---|---|---|---|
| **refine session** `NNN-spec-refine/` | al arrancar el loop (o se reanuda) | `SESSION.md` · `CHECKPOINT.md` (· `BACKLOG.md` solo si difiere) | Dueña del run. Mantiene el avance vivo (CHECKPOINT) y habilita el resume. Type = `refine`. |

> **Research INLINE** — la investigación ya **no** es una session aparte: es una actividad **dentro de la session actual** que escribe sus artefactos (`ANALYSIS-FILE`/`CONCLUSIONS`, + `SCRIPTS.sql` read-only si consulta BD) **en la carpeta de la propia session del run**. Ver *Research: autonomy, scope & failure*.

> El spec **nunca** entra en una session; vive en `docs/specs/`.

> **Compat (legacy):** workspaces viejos pueden tener `NNN-spec.md` / `NNN-spec-refined.md` y sessions `*-research-*` aparte — son históricos y se dejan tal cual. El glob `NNN-spec*.md` igual encuentra el spec base, y re-correr spec-refine lo edita in place de ahí en adelante.

### Numeración de sessions (regla dura, heredada por todos los loops)

El **CLI es dueño del número**: `aw session-create` antepone un `NNN` **global y secuencial** escaneando **todas** las sessions de `.workflow/sessions/` (cualquier tipo). El caller pasa **solo el descriptor** vía `--name` — **nunca** un número. Así la numeración no se reinicia por tipo ni colisiona (ej.: `001-spec-refine`, `002-plan-new`, `003-plan-exec`, …).

> `<run>` = el **descriptor** (sin número) de la session del run: `spec-refine`, `plan-new`, `plan-exec`; QUICK usa `<slug>-quick` (slug del prompt). Como la investigación es **inline** en esta misma session, ya no hay sessions hijas `*-research-*` que numerar (compat: las viejas son históricas).
>
> **Resume**: localiza la session existente **escaneando** `.workflow/sessions/` por descriptor + `## Origin` (qué spec/plan), **no** reconstruyendo el número (que es global, no derivable del artefacto). `aw session-resume --code <NNN | folder>` resuelve ambas formas.

**CLI**:
- `aw session-create --type refine --name spec-refine` → crea `NNN-spec-refine` / `aw session-resume --code <…>` (detecta `CHECKPOINT`).
- `aw checkpoint-write` / `aw checkpoint-read` para el resume.
- `aw session-close` al cerrar (con razón); `aw session-artifacts` para inspeccionar.

## Composes

El gap **UI sin especificar** (cuando el requerimiento involucra UI; ver *Gap taxonomy*) se resuelve **componiendo** la capacidad **`ui-design`** (default built-in `ui-spec`; rebindeable vía `.workflow/skills.toml`): autora el UI spec nativamente (estructura, vocabulario, formato Markdown). Es un tercer modo de resolución de gap (junto a *research* y *humano*): el loop aporta la iteración/Q&A que el viejo servicio no tenía (design-system, tema, variantes, desambiguación) **vía la misma structured-choice**, y lo integra como sección `## UI spec` del spec.

Otras capacidades transversales que el chasis usa siempre: `research` (research **inline**, ver abajo), `sql` (regla BD en research), `writing` (redacción del spec). Todas se resuelven por config; `off` → el loop sigue sin la capacidad y, si era necesaria, lo dice o pregunta.

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

## Ask-vs-research rule (el discriminador)

Para cada gap, una sola pregunta decide el resolutor:

> *"¿Puedo responder esto leyendo el repo/datos?"* → **research** (autónomo).
> *"¿Depende de lo que el usuario quiere?"* → **preguntar al humano** (structured-choice).

## Research: autonomy, scope & failure

La investigación es **inline**: una actividad **dentro de la session actual del run**, no una session aparte. Escribe sus artefactos (`ANALYSIS-FILE` → `CONCLUSIONS`, + `SCRIPTS.sql` read-only si consulta BD) en la **carpeta de la propia session**.

- **Autónomo**: la IA investiga inline y reporta **sin pedir permiso**. El humano se entera al integrarse (en `Refinement decisions`) y mantiene control vía el control `flow`.
- **Alcance**: workspace + repos asociados (fuentes) + MCPs de BD.
- **Regla BD** (única excepción a la autonomía):
  1. **Elección de MCP**: si el gap requiere BD y hay **>1 MCP candidato sin default configurado**, la IA pregunta cuál usar. Esa pregunta va por la **misma structured-choice** como una **pregunta de contenido** (cuenta dentro del límite ≤3 + `flow`), **antes** de ejecutar queries. Si hay un único MCP o un default, no pregunta.
  2. Escribe **primero** las queries en `SCRIPTS.sql` de la session.
  3. Las ejecuta **read-only** vía MCP (respeta `sql-mutation-guard`: nunca DML/DDL).
- **Research inconclusa** (BD no disponible, evidencia insuficiente, gap factual irresoluble):
  - La investigación concluye con estado **`inconcluso`** en `CONCLUSIONS` y reporta el motivo.
  - El loop **degrada** el gap: lo pasa a **pregunta-al-humano** (próximo batch → `Q&A traceability`) o, si tampoco aplica, lo **difiere** a `## Open questions` del spec.
  - El gap se marca **"ya intentado vía research"** (`attempts[gap]++`, límite `MAX`) para que `detect_gaps` **no lo re-dispare en bucle** → garantiza convergencia.

## Structured-choice (design & batching)

*structured-choice* (capacidad del arnés — ver `../../harness/SKILL.md`). En **Claude Code** es `AskUserQuestion` (máx 4 preguntas/llamada → **≤3 preguntas de contenido + 1 control `flow`**); en un arnés sin elección estructurada, degrada a **markdown numerado**.

- Como el control `flow` va **siempre** → **≤3 preguntas de contenido + 1 control `flow`**.
- **control `flow`** (ciclo de vida, siempre presente): `Compactar` | `Cerrar`. Responder solo las preguntas de contenido (sin tocar `flow`) = seguir iterando.
- **Preguntas de contenido** posibles:
  - dudas-de-humano (gaps no factuales);
  - elección de MCP (regla BD) — antes de ejecutar queries;
  - en **convergencia**, acción: `Guardar especificación refinada` | `Preguntar algo más`.
- **Batching**: agrupar hasta 3 gaps de humano en una sola llamada. Si hay más de 3 pendientes, priorizar (los que desbloquean otros gaps primero) y diferir el resto a la próxima vuelta.

## Sequence

```
spec-refine-loop(spec):
  input = glob(NNN-spec*.md) | argumento (ruta)         # siempre el spec mismo (in place)
  refine_session = create_or_resume("spec-refine")      # CLI antepone NNN global; resume localiza por descriptor/origin
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
    update CHECKPOINT (refine_session)        # DESPUÉS: Pending→Completed, en cada límite de gap (ver ciclo artifact-first)
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

```mermaid
flowchart TD
    S["input = glob NNN-spec*.md (el spec mismo)<br/>create_or_resume refine session"] --> D{"¿gaps<br/>(no agotados)?"}
    D -->|no| AN{"analyze gate<br/>criterios↔Requirement · sin contradicciones<br/>Scope · Open questions cerradas/diferidas"}
    AN -->|falla| D
    AN -->|ok| C["structured-choice<br/>contenido[Guardar refinada · Preguntar más]<br/>flow[Compactar · Cerrar]"]
    D -->|sí| B["tomar ≤3 gaps"]
    B --> K{"tipo de gap"}
    K -->|UI| UI["componer ui-design<br/>→ ## UI spec (design-system/tema vía structured-choice)"]
    K -->|factual y attempts&lt;MAX| RS["research INLINE en la session<br/>ANALYSIS-FILE → CONCLUSIONS (+SCRIPTS.sql)"]
    K -->|humano| Q["structured-choice<br/>contenido[dudas + elección MCP ≤3]<br/>flow[Compactar · Cerrar]"]
    RS --> CC{"¿concluyente?"}
    CC -->|sí| I1["integrar → Refinement decisions"]
    CC -->|no| DEG["attempts++ ; degradar a humano / Open questions"]
    Q --> I2["integrar → Q&A traceability"]
    UI --> CK["update CHECKPOINT (Pending→Completed)"]
    I1 --> CK
    DEG --> CK
    I2 --> CK
    CK --> D
    C -->|Guardar| W["edit IN PLACE con confirmación<br/>completa + inserta UI spec/Refinement decisions/Q&A"]
    C -->|Preguntar más| D
    W --> FIN["finalize: CHECKPOINT (+ BACKLOG si difiere)<br/>+ cerrar session + reportar"]
```

## Compact / resume

El resume **keya off el `CHECKPOINT`** de la refine session, no de la existencia de un archivo "refined". Tres casos al ejecutar `/w:spec-refine` sobre un spec:

1. **En curso** (existe `CHECKPOINT.md` en la refine session) → reanuda desde el avance (gaps resueltos, Q&A, `attempts`, research inline en curso).
2. **Sin avance** (no hay CHECKPOINT y el spec **no** tiene `Refinement decisions`/`Q&A traceability`) → arranca desde cero leyendo el spec (`NNN-spec*.md`).
3. **Ya refinado** (no hay CHECKPOINT abierto pero el spec **ya tiene** `Refinement decisions`/`Q&A traceability`) → re-refinamiento incremental leyendo el **spec mismo**; al `Guardar`, edita in place con confirmación.

> **`Compactar`** (control `flow`, transversal a los 3 casos) → escribe `CHECKPOINT.md` en la refine session (spec en progreso, gaps restantes, Q&A, `attempts`) → dispara la **compactación** del arnés (en Claude Code: `/compact`; ver `../../harness/SKILL.md`) → reanuda leyendo el checkpoint.

## Convergence / exit

- **Sin gaps materiales** → **analyze gate** (read-only) = **`Success criteria` en verde** (*verification-first*): cada acceptance criterion traza al `Requirement`, sin contradicciones internas, `Scope` In/Out coherente, `Open questions` cerradas o explícitamente diferidas. Lo que falle **vuelve como gap**; si pasa → ofrece `Guardar especificación refinada`. *(Es el "convergence gate" del chasis; los heirs son instancias: plan-new = coherencia del plan, plan-exec = validación final, quick = validación puntual proporcional.)*
- `Guardar` → `edit_in_place_with_confirm(spec)` y `finalize`.
- `Cerrar` (control `flow`, en cualquier momento) → `finalize`. **`finalize` persiste siempre el `CHECKPOINT.md`** (reanudable) y, **solo si hay algo diferido/followup**, escribe `BACKLOG.md` (motivo de cierre + `Open questions` diferidas); cierra la session y reporta. Así sobrevive el avance aunque no se haya `Compactar` antes.

## Integration (dónde aterriza cada resolución)

- Resuelto vía **research inline** → `## Refinement decisions` del spec (+ ref a las `CONCLUSIONS` de la session).
- Resuelto vía **humano** → `## Q&A traceability` del spec.
- Resuelto vía **capacidad `ui-design`** (gap UI) → sección `## UI spec` del spec.
- **Research inconclusa o sin resolver** → `## Open questions` del spec (diferido) + `BACKLOG.md` de la refine session (solo si queda algo diferido).

## Heredan este chasis

- `plan-new-loop` — mismo motor; deltas: plan rico + gap taxonomy de plan.
- `plan-exec-loop` — mismo motor; deltas: ejecución real (código/BD/git), **una sola session por run** (progreso por fase en el plan-doc), sin auto-export.
- `quick-loop` — mismo motor (mínimo); hereda además git/BD/no-export de `plan-exec-loop`.
