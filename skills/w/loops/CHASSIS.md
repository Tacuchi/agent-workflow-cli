# CHASSIS — motor de los loops

Este documento es el **motor común** de los loops de agent-workflow: la doctrina que todo loop corre por debajo de sus deltas. **No es una skill** — es un documento referenciado: cada loop lo manda leer desde su `## Inherits`, **siempre, antes de sus deltas**. Si editás el motor, editálo **acá** — los heirs no lo repiten, solo lo referencian.

## Heirs (lista canónica)

Los **5 loops** corren este motor; cada uno agrega solo sus deltas:

- [`spec-refine-loop`](spec-refine-loop/SKILL.md) — refina el **spec** in place; deltas: gap taxonomy de spec, analyze gate, `## UI spec` vía la capacidad `ui-design`.
- [`plan-new-loop`](plan-new-loop/SKILL.md) — genera el **plan** desde el spec; deltas: plan rico + gap taxonomy de plan (+ design SPECs por pantalla si hay UI).
- [`plan-refine-loop`](plan-refine-loop/SKILL.md) — refina el **plan** in place (auxiliar, no obligatorio); reusa la gap taxonomy + coherence gate de `plan-new-loop`. Es a `plan-new` lo que `spec-refine` es a `spec-new`.
- [`plan-exec-loop`](plan-exec-loop/SKILL.md) — **ejecuta** el plan: código/BD/git, una sola session por run, progreso por fase en el plan-doc, sin auto-export. Aplica las políticas de [`CODE-POLICIES.md`](CODE-POLICIES.md).
- [`quick-loop`](quick-loop/SKILL.md) — el motor con **ceremonia mínima** (el prompt *es* el objetivo); aplica también [`CODE-POLICIES.md`](CODE-POLICIES.md) (gate en versión proporcional).

## Objetivo persistente

Un loop **es un objetivo persistente**: existe para cumplir el `SESSION.Objective` declarado al arrancar, y **no se considera terminado hasta que el convergence gate confirma que el objetivo se cumplió**. La iteración gap-driven es el *método*; los artefactos son el *registro*; el objetivo persistente es el *frame* que los gobierna.

Es **doctrina agnóstica**, no una dependencia del host: el "no parar hasta converger" lo sostiene el propio loop (su `repeat:` + el convergence gate), no un hook del arnés — y **deja registro durable** (artifact-first) que sobrevive compactación y resume. *(Racional y análogo con el `/goal` de Claude Code: ver diseño, `workflow-loops/chassis.md`.)*

> Cada heir instancia el frame: `spec-refine` persigue el spec; `plan-new`/`plan-refine` el plan hasta su gate; `plan-exec` el plan hasta su validación final; `quick-loop` es la encarnación más directa (el prompt *es* el objetivo).

> **Continuidad inter-turno.** El mismo `CHECKPOINT`+resume gobierna también el **próximo prompt**: el objetivo persiste **entre turnos**, no solo dentro del run. Las reglas canónicas (comando = línea nueva · re-run = `create_or_resume` · prompt pelado = continuar la más reciente · reapertura de cerradas · escalación consentida) viven en [`../SKILL.md`](../SKILL.md) § *Contexto operativo* — **única fuente**; este motor las ejecuta vía *Compact / resume* (caso 3).

## Verification-first

El objetivo persistente necesita una **condición de término checkable** — si no, el loop no sabe cuándo cumplió (o persigue un blanco que inventó). Esa condición se **siembra ANTES de ejecutar**, no se improvisa al final: es **TDD generalizado**. Junto con artifact-first (sección siguiente) son los **dos sembrados** de cada gap/fase: *cómo sabré que funcionó* + *qué voy a hacer*.

**Dónde vive:** en `SESSION.Success criteria` (ver [`../artifacts/artifacts-core/SESSION.md`](../artifacts/artifacts-core/SESSION.md)) — checklist `[ ]` de criterios **falsables** (que *pueden* fallar). `CHECKPOINT.Pending/Completed` trackea el avance **red→green**. Dos formas según el deliverable:

| Deliverable | Criterio = | Ciclo |
|---|---|---|
| código / script / fix / feature | **tests ejecutables** (unit, build, lint, repro del bug) | TDD literal: red → green → refactor |
| migración BD (no ejecutable; invariante 4) | **rúbrica**: `SCRIPTS.sql` válido + revisado (no se ejecuta) | rúbrica |
| spec / plan | **rúbrica** = los acceptance criteria del documento (referenciados, no duplicados) | rúbrica |
| análisis / diseño | **rúbrica falsable por inspección** (ej. "todos los afectados con `file:line`"; "cada decisión: rationale + ≥1 alternativa") | rúbrica |

- **Forma y peso escalan** (ceremonia mínima de quick preservada): chore = "tests/build existentes siguen verdes" (una línea); feature = acceptance tests reales. La regla es "**siempre declarar el check antes**", no "siempre escribir tests nuevos".
- **Deliverable subjetivo** (análisis/diseño): la IA **propone** la rúbrica y el **humano la ratifica** (structured-choice) antes de perseguirla.
- **Criterio irresoluble** (sin evidencia, BD no disponible): cierra `inconcluso` y el loop **degrada** (humano, o difiere a `Open questions`/`BACKLOG`) — **nunca itera en falso**.

> El **convergence gate** (sección *Convergence / exit*) es, operacionalmente, **"todos los `Success criteria` en verde"**. Los gates por-heir (analyze gate; coherencia del plan — plan-new y plan-refine; validación final; validación puntual proporcional) son **instancias** de esto, con los criterios sembrados al inicio.

**Integridad del gate (anti-gaming + verificación independiente).** El gate solo vale si no se hace trampa para pasarlo. El loop **no**:

- modifica el check ni afloja un `Success criterion` para forzar verde;
- debilita, borra ni saltea tests/validaciones;
- usa asserts triviales o tautológicos que siempre pasan (el valor esperado sale de una fuente independiente, no del propio output);
- parchea el test en lugar de arreglar la causa (preferir arreglar producción).

Ante un blocker real **para y lo reporta** (→ `Open questions`/`BACKLOG`) en vez de gamear la métrica. El veredicto cuenta **solo el output del check, no la auto-declaración** del implementador: cuando el deliverable lo justifica, la verificación final la hace una pasada **independiente** (subagente o re-lectura limpia) que no asume correcta la implementación — *only command output counts*.

## Artifacts as a live log — ciclo artifact-first

El loop trabaja **artifact-first**: el artefacto se **siembra antes** de ejecutar y se **actualiza después**, no solo al cerrar. Cada gap/fase/tarea corre el ciclo de **3 tiempos**:

1. **ANTES — sembrar la intención.** Antes de ejecutar, deja en el artefacto lo que se **va a** hacer: `CHECKPOINT.Pending`/`Next` = el trabajo inminente (`SESSION.Objective` ya fijó el qué del run).
2. **EJECUTAR.** Resolver el gap / correr la fase / editar el código.
3. **DESPUÉS — llevar al estado real.** `CHECKPOINT.Pending → Completed`; `DECISION` lo no obvio **a medida que se toma**; `BACKLOG` **solo si** algo queda diferido/followup (`session-close` ya no fabrica un BACKLOG vacío).

> El artefacto expresa la **intención** (Pending/Next, antes) y luego el **resultado** (Completed/DECISION, después), en **cada** límite de gap/fase — no solo al `Compactar`/`Cerrar`. Los artefactos de session son el registro vivo del run; el spec/plan es la **base guía**.

## Motor gap-driven convergente

El ciclo común — cada heir lo instancia en su `## Sequence` con su propia gap taxonomy:

1. `detect_gaps(work)`, menos los gaps *agotados* (ver *Research*).
2. Si `∅` → **convergence gate** (ver *Convergence / exit*).
3. Si hay gaps: tomar un batch (≤3) y **sembrar** `CHECKPOINT.Pending/Next` (*artifact-first*).
4. Resolver cada gap con su **resolutor** según la *ask-vs-research rule*: humano (structured-choice) · research inline · una capacidad compuesta (p. ej. `ui-design`).
5. **Integrar**, actualizar `CHECKPOINT` → repetir.

## Internal sessions (managed) — una session por run

El loop crea y maneja su session en `.workflow/sessions/`. **El usuario nunca la crea.** **Una sola session por run**, dueña del run: mantiene el avance vivo (`CHECKPOINT`) y habilita el resume. Artefactos: `SESSION.md` · `CHECKPOINT.md` (· `BACKLOG.md` solo si difiere; los loops que editan código suman `DECISION` y `SCRIPTS.sql`). Cada heir declara su descriptor y su `Type` en su propio `## Internal sessions`.

> **Research INLINE** — la investigación ya **no** es una session aparte: es una actividad **dentro de la session actual** que escribe sus artefactos (`ANALYSIS-FILE`/`CONCLUSIONS`, + `SCRIPTS.sql` read-only si consulta BD) **en la carpeta de la propia session del run**. Ver *Research: autonomy, scope & failure*.

> El doc de entrada del flujo (spec/plan) **nunca** entra en una session; vive en `docs/`.

### Numeración de sessions (regla dura)

El **CLI es dueño del número**: `aw session-create` antepone un `NNN` **global y secuencial** escaneando **todas** las sessions de `.workflow/sessions/` (cualquier tipo). El caller pasa **solo el descriptor** vía `--name` — **nunca** un número. Así la numeración no se reinicia por tipo ni colisiona, y cada folder queda **autodescriptivo** con la forma `NNN-<slug>-<flow>` (ej.: `002-correo-otp-spec-refine`, `003-correo-otp-plan-new`, `004-correo-otp-plan-exec`, `005-validacion-correo-quick`).

> `<run>` = el **descriptor** (sin número) de la session del run, siempre con forma **`<slug>-<flow>`**: `<slug>-spec-refine`, `<slug>-plan-new`, `<slug>-plan-refine`, `<slug>-plan-exec`, `<slug>-quick`. El `<slug>` es **descriptivo** y sale del doc de entrada del flujo — `docs/specs/NNN-spec-<slug>.md` para spec-refine/plan-new; `docs/plans/PPP-plan-<slug>.md` para plan-refine/plan-exec; el prompt para quick — para que el folder diga de un vistazo de qué trata, no solo qué flujo lo creó. Como la investigación es **inline** en esta misma session, ya no hay sessions hijas `*-research-*` que numerar (compat: las viejas son históricas).
>
> **Resume**: localiza la session existente **escaneando** `.workflow/sessions/` por descriptor + `## Origin` (qué spec/plan), **no** reconstruyendo el número (que es global, no derivable del artefacto). `aw session-resume --code <NNN | folder>` resuelve ambas formas.

**CLI**:
- `aw session-create --type <type> --name <slug>-<flow>` → crea `NNN-<slug>-<flow>` / `aw session-resume --code <…>` (detecta `CHECKPOINT`).
- `aw checkpoint-write` / `aw checkpoint-read` para el resume.
- `aw session-close` al cerrar (con razón); `aw session-artifacts` para inspeccionar.
- **Reabrir para continuar** (contexto operativo, fila 2): `aw session-resume --code <NNN> --reopen` reactiva una sesión **cerrada** (quita `.closed` → activa) para seguir trabajando en ella; sin `--reopen`, el resume es read-only. Para detectar cuál es la más reciente cerrada: `aw resume-summary --include-recent-closed` (o `aw sessions --state all`).

## Ask-vs-research rule (el discriminador)

Para cada gap, una sola pregunta decide el resolutor:

> *"¿Puedo responder esto leyendo el repo/datos?"* → **research** (autónomo).
> *"¿Depende de lo que el usuario quiere?"* → **preguntar al humano** (structured-choice).

## Research: autonomy, scope & failure

La investigación es **inline**: una actividad **dentro de la session actual del run**, no una session aparte. Escribe sus artefactos (`ANALYSIS-FILE` → `CONCLUSIONS`, + `SCRIPTS.sql` read-only si consulta BD) en la **carpeta de la propia session**.

- **Autónomo**: la IA investiga inline y reporta **sin pedir permiso**. El humano se entera al integrarse (en el registro de decisiones del flujo — p. ej. `## Refinement decisions` en los refine loops, `DECISION` en los que editan código) y mantiene control vía el control `flow`.
- **Alcance**: workspace + repos asociados (fuentes) + MCPs de BD.
- **Regla BD** (única excepción a la autonomía):
  1. **Elección de MCP**: si el gap requiere BD y hay **>1 MCP candidato sin default configurado**, la IA pregunta cuál usar. Esa pregunta va por la **misma structured-choice** como una **pregunta de contenido** (cuenta dentro del límite ≤3 + `flow`), **antes** de ejecutar queries. Si hay un único MCP o un default, no pregunta.
  2. Escribe **primero** las queries en `SCRIPTS.sql` de la session.
  3. Las ejecuta **read-only** vía MCP (respeta `sql-mutation-guard`: nunca DML/DDL).
- **Research inconclusa** (BD no disponible, evidencia insuficiente, gap factual irresoluble):
  - La investigación concluye con estado **`inconcluso`** en `CONCLUSIONS` y reporta el motivo.
  - El loop **degrada** el gap: lo pasa a **pregunta-al-humano** (próximo batch → el registro de Q&A del flujo: `Q&A traceability` en los refine loops, `DECISION` en los que editan código) o, si tampoco aplica, lo **difiere** a las `## Open questions` del doc del flujo (spec/plan) — o al `BACKLOG` de la session si el flujo no tiene doc (quick).
  - El gap se marca **"ya intentado vía research"** (`attempts[gap]++`, límite `MAX`) para que `detect_gaps` **no lo re-dispare en bucle** → garantiza convergencia.

## Structured-choice (design & batching)

**Regla canónica (única fuente — el resto del corpus solo referencia):** *structured-choice* = **≤3 preguntas de contenido + 1 control `flow`**, siempre. Binding por arnés en [`../harness/SKILL.md`](../harness/SKILL.md) (Claude Code: `AskUserQuestion`, máx 4 preguntas/llamada; sin elección estructurada, degrada a **markdown numerado**).

- Como el control `flow` va **siempre** → **≤3 preguntas de contenido + 1 control `flow`**.
- **control `flow`** (ciclo de vida, siempre presente): `Compactar` | `Cerrar`. Responder solo las preguntas de contenido (sin tocar `flow`) = seguir iterando.
- **Preguntas de contenido** posibles:
  - dudas-de-humano (gaps no factuales);
  - elección de MCP (regla BD) — antes de ejecutar queries;
  - en **convergencia**, la acción de cierre propia del loop — **cada heir la define en su *Convergence / exit*** (p. ej. `Guardar especificación refinada` · `Cerrar tarea`) — | `Preguntar algo más`.
- **Batching**: agrupar hasta 3 gaps de humano en una sola llamada. Si hay más de 3 pendientes, priorizar (los que desbloquean otros gaps primero) y diferir el resto a la próxima vuelta.
- **Respuesta recomendada por pregunta**: cada pregunta de contenido lleva **siempre** la respuesta que la IA recomienda — como primera opción (marcada *recomendada*) en `AskUserQuestion`, o señalada en el markdown numerado al degradar. Nunca se pregunta "a secas": el humano ratifica o corrige una propuesta, no parte de cero. La IA recomienda en base a lo investigado (regla ask-vs-research), no por defecto vacío.

## Compact / resume

El resume **keya off el `CHECKPOINT`** de la session del run, no de la existencia de un archivo aparte. Tres casos al ejecutar el comando del flujo sobre una entrada:

1. **En curso** (existe `CHECKPOINT.md` en la session) → reanuda desde el avance (gaps resueltos, Q&A, `attempts`, research inline en curso).
2. **Sin avance** (no hay CHECKPOINT y el doc de entrada **no** tiene la marca de trabajo previo del flujo) → arranca desde cero leyendo el doc de entrada.
3. **Ya convergido / re-run on demand** (no hay CHECKPOINT abierto pero el doc **ya tiene** la marca) → **operación de primera clase**: mientras el flujo siga en su etapa, re-correr el comando sobre la misma entrada **cuantas veces haga falta** está soportado. `create_or_resume` detecta la session existente —típicamente **cerrada** tras converger— por descriptor + `## Origin` y la **reabre** (ver *Internal sessions*: detección con `aw sessions --state all` / `aw resume-summary --include-recent-closed`, reapertura con `aw session-resume --code <NNN> --reopen`); trabajo incremental leyendo el **doc mismo**.

> Cada heir define su **marca de trabajo previo**: en los refine loops, la presencia de `## Refinement decisions` + `## Q&A traceability` en el doc; en plan-exec, los checkbox `- [x]` del plan-doc; quick no tiene doc (resume solo por CHECKPOINT).

> **`Compactar`** (control `flow`, transversal a los 3 casos) → escribe `CHECKPOINT.md` en la session (avance en progreso, gaps restantes, Q&A, `attempts`) → dispara la **compactación** del arnés (en Claude Code: `/compact`; ver [`../harness/SKILL.md`](../harness/SKILL.md)) → reanuda leyendo el checkpoint.

## Convergence / exit

- **Sin gaps materiales** → **convergence gate** (read-only) = **`Success criteria` en verde** (*verification-first*). Lo que falle **vuelve como gap**; si pasa → el loop ofrece su acción de cierre. Los heirs son **instancias** del mismo gate: `spec-refine` = analyze gate, `plan-new` y `plan-refine` = coherencia del plan, `plan-exec` = validación final, `quick` = validación puntual proporcional.
- `Cerrar` (control `flow`, en cualquier momento) → `finalize`. **`finalize` persiste siempre el `CHECKPOINT.md`** (reanudable) y, **solo si hay algo diferido/followup**, escribe `BACKLOG.md` (motivo de cierre + lo diferido); cierra la session y reporta. Así sobrevive el avance aunque no se haya `Compactar` antes.

## docs/ boundary — sin auto-export (regla dura)

Un loop escribe en `docs/` **solo** el doc de su propio flujo (spec-refine: `docs/specs` · plan-new/plan-refine/plan-exec: `docs/plans` · quick: **ninguno** — no toca `docs/`). Ningún loop **gradúa/promueve artefactos** a `docs/`: todo lo demás (migraciones → `docs/scripts`, manuales → `docs/manuals`, diagramas → `docs/diagrams`, etc.) lo hacen skills **`export-*`** aparte, como paso explícito posterior. Los artefactos quedan en sus sessions hasta entonces. Si una tarea crea una herramienta/utilidad, la documenta la skill ambiente `creating-tools` en `docs/tools` (auto-descubierta por su `description`; el workflow es **indiferente**, no la bindea).

## Políticas de loops que editan código → `CODE-POLICIES.md`

Los loops que **editan código** (`plan-exec-loop`, `quick-loop`) corren además las políticas de [`CODE-POLICIES.md`](CODE-POLICIES.md) — **git seguro** (rama verificada + commits propuestos) · **BD solo-scripts** · **gate de revisión de cierre** (proporcional en quick). Las mandan leer desde su `## Inherits` **junto con este chasis**; los loops de documento (spec-refine, plan-new, plan-refine) **no** las cargan — por eso viven en un doc aparte.

## Resolución de referencias (regla global de layout)

Vale para **toda** referencia relativa de la doctrina — no se repite por link:

1. **Instalación normal** (árbol `w/`): la ruta relativa resuelve tal cual (`../CHASSIS.md`, `../../commands/spec-new.md`).
2. **Instalación aplanada** (p. ej. Warp/Oz): los `.md` compartidos (`CHASSIS.md`, `CODE-POLICIES.md`) están **junto al `SKILL.md` del loop**; otro loop es una skill **hermana** `w-<loop>/` (ej. `../spec-refine-loop/SKILL.md` → `../w-spec-refine-loop/SKILL.md`).
3. Referencia que no resuelva = **profundización opcional** — la doctrina de este motor es autocontenida.

El chasis **no es una skill** (sin frontmatter; no se invoca ni se bindea vía `.workflow/skills.toml`): entra al contexto solo porque un loop manda leerlo desde su `## Inherits`. No define flujo, deliverable ni gap taxonomy — eso es de cada heir.
