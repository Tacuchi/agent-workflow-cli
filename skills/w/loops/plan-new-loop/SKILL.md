---
name: plan-new-loop
description: >-
  Genera un plan de implementación rico (docs/plans/PPP-plan-<slug>.md) a partir
  de un spec (docs/specs/NNN-spec-<slug>.md). Heir del chasis spec-refine-loop:
  reusa íntegro su motor gap-driven convergente, su única session por run,
  research INLINE, AskUserQuestion con ≤3 tabs de contenido + 1 tab flow
  (Compactar/Cerrar) siempre presente, research autónomo con regla BD read-only,
  y artefactos como log vivo (CHECKPOINT siempre, BACKLOG solo si difiere). Sus
  deltas: el plan absorbe inline el nivel TECHNICAL-NOTE
  (Solution/Impacted/AS-IS/TO-BE/Validations…) + Phases/Tasks con estado vivo;
  el research aquí mapea código/impacto (componentes FE/BE/BD, wiring AS-IS,
  dependencias); y una gap taxonomy propia de planificación. Distingue spec
  refinado de borrador por la presencia de Refinement decisions/Q&A traceability
  (si faltan → soft-suggest correr spec-refine antes). Lo arranca el comando
  /w:plan-new y es reanudable. Invocar cuando un spec deba convertirse en un plan
  ejecutable antes de implementar.
---

# plan-new-loop

> **Heir** del chasis [`spec-refine-loop`](../spec-refine-loop/SKILL.md). Aquí **solo** los deltas. El motor (gap-driven, sesión única, AskUserQuestion + tab `flow`, research inline + regla BD, compact/resume, artefactos como log vivo) vive en el chasis — no se repite.

## Flow
PLANIFICATION

## Layer
2 — la IA lo corre entero.

## Started by
`/w:plan-new` — **reanudable** (mismo mecanismo del chasis, keyado off CHECKPOINT).

## Reads
`docs/specs/NNN-spec-*.md` (glob — localiza el spec por número; o la ruta exacta de `$ARGUMENTS`). **Refinado vs borrador** se distingue por la **presencia** de `## Refinement decisions` / `## Q&A traceability` en el spec: si faltan → **soft-suggest** correr `/w:spec-refine` primero (planificar sobre un spec sólido produce mejores planes), pero el usuario puede proceder.

## Writes
`docs/plans/PPP-plan-<slug>.md` (`generate`; **sobrescribe con confirmación** si existe). Solo escribe `docs/plans` — nunca otras carpetas `docs/` ni auto-export.

> **slug**: kebab-case corto derivado del Requirement del spec — solo `[a-z0-9-]`, ≤ ~5 palabras / ≤ 40 chars. El CLI solo devuelve el número `PPP`; el loop arma el nombre completo. Para localizar planes, glob `docs/plans/PPP-plan-*.md`.

## Inherits

Del chasis [`spec-refine-loop`](../spec-refine-loop/SKILL.md), sin cambios:

- Motor **gap-driven convergente** (`detect_gaps` → resolver → integrar → repetir; gaps agotados con límite `MAX` no se re-disparan).
- **Una sola session por run**: descriptor `plan-new` → `NNN-plan-new` (Type = `refine`): `SESSION` + `CHECKPOINT` (+ `BACKLOG` solo si difiere). La **investigación es inline** dentro de esta session (produce `ANALYSIS-FILE`/`CONCLUSIONS` + `SCRIPTS.sql` read-only en su propia carpeta), no una session aparte.
- **AskUserQuestion**: ≤3 tabs de contenido + 1 tab `flow` (`Compactar`/`Cerrar`) siempre.
- **Ask-vs-research rule** + **research autónomo inline** + **regla BD** (pregunta MCP si >1 sin default → queries a `SCRIPTS.sql` → ejecuta read-only, `sql-mutation-guard`) + manejo de research **inconclusa** (degrada a humano / difiere a `Open questions` + límite `MAX`).
- **Compact / resume** y **artefactos como log vivo** (`CHECKPOINT` siempre; `BACKLOG` solo si difiere).
- **Naming + numeración global** del chasis: `<run>` = descriptor `plan-new`. El CLI antepone el `NNN` global y secuencial (sin reiniciar por tipo); el caller pasa solo el descriptor.

## Delta 1 — Deliverable: PLAN RICO (`PPP-plan-<slug>.md`)

El plan absorbe el nivel `TECHNICAL-NOTE` **inline** (decisión del usuario) + roadmap:

```markdown
# Plan PPP — <slug>

> Derivado de docs/specs/NNN-spec-<slug>.md · generado por plan-new-loop

## Origin              spec fuente (o prompt, si se bootstrapeó vía spec-new)
## Summary             el cómo, en 1–2 frases
## Solution            explicación técnica/funcional de cómo se implementará
## Impacted            FE · BE · BD (esquemas/tablas/funciones) · APIs · integraciones
## Dependencies        docs / fuentes / bases / sesiones
## Current state (AS-IS)   wiring actual (interfaces y métodos), resumido
## Target state (TO-BE)    wiring objetivo
## Final behavior      cómo se comporta el flujo al final (alineado con criterios del spec)
## Phases              fases agrupadoras (complejidad XS–S)
## Tasks               tareas por fase (≤XS), con deps y estado vivo (- [ ])
## Validations         validaciones / restricciones / lógica de negocio
## Risks / impact      riesgos e impactos técnicos
## Assumptions         supuestos
## Estimated time      sizing XS–XL (desarrollo + pruebas internas)
## Open questions      pendientes
```

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
| Riesgos sin atender | — | humano |

## Delta 3 — What research investigates here

El research **inline** del chasis se especializa: mapear **código/impacto** — componentes FE/BE/BD afectados, wiring AS-IS, dependencias. Alimenta las secciones `Solution`, `Impacted`, `Current state (AS-IS)`. La regla BD del chasis aplica igual (queries read-only a `SCRIPTS.sql`, MCP elegido vía tab de contenido si >1 sin default).

## Convergence / exit

Sin gaps materiales → `AskUserQuestion` (contenido: `Guardar plan` / `Preguntar algo más`; flow: `Compactar`/`Cerrar`) → al `Guardar`, escribe `docs/plans/PPP-plan-<slug>.md` (con confirmación si existe) → `finalize` (persiste `CHECKPOINT`, y `BACKLOG` solo si difiere; cierra la session, reporta). `Cerrar` en cualquier momento → `finalize` igual.
