---
name: plan-refine-loop
description: >-
  Refina un plan existente (docs/plans/PPP-plan-<slug>.md) editándolo IN PLACE,
  como paso auxiliar y NO obligatorio del flujo PLAN antes de plan-exec. Heir del
  chasis spec-refine-loop: reusa íntegro su motor gap-driven convergente, su única
  session por run, research INLINE, structured-choice con ≤3 preguntas de contenido
  + 1 control flow (Compactar/Cerrar) siempre, research autónomo con regla BD
  read-only, y artefactos como log vivo (CHECKPOINT siempre, BACKLOG solo si
  difiere). Es a plan-new lo que spec-refine es a spec-new: edita el plan-doc in
  place (no genera uno nuevo). Reusa la gap taxonomy y el coherence gate de
  plan-new-loop; agrega Refinement decisions/Q&A traceability al plan (traza, sin
  contrato de gating: plan-exec corre cualquier plan). Lo arranca /w:plan-refine y
  es reanudable + re-corrible a demanda. Invocar cuando un plan ya generado deba
  ajustarse antes de ejecutarlo.
---

# plan-refine-loop

> **Heir** del chasis [`spec-refine-loop`](../spec-refine-loop/SKILL.md). Aquí **solo** los deltas. El motor (gap-driven, sesión única, structured-choice + control `flow`, research inline + regla BD, compact/resume, artefactos como log vivo, objetivo persistente + verification-first) vive en el chasis — no se repite.

> **Relación con los otros loops de PLAN:** `plan-new-loop` **genera** el plan desde el spec; `plan-refine-loop` **lo refina in place** (opcional); `plan-exec-loop` **lo ejecuta**. plan-refine es a plan-new lo que spec-refine es a spec-new.

## Flow
PLAN

## Layer
2 — la IA lo corre entero.

## Auxiliar / NO obligatorio
`plan-exec` corre **cualquier** plan, refinado o no — **no** hay gate que exija plan-refine. Este loop existe para incorporar cambios (nuevos requerimientos, ajustes de alcance, deps/riesgos detectados al releer) **antes** de ejecutar, sin re-generar el plan desde cero.

## Started by
`/w:plan-refine` — **reanudable** (mismo mecanismo del chasis, keyado off CHECKPOINT) y **re-corrible a demanda** (ver *Compact / resume*).

## Reads
`docs/plans/PPP-plan-*.md` (glob — localiza el plan por número; o la ruta exacta del argumento del comando). **Siempre el plan mismo**: este loop lo edita in place, no hay un archivo "refined" aparte.

## Writes
Actualiza `docs/plans/PPP-plan-<slug>.md` **in place** (cuando el usuario elige `Guardar plan refinado`): completa/ajusta secciones y **agrega** `## Refinement decisions` + `## Q&A traceability`. Como sobrescribe un doc existente, **con confirmación** del usuario. Solo escribe `docs/plans` — nunca otras carpetas `docs/` ni auto-export.

## Inherits

Del chasis [`spec-refine-loop`](../spec-refine-loop/SKILL.md), sin cambios:

- **Objetivo persistente + verification-first**: persigue su `SESSION.Objective` hasta que sus `SESSION.Success criteria` están **en verde** (sembrados al inicio; acá la rúbrica = **coherencia del plan**, ver *Convergence*). Motor **gap-driven convergente** + **ciclo artifact-first** (sembrar `CHECKPOINT.Pending/Next` ANTES → `detect_gaps` → resolver → integrar → `Pending→Completed` DESPUÉS; gaps agotados con límite `MAX` no se re-disparan).
- **Una sola session por run**: descriptor `<slug>-plan-refine` → `NNN-<slug>-plan-refine` (Type = `refine`): `SESSION` + `CHECKPOINT` (+ `BACKLOG` solo si difiere). La **investigación es inline** dentro de esta session (produce `ANALYSIS-FILE`/`CONCLUSIONS` + `SCRIPTS.sql` read-only en su propia carpeta), no una session aparte. El CLI antepone el `NNN` global; el caller pasa solo el descriptor.
- **Structured-choice**: ≤3 preguntas de contenido + 1 control `flow` (`Compactar`/`Cerrar`) siempre (ver [`../../harness/SKILL.md`](../../harness/SKILL.md); en Claude Code es `AskUserQuestion`). Cada pregunta de contenido lleva **respuesta recomendada**.
- **Ask-vs-research rule** + **research autónomo inline** + **regla BD** (pregunta MCP si >1 sin default → queries a `SCRIPTS.sql` → ejecuta read-only, `sql-mutation-guard`) + manejo de research **inconclusa** (degrada a humano / difiere a `Open questions` + límite `MAX`).
- **Compact / resume** y **artefactos como log vivo (ciclo artifact-first)** (`CHECKPOINT` siempre; `BACKLOG` solo si difiere). **Integridad del gate** (anti-gaming + verificación independiente): *only command output counts*.

## Delta 1 — Deliverable: el PLAN, editado in place

El plan usa el **mismo esqueleto** que produce [`plan-new-loop`](../plan-new-loop/SKILL.md) (§ *Delta 1 — PLAN RICO*: `Summary`/`Solution`/`Impacted`/`Phases`/`Tasks`/`Validations`/`Final behavior`/… con secciones `(core)` siempre y `(opt.)` según complejidad). plan-refine **no** cambia el esquema: **completa/ajusta** las secciones existentes **in place** y **agrega** dos de traza:

```markdown
## Refinement decisions   ← NEW (se AGREGA)
Qué se ajustó al refinar y por qué (nuevos requerimientos, cambios de scope,
deps/riesgos). Incluye lo resuelto vía research inline (ref a las CONCLUSIONS
de la session).

## Q&A traceability       ← NEW (se AGREGA)
Cada duda preguntada al humano + la respuesta elegida.
```

> **Sin contrato de gating** (a diferencia de spec↔plan): la presencia de `## Refinement decisions`/`## Q&A traceability` en el plan es solo **traza de auditoría** — `plan-exec` **no** la exige ni la chequea (corre cualquier plan). Sirve para (a) distinguir un plan re-refinado de uno recién generado en el resume, y (b) dejar registro de qué cambió y por qué.

> El plan **no muta por ejecución** (eso lo trackea plan-exec en las Tasks del plan-doc) — solo por un (re-)refine.

## Delta 2 — Gap taxonomy (de "plan")

Reusa **íntegra** la gap taxonomy de [`plan-new-loop`](../plan-new-loop/SKILL.md) (§ *Delta 2*): Approach/Solution vago, componentes sin identificar, wiring AS-IS desconocido, fase muy grande, tarea no atómica, deps faltantes, criterios del spec sin cubrir, riesgos sin atender. **Diferencia de foco:** plan-new **construye** el plan desde cero; plan-refine **detecta qué cambió** respecto del plan ya escrito (o respecto del spec, si el spec se re-refinó) y cierra **esos** gaps — típicamente menos y más localizados. Un gap extra propio del re-refine:

| Gap | Signal | Resolved by |
|---|---|---|
| Deriva plan↔spec | el spec se re-refinó y el plan quedó desalineado | **research** (re-lee el spec) / **humano** |

## Delta 3 — What research investigates here

Igual que plan-new (mapea código/impacto: componentes FE/BE/BD, wiring AS-IS, deps), pero **acotado al delta**: re-verifica solo lo que el cambio toca (no re-mapea todo el plan). Regla BD del chasis igual (read-only a `SCRIPTS.sql`, MCP vía pregunta si >1 sin default).

## Compact / resume

El resume **keya off el `CHECKPOINT`** de la refine session, no de un archivo "refined". Tres casos al ejecutar `/w:plan-refine` sobre un plan:

1. **En curso** (existe `CHECKPOINT.md` en la refine session) → reanuda desde el avance (gaps resueltos, Q&A, `attempts`, research inline en curso).
2. **Sin avance** (no hay CHECKPOINT y el plan **no** tiene `Refinement decisions`/`Q&A traceability`) → arranca desde cero leyendo el plan (`PPP-plan-*.md`).
3. **Ya refinado / re-refine on demand** (no hay CHECKPOINT abierto pero el plan **ya tiene** `Refinement decisions`/`Q&A traceability`) → **operación de primera clase**: mientras el flujo siga en PLAN, re-correr `/w:plan-refine` sobre el mismo plan **cuantas veces haga falta** está soportado. `create_or_resume` detecta la refine session existente —típicamente **cerrada** tras converger— por descriptor + `## Origin` y la **reabre** (ver chasis § *Internal sessions*: detección con `aw sessions --state all` / `aw resume-summary --include-recent-closed`, reapertura con `aw session-resume --code <NNN> --reopen`); re-refinamiento incremental leyendo el **plan mismo**; al `Guardar`, edita in place con confirmación.

> **Continuidad inter-turno** (chasis, fila 2): un **comando de flujo** abre "nueva línea de trabajo" (sesión nueva) — **salvo re-correr el mismo flujo sobre la misma entrada** (mismo plan), que hace `create_or_resume` (reanuda/reabre en vez de duplicar).

## Convergence / exit

Sin gaps materiales → **coherence gate** (read-only) = **`Success criteria` en verde** (*verification-first*; el "convergence gate" del chasis para PLAN, mismo que plan-new): cada `acceptance criterion` del spec **traza** a una fase/tarea, `Final behavior` los cubre, fases XS–S / tareas XS, `deps` sin ciclos, `Impacted` consistente con `Solution`, y —propio del re-refine— **el plan quedó realineado** con lo que cambió. Lo que falle **vuelve como gap**. Si pasa → *structured-choice* (contenido: `Guardar plan refinado` / `Preguntar algo más`; flow: `Compactar`/`Cerrar`) → al `Guardar`, edita `docs/plans/PPP-plan-<slug>.md` in place (con confirmación) + inserta `Refinement decisions`/`Q&A traceability` → `finalize` (persiste `CHECKPOINT`; `BACKLOG` solo si difiere; cierra la session, reporta). `Cerrar` en cualquier momento → `finalize` igual.
