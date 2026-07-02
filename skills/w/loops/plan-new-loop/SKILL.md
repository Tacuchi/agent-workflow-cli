---
name: plan-new-loop
description: >-
  Genera un plan de implementación rico (docs/plans/PPP-plan-<slug>.md) a
  partir de un spec (docs/specs/NNN-spec-<slug>.md). Heir del chasis spec-
  refine-loop (motor gap-driven convergente, session única, research inline,
  structured-choice, artefactos como log vivo); sus deltas viven en el cuerpo:
  el plan absorbe el nivel TECHNICAL-NOTE + Phases/Tasks con estado vivo,
  research de mapeo código/impacto, gap taxonomy de planificación, y si el
  plan incluye UI compone ui-design para autorar design SPECs por pantalla
  (NNN-SPEC-<SLUG>.md). Si el spec no está refinado sugiere spec-refine antes.
  Lo arranca /w:plan-new y es reanudable. Invocar cuando un spec deba
  convertirse en un plan ejecutable antes de implementar.
---

# plan-new-loop

> **Heir** del chasis [`spec-refine-loop`](../spec-refine-loop/SKILL.md). Aquí **solo** los deltas. El motor (gap-driven, sesión única, structured-choice + control `flow`, research inline + regla BD, compact/resume, artefactos como log vivo) vive en el chasis — no se repite.

## Flow
PLAN

## Layer
2 — la IA lo corre entero.

## Started by
`/w:plan-new` — **reanudable** (mismo mecanismo del chasis, keyado off CHECKPOINT).

## Reads
`docs/specs/NNN-spec-*.md` (glob — localiza el spec por número; o la ruta exacta del argumento del comando). **Refinado vs borrador** se distingue por la **presencia** de `## Refinement decisions` / `## Q&A traceability` en el spec: si faltan → **soft-suggest** correr `/w:spec-refine` primero (planificar sobre un spec sólido produce mejores planes), pero el usuario puede proceder.

## Writes
`docs/plans/PPP-plan-<slug>.md` (`generate`; **sobrescribe con confirmación** si existe). Solo escribe `docs/plans` — nunca otras carpetas `docs/` ni auto-export. Si el plan **incluye UI**, además produce **design SPECs** (`NNN-SPEC-<SLUG>.md`) como artefactos **de su sesión** (ver *Delta 4* — no son `docs/`, no hay auto-export).

> **slug**: kebab-case corto derivado del Requirement del spec — solo `[a-z0-9-]`, ≤ ~5 palabras / ≤ 40 chars. El CLI solo devuelve el número `PPP`; el loop arma el nombre completo. Para localizar planes, glob `docs/plans/PPP-plan-*.md`.

## Inherits

Del chasis [`spec-refine-loop`](../spec-refine-loop/SKILL.md), sin cambios:

- **Objetivo persistente + verification-first** del chasis: persigue su `SESSION.Objective` hasta que sus `SESSION.Success criteria` están **en verde** (sembrados al inicio; acá la rúbrica = **coherencia del plan**: cada Task traza a un acceptance criterion del spec). El motor es **gap-driven convergente** + **ciclo artifact-first** (sembrar `CHECKPOINT.Pending/Next` ANTES → `detect_gaps` → resolver → integrar → actualizar `Pending→Completed` DESPUÉS; gaps agotados con límite `MAX` no se re-disparan).
- **Una sola session por run**: descriptor `<slug>-plan-new` → `NNN-<slug>-plan-new` (Type = `refine`): `SESSION` + `CHECKPOINT` (+ `BACKLOG` solo si difiere). La **investigación es inline** dentro de esta session (produce `ANALYSIS-FILE`/`CONCLUSIONS` + `SCRIPTS.sql` read-only en su propia carpeta), no una session aparte.
- **Structured-choice**: ≤3 preguntas de contenido + 1 control `flow` (`Compactar`/`Cerrar`) siempre (capacidad del arnés — ver [`../../harness/SKILL.md`](../../harness/SKILL.md); en Claude Code es `AskUserQuestion`).
- **Ask-vs-research rule** + **research autónomo inline** + **regla BD** (pregunta MCP si >1 sin default → queries a `SCRIPTS.sql` → ejecuta read-only, `sql-mutation-guard`) + manejo de research **inconclusa** (degrada a humano / difiere a `Open questions` + límite `MAX`).
- **Compact / resume** y **artefactos como log vivo (ciclo artifact-first)** (`CHECKPOINT` siempre; `BACKLOG` solo si difiere).
- **Naming + numeración global** del chasis: `<run>` = descriptor `<slug>-plan-new`, donde `<slug>` sale del spec de entrada (`docs/specs/NNN-spec-<slug>.md`) → folder autodescriptivo `NNN-<slug>-plan-new`. El CLI antepone el `NNN` global y secuencial (sin reiniciar por tipo); el caller pasa solo el descriptor.

## Delta 1 — Deliverable: PLAN RICO (`PPP-plan-<slug>.md`)

El plan absorbe el nivel `TECHNICAL-NOTE` **inline** (decisión del usuario) + roadmap:

```markdown
# Plan PPP — <slug>

> Derivado de docs/specs/NNN-spec-<slug>.md · generado por plan-new-loop

## Origin              spec fuente (o prompt, si se bootstrapeó vía spec-new)
## Summary             el cómo, en 1–2 frases                                   (core)
## Solution            explicación técnica/funcional de cómo se implementará    (core)
## Impacted            FE · BE · BD (esquemas/tablas/funciones) · APIs · integr. (core)
## Dependencies        docs / fuentes / bases / sesiones                        (opt.)
## Current state (AS-IS)   wiring actual (interfaces y métodos), resumido        (opt.)
## Target state (TO-BE)    wiring objetivo                                       (opt.)
## Final behavior      cómo se comporta el flujo al final (alineado con criterios del spec) (core)
## Phases              fases agrupadoras (complejidad XS–S)                      (core)
## Tasks               tareas por fase (≤XS), con deps y estado vivo (- [ ])     (core)
## Validations         validaciones / restricciones / lógica de negocio         (core)
## Risks / impact      riesgos e impactos técnicos                              (opt.)
## Assumptions         supuestos                                                (opt.)
## Estimated time      sizing XS–XL (desarrollo + pruebas internas)             (opt.)
## Open questions      pendientes                                               (core)
```

> **Escala con complejidad:** las `(core)` van **siempre**; las `(opt.)` solo si el plan lo amerita — un plan chico puede omitir `Dependencies`, AS-IS/TO-BE, `Risks`, `Assumptions`, `Estimated time`. Conciso > exhaustivo.

> **Implicación de catálogo:** `TECHNICAL-NOTE` deja de ser artefacto de session y se vuelve **secciones del plan-doc**. Reconciliado en [`plan-exec-loop`](../plan-exec-loop/SKILL.md): la única plan-exec session **no** lleva `TECHNICAL-NOTE` ni `TASKS` propios; el detalle técnico y el progreso viven inline en el plan-doc (living).

## Delta 2 — Gap taxonomy (de "plan")

Reemplaza la gap taxonomy de spec por una orientada a planificación:

| Gap | Signal | Resolved by |
|---|---|---|
| Approach/Solution sin definir | el cómo es vago | research / humano |
| Componentes sin identificar | impacto FE/BE/BD desconocido | **research** (mapea el código) |
| Wiring AS-IS desconocido | no se sabe el estado actual | **research** |
| Fase muy grande | complejidad > S | humano (re-partir) |
| Tarea no atómica | complejidad > XS | la IA re-parte |
| Deps faltantes | orden no claro | research / humano |
| Criterios del spec sin cubrir | tareas no trazan a acceptance criteria | la IA deriva + humano confirma |
| Riesgos sin atender | riesgos técnicos sin mitigar/declarar | humano |
| UI sin design SPEC *(si aplica)* | el plan incluye UI (FE/pantallas en `Impacted`, `## UI spec` en el spec, o tareas UI) sin `NNN-SPEC-*.md` en la sesión | **capacidad `ui-design`** |

## Delta 3 — What research investigates here

El research **inline** del chasis se especializa: mapear **código/impacto** — componentes FE/BE/BD afectados, wiring AS-IS, dependencias. Alimenta las secciones `Solution`, `Impacted`, `Current state (AS-IS)`. La regla BD del chasis aplica igual (queries read-only a `SCRIPTS.sql`, MCP elegido vía pregunta de contenido si >1 sin default).

## Delta 4 — Design SPECs (si el plan incluye UI)

El gap **UI sin design SPEC** se resuelve **componiendo** la capacidad **`ui-design`** (default built-in [`ui-spec`](../../roles/ui-spec/SKILL.md); rebindeable vía `.workflow/skills.toml`; `off` → degrada a humano / `Open questions`): autora **un design SPEC por pantalla** como artefacto de la sesión — `NNN-SPEC-<SLUG>.md` (`001-SPEC-MODAL-EXPORT.md`, `002-SPEC-ADMIN-DASHBOARD.md`; numeración local a la sesión, ver [`SPEC.md`](../../artifacts/artifacts-design/SPEC.md)). **Deriva** de la sección `## UI spec` del spec si existe (la parte por pantalla y la eleva a detalle ejecutable); si no, autora desde el `Requirement` (design-system/tema/ambigüedades vía *structured-choice*, cuenta en el batch). Las **Tasks UI del plan referencian** la ruta de su SPEC — esa referencia es la fuente de verdad — y `plan-exec-loop` los lee como referencia de diseño. Es el mismo tercer modo de resolución de gap del chasis (junto a *research* y *humano*).

## Convergence / exit

Sin gaps materiales → **coherence gate** (read-only) = **`Success criteria` en verde** (*verification-first*; es el "convergence gate" del chasis para PLAN-new): cada `acceptance criterion` del spec **traza** a una fase/tarea, `Final behavior` los cubre, fases XS–S / tareas XS, `deps` sin ciclos, `Impacted` consistente con `Solution`; y si el plan incluye UI: cada pantalla/tarea UI **traza a su design SPEC** (`NNN-SPEC-*.md`) y los SPECs no contradicen el `## UI spec` del spec (si existe). Lo que falle **vuelve como gap** — la trazabilidad criterio→tarea es una **invariante chequeada**, no una sección aparte. Si pasa → *structured-choice* (contenido: `Guardar plan` / `Preguntar algo más`; flow: `Compactar`/`Cerrar`) → al `Guardar`, escribe `docs/plans/PPP-plan-<slug>.md` (con confirmación si existe) → `finalize` (persiste `CHECKPOINT`, y `BACKLOG` solo si difiere; cierra la session, reporta). `Cerrar` en cualquier momento → `finalize` igual.

> **Después de generar:** el plan puede ir directo a `plan-exec`, o —si surgen cambios antes de ejecutar (nuevos requerimientos, ajustes de alcance)— pasar por [`plan-refine-loop`](../plan-refine-loop/SKILL.md) (`/w:plan-refine`, auxiliar y **no obligatorio**), que lo refina in place.
