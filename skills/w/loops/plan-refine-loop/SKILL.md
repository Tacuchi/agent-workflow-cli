---
name: plan-refine-loop
description: >-
  Refina un plan existente (docs/plans/PPP-plan-<slug>.md) editándolo IN
  PLACE — paso auxiliar y NO obligatorio antes de plan-exec. Heir del chasis
  (loops/CHASSIS.md). Deltas: reusa la gap taxonomy y el coherence gate de
  plan-new-loop, agrega Refinement decisions / Q&A traceability (traza, sin
  gating), y produce/actualiza design SPECs vía ui-design si el refine toca
  UI. Lo arranca /w:plan-refine; reanudable y re-corrible a demanda. Invocar
  cuando un plan ya generado deba ajustarse antes de ejecutarlo.
---

# plan-refine-loop

> **Heir** del chasis común — aquí **solo** los deltas de PLAN-refine. El motor no se repite.

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
Actualiza `docs/plans/PPP-plan-<slug>.md` **in place** (cuando el usuario elige `Guardar plan refinado`): completa/ajusta secciones y **agrega** `## Refinement decisions` + `## Q&A traceability`. Como sobrescribe un doc existente, **con confirmación** del usuario. Solo escribe `docs/plans` — nunca otras carpetas `docs/` ni auto-export. Si el refine **toca UI**, además produce/actualiza **design SPECs** (`NNN-SPEC-<SLUG>.md`) como artefactos **de su propia sesión** (ver *Delta 4* — no son `docs/`, no hay auto-export).

## Inherits

Leé **[`../CHASSIS.md`](../CHASSIS.md)** — el **motor completo** del loop — **siempre antes** de estos deltas. *(Si `../` no resuelve: `CHASSIS.md` junto a este archivo — regla global de layout, chasis § Resolución de referencias.)*

## Internal sessions — instancia PLAN-refine

Doctrina completa en el chasis (§ *Internal sessions* + *Numeración*). La instancia de este loop:

| Session | When | Artifacts | Role |
|---|---|---|---|
| **refine session** `NNN-<slug>-plan-refine/` | al arrancar el loop (o se reanuda/reabre) | `SESSION.md` · `CHECKPOINT.md` (· `BACKLOG.md` solo si difiere) | Dueña del run. Type = `refine`; descriptor `<slug>-plan-refine` (el `<slug>` sale del plan de entrada). |

## Delta 1 — Deliverable: el PLAN, editado in place

El plan usa el **mismo esqueleto** que produce [`plan-new-loop`](../plan-new-loop/SKILL.md) (en instalaciones aplanadas: la copia hermana `w-plan-new-loop/SKILL.md`) (§ *Delta 1 — PLAN RICO*: `Summary`/`Solution`/`Impacted`/`Phases`/`Tasks`/`Validations`/`Final behavior`/… con secciones `(core)` siempre y `(opt.)` según complejidad). plan-refine **no** cambia el esquema: **completa/ajusta** las secciones existentes **in place** y **agrega** dos de traza:

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

Reusa **íntegra** la gap taxonomy de [`plan-new-loop`](../plan-new-loop/SKILL.md) (§ *Delta 2*): Approach/Solution vago, componentes sin identificar, wiring AS-IS desconocido, fase muy grande, tarea no atómica, deps faltantes, criterios del spec sin cubrir, riesgos sin atender, UI sin design SPEC. **Diferencia de foco:** plan-new **construye** el plan desde cero; plan-refine **detecta qué cambió** respecto del plan ya escrito (o respecto del spec, si el spec se re-refinó) y cierra **esos** gaps — típicamente menos y más localizados. Un gap extra propio del re-refine:

| Gap | Signal | Resolved by |
|---|---|---|
| Deriva plan↔spec | el spec se re-refinó y el plan quedó desalineado | **research** (re-lee el spec) / **humano** |

## Delta 3 — What research investigates here

Igual que plan-new (mapea código/impacto: componentes FE/BE/BD, wiring AS-IS, deps), pero **acotado al delta**: re-verifica solo lo que el cambio toca (no re-mapea todo el plan). Regla BD del chasis igual (read-only a `SCRIPTS.sql`, MCP vía pregunta si >1 sin default).

## Delta 4 — Design SPECs (si el refine toca UI)

Mismo mecanismo que [`plan-new-loop`](../plan-new-loop/SKILL.md) (§ *Delta 4*: capacidad **`ui-design`** → `NNN-SPEC-<SLUG>.md` por pantalla, ver [`SPEC.md`](../../artifacts/artifacts-design/SPEC.md)), **acotado al delta**: solo las pantallas **nuevas o cambiadas** por el refine reciben design SPEC. El SPEC actualizado se escribe en **la sesión propia** del plan-refine (cada loop maneja los artefactos de SU sesión — no edita los de la sesión de plan-new) y el plan **re-apunta** la referencia de la Task UI al SPEC vigente. Pantallas no tocadas conservan su SPEC original.

## Compact / resume

El resume **keya off el `CHECKPOINT`** de la refine session, no de un archivo "refined". Tres casos al ejecutar `/w:plan-refine` sobre un plan:

1. **En curso** (existe `CHECKPOINT.md` en la refine session) → reanuda desde el avance (gaps resueltos, Q&A, `attempts`, research inline en curso).
2. **Sin avance** (no hay CHECKPOINT y el plan **no** tiene `Refinement decisions`/`Q&A traceability`) → arranca desde cero leyendo el plan (`PPP-plan-*.md`).
3. **Ya refinado / re-refine on demand** (sin CHECKPOINT abierto, pero el plan **ya tiene** las 2 secciones) → **operación de primera clase**, cuantas veces haga falta mientras el flujo siga en PLAN:
   - `create_or_resume` detecta la refine session existente (típicamente **cerrada** tras converger) por descriptor + `## Origin` y la **reabre**: `aw session-resume --code <NNN> --reopen` (detección: `aw sessions --state all`).
   - Re-refinamiento incremental leyendo el **plan mismo**; al `Guardar`, edita in place con confirmación.

> **Continuidad inter-turno** (chasis, fila 2): un **comando de flujo** abre "nueva línea de trabajo" (sesión nueva) — **salvo re-correr el mismo flujo sobre la misma entrada** (mismo plan), que hace `create_or_resume` (reanuda/reabre en vez de duplicar).

## Sequence

```
plan-refine-loop(plan):
  input = glob(docs/plans/PPP-plan-*.md) | ruta del argumento   # siempre el plan mismo (in place)
  session = create_or_resume("<slug>-plan-refine")              # reabre si existe (ver Compact / resume)
  seed SESSION.Success criteria = checklist del coherence gate  # verification-first, ANTES
  work = read(plan) (+ el spec si hay que re-alinear; + avance del checkpoint si reanuda)
  repeat:                                                       # motor del chasis
    gaps = detect_gaps(work)  (taxonomy de plan-new + deriva plan↔spec)  menos los agotados
    if gaps == ∅: break
    batch ≤3 → sembrar CHECKPOINT.Pending/Next → resolver cada gap:
      research (acotado al delta — Delta 3) · humano (structured-choice) ·
      ui-design (Delta 4, solo pantallas nuevas/cambiadas)
    integrar + update CHECKPOINT                                # ciclo artifact-first
  coherence gate (read-only) = Success criteria en verde:
    - checklist de plan-new (criterio→tarea · Final behavior · XS–S/XS · deps · Impacted↔Solution · UI→SPEC vigente)
    - propio del re-refine: el plan quedó REALINEADO con lo que cambió
    lo que falle → vuelve como gap
  structured_choice(contenido: [Guardar plan refinado, Preguntar algo más], flow: [Compactar, Cerrar])
  Guardar → edit in place (con confirmación) + inserta/actualiza Refinement decisions + Q&A traceability
finalize: CHECKPOINT persiste (+ BACKLOG solo si difiere) + cerrar session + reportar
```

## Convergence / exit

- **Sin gaps materiales** → **coherence gate** (checklist del *Sequence*; el mismo gate de plan-new + la realineación propia del re-refine).
- Pasa → `Guardar plan refinado` (edita in place con confirmación) → `finalize`.
- `Cerrar` en cualquier momento → `finalize` (persiste `CHECKPOINT`; `BACKLOG` solo si difiere; cierra la session, reporta).
