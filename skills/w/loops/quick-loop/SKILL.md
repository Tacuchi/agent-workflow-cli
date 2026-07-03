---
name: quick-loop
description: >-
  El atajo liviano de agent-workflow: resuelve una tarea acotada (fix, ajuste
  chico) desde el prompt, con ceremonia mínima y un solo commit. Heir del
  chasis (loops/CHASSIS.md + CODE-POLICIES.md). Deltas: sin plan-doc (el
  prompt ES la tarea), session ligera única <slug>-quick, gate de tamaño a la
  entrada y escalación EN VIVO a SPEC (a PLAN queda diferida) si el objetivo
  excede un quick o la tarea crece. NO toca docs/. Lo arranca /w:quick;
  reanudable. Invocar para cambios pequeños y directos que no ameritan spec
  ni plan formal.
---

# quick-loop

> **Heir** del chasis común — aquí **solo** los deltas de QUICK. El motor vive en el chasis y las *Políticas de loops que editan código* (git · BD · gate proporcional) en `CODE-POLICIES.md` — no se repiten.

## Flow
QUICK

## Layer
2 — la IA lo corre entero (loop mínimo).

## Started by
`/w:quick` — **reanudable** (mismo mecanismo de resume del chasis).

## Reads
— (el prompt del usuario; no hay documento de entrada).

## Writes
- **Deliverable según la tarea:** edita código en las fuentes (cambio mínimo) **o** produce un **análisis/diseño** acotado (deliverable no-código, vive en los artefactos de la session — no en `docs/`).
- Artefactos de la session en `.workflow/sessions/`.
- **NO toca `docs/`** (sin doc, sin auto-export). Un análisis/diseño que amerite preservarse se promueve aparte (`export-*`) o se escala a SPEC/PLAN (SPEC: en vivo — ver *Delta QUICK*).

## Internal session

- **SIEMPRE** crea una session ligera con descriptor `<slug>-quick` → `NNN-<slug>-quick` (Type = `quick`, ≈ `exec`): `SESSION` · `DECISION` · `SCRIPTS.sql` · `CHECKPOINT` (+ `BACKLOG` solo si difiere). Una sola session. La investigación es **inline** dentro de ella (`ANALYSIS-FILE`/`CONCLUSIONS` + `SCRIPTS.sql` read-only en su carpeta). El caller pasa solo el descriptor; el CLI antepone el `NNN` global y secuencial (ver chasis). **Excepción:** si el **gate de tamaño** de la entrada escala a SPEC, el run quick no llega a existir — no se crea session quick; la session es la del `spec-refine-loop`.

## Inherits

Leé **[`../CHASSIS.md`](../CHASSIS.md)** — el **motor completo** del loop — **y** **[`../CODE-POLICIES.md`](../CODE-POLICIES.md)** — las *Políticas de loops que editan código* — **siempre antes** de estos deltas. *(Si `../` no resuelve: mismos nombres junto a este archivo — regla global de layout, chasis § Resolución de referencias.)*

## Composes

`git` · `sql` (regla BD) · `research` (inline). Resueltas por `.workflow/skills.toml`.

> **Convenciones ambientes (no roles):** estándares de código/testing/redacción y `creating-tools` son skills standalone que el host auto-descubre por su `description` — el workflow no las bindea ni depende de ellas. Doctrina completa: [../../roles/README.md](../../roles/README.md).

## Delta QUICK — minimal ceremony

- **Sin fases, sin plan-doc**: el prompt **es** la tarea (una sola unidad). No hay roadmap.
- **Verification-first proporcional** (ceremonia mínima): aun acá se **siembra el check antes**, del tamaño de la tarea. Código: un test (repro del bug → fix) o "build/lint/tests existentes siguen verdes" (chore). **Análisis/diseño**: una **rúbrica falsable corta**, *ratificada por el usuario* antes de perseguirla. Es el `SESSION.Success criteria` del run (ver [chasis § *Verification-first*](../CHASSIS.md)).
- **Git y BD inline** (políticas completas en [`../CODE-POLICIES.md`](../CODE-POLICIES.md)): antes de editar, verificar rama esperada por fuente (`aw check-branch`); commit **propuesto** (aprobar antes) — nunca `push`/`--amend`/`--no-verify`. La IA **nunca ejecuta DML/DDL**: las migraciones se redactan en el `SCRIPTS.sql` de la session (consultas read-only sí, vía MCP).
- **Una sola session**. **Un solo commit** propuesto al final (solo si hubo cambios de código), **tras el gate de revisión de cierre proporcional** ([`../CODE-POLICIES.md`](../CODE-POLICIES.md) § *Gate de revisión de cierre*): re-lectura del diff + convenciones ambientes; corregir o diferir; nada llega al commit sin revisar.
- **Gate de tamaño a la ENTRADA** (antes de crear la session): al recibir el objetivo, evaluar si **excede un quick**. Dispara **solo con señales claras** (≥2 de: necesita arquitectura · ≥2 fuentes · varios entregables · feature/refactor grande · requisitos ambiguos que piden elicitación); borderline → **sigue en quick sin preguntar** (si después crece, lo cubre la escalación mid-loop). Un **resume** de una quick existente **no** re-dispara el gate. Si dispara → **structured-choice** (1 pregunta de contenido, recomendación primera + control `flow`; `Cerrar` acá = abortar, nada creado aún):
  - **Cambiar a SPEC** (recomendada) → **no se crea la session quick**: corre la *Transición en vivo a SPEC* (bullet siguiente).
  - **Seguir en quick** → continúa normal (`create_or_resume` + loop).
  - **Recortar alcance** → la IA propone la **sub-tarea que SÍ cabe** en un quick; el loop sigue con ella (`SESSION.Objective` = la sub-tarea; el prompt original queda en el `## Origin` de la session) y el resto se difiere al `BACKLOG` ("recortado en el gate — puede ameritar spec aparte, `/w:spec-new`").
  - **Anti-duplicado** (espíritu `create_or_resume`): si ya existe un spec cuyo `## Origin` referencia este mismo objetivo (o una session `*-spec-refine` equivalente), la recomendada pasa a ser **retomar ese spec** (semántica `/w:spec-refine`) — nunca materializar un segundo borrador.
- **Transición en vivo a SPEC** (compartida por el gate y la escalación mid-loop). Al aceptar, la línea de trabajo **pasa al flujo SPEC**: el consentimiento explícito en la structured-choice **equivale a invocar el comando destino** (*excepción consentida* — regla 3 de la *Regla de continuidad*, [`../../SKILL.md`](../../SKILL.md) § *Contexto operativo*). Ya del lado SPEC:
  1. **Materializar el borrador** por el procedimiento de [`../../commands/spec-new.md`](../../commands/spec-new.md): `aw next-number docs/specs`, slug, esquema, single-pass **SIN investigación**. `## Origin` = "escalado desde `/w:quick`" + el prompt original (+ la session quick de origen si existe).
  2. **Cargar y ejecutar** [`../spec-refine-loop/SKILL.md`](../spec-refine-loop/SKILL.md) — aplanada: `../w-spec-refine-loop/SKILL.md` — sobre ese spec (patrón trampolín).
  3. La session del run es la `NNN-<slug>-spec-refine` **normal** de ese loop (el CLI numera; su `## Origin` registra la escalación). **Invariante 2 intacto**: quick, mientras es quick, no escribe `docs/` — el borrador lo escribe el flujo SPEC, post-consentimiento.
- **Escalación mid-loop + handoff**: si la tarea crece (mismas señales del gate) → propone subir a **SPEC/PLAN** (structured-choice, recomendación primera). Si el usuario acepta:
  1. El **código ya editado queda** en el working tree (no se revierte) y se **registra** en `CHECKPOINT` + `BACKLOG`: "cambios sin commitear en `<fuente>` — decidir commit/descartar al retomar" (patrón "commit rechazado", [`../CODE-POLICIES.md`](../CODE-POLICIES.md) § *Git seguro*).
  2. La session quick va a `finalize` con el **puntero** en `BACKLOG`: a **PLAN** → "escalado a `docs/plans/PPP` — retomar ahí" (**diferido como hoy**: siembra + puntero, sin entrar en vivo); a **SPEC** → "escalado a `docs/specs/NNN` — **continuado en vivo** (session `NNN-<slug>-spec-refine`)".
  3. Los artefactos (`DECISION`, `SCRIPTS.sql`) **quedan en la session quick** como contexto referenciable por la nueva session (no se migran).
  4. **SPEC entra en vivo**: tras el `finalize` corre la *Transición en vivo a SPEC* (borrador **solo si no existe** spec para este objetivo; luego el loop). **Asimetría** intacta: PLAN puede **absorber** el avance (plan-exec retoma el working tree existente); SPEC **reinicia** el ciclo de diseño y trata el código a medias como contexto/referencia, no como trabajo ya ingerido.

## Continuidad entre prompts (contexto operativo)

`quick` es donde la **regla de continuidad** (ver [`../../SKILL.md`](../../SKILL.md) § *Contexto operativo*) se ve más claro. Dentro de un workspace:

1. `/w:quick "primer prompt"` (**comando**) → crea la session `NNN-<slug>-quick`, arranca el loop. Los scripts van a **su** `SCRIPTS.sql`.
2. `"segundo prompt"` (**sin comando**, trabajo relacionado) → **no** crea otra session: **continúa/reabre la más reciente** (la del paso 1) y agrega los nuevos scripts a **esa misma** `SCRIPTS.sql`.
3. `/w:quick "tercer prompt"` (**comando** otra vez) → **nueva** session, nuevo loop.

> El **comando** señala "nueva línea de trabajo"; un **prompt pelado** es "sigo en la misma" → por default continúa/reabre la más reciente (la *última iniciada*). Si es claramente no-relacionado, ofrece elegir (`continuar NNN` | `trabajo nuevo`) o cae a la rama **sin flujo** (escribe en `docs/` por convención + numeración). Sin workspace → comportamiento **vanilla**.

## Sequence

```
quick-loop(prompt):
  # GATE DE TAMAÑO — ANTES de crear session; solo línea de trabajo nueva (un resume no lo re-dispara)
  si el objetivo excede un quick (≥2 señales claras — ver Delta):
    si ya hay spec / session spec-refine de este objetivo → recomendar RETOMAR (/w:spec-refine)  # anti-duplicado
    structured_choice(contenido: [Cambiar a SPEC (recomendada), Seguir en quick, Recortar alcance],
                      flow: [Compactar, Cerrar])           # Cerrar acá = abortar (nada creado aún)
    Cambiar a SPEC   → transición en vivo (ver Delta): borrador (procedimiento spec-new) +
                       cargar y ejecutar ../spec-refine-loop/SKILL.md → FIN (sin session quick)
    Recortar alcance → objetivo = la sub-tarea propuesta; el resto → BACKLOG al crear la session
    Seguir en quick  → continuar
  s = create_or_resume("<slug>-quick")      # CLI antepone NNN global; siempre session ligera
  seed SESSION.Objective = el prompt
  seed SESSION.Success criteria = check del deliverable     # verification-first, ANTES: test(s) si código · rúbrica corta RATIFICADA si análisis/diseño
  seed CHECKPOINT.Pending/Next = la tarea (s)               # ANTES: sembrar intención (artifact-first)
  trabajar la tarea (loop mínimo):
    si edita código → verificar rama esperada por fuente (`aw check-branch`); si no → pausar + resolver
    producir el deliverable: editar código (cambio mínimo) Ó autorar el análisis/diseño
    si consulta BD read-only → SCRIPTS.sql + ejecutar read-only
    si cambio BD (DDL/DML) → SCRIPTS.sql (artefacto session, NO ejecutar)
    si decisión no obvia → DECISION
    si duda/gap → research inline ó structured-choice         # chasis
    si la tarea CRECE → proponer escalar a SPEC/PLAN          # structured-choice, recomendación primera
        acepta PLAN → handoff (avance queda; BACKLOG→plan sembrado — retomar ahí) → goto finalize
        acepta SPEC → handoff (avance queda; BACKLOG→"continuado en vivo") → finalize →
                      transición en vivo (ver Delta): borrador si falta + spec-refine-loop
  convergence gate: Success criteria en verde                # tests verdes si código · rúbrica satisfecha si análisis/diseño
  si hubo cambios de código:
    gate de revisión de cierre (proporcional):               # re-lectura del diff + convenciones ambientes instaladas
        hallazgos → corregir (re-validar) ó diferir justificado (BACKLOG)
    proponer commit (aprobar antes)                          # nunca push/amend/--no-verify; solo tras el gate
  structured_choice(contenido: [Cerrar tarea, Preguntar algo más], flow: [Compactar, Cerrar])
finalize: CHECKPOINT (DESPUÉS: Pending→Completed) + BACKLOG (solo si queda algo diferido) + cerrar session + reportar
```

## Convergence / exit

- **Success criteria en verde** (proporcional) + gate de revisión de cierre pasado y commit propuesto si hubo código (o aprobado saltarlo) → `Cerrar`.
- `Cerrar`/`Compactar` (control `flow`) → persiste `CHECKPOINT` + `BACKLOG` (reanudable).
- **Sin export**: nada va a `docs/`. Si algo amerita preservarse → se promueve aparte vía `export-*`, o se escala (a SPEC **en vivo** — la línea continúa en spec-refine ya como flujo SPEC; a PLAN **diferido**, sembrado + puntero).

> El *convergence gate* de QUICK es **verification-first proporcional**: un `Success criteria` **corto** sembrado al inicio (no la *ausencia* de checklist, sino su versión mínima) — para código, "el cambio hace lo que pedía el prompt + tests/build verdes"; para análisis/diseño, una rúbrica corta ratificada. Mínima ceremonia por diseño, pero **siempre con el check declarado antes**.
