---
name: plan-new-loop
description: >-
  Genera un plan de implementación rico (docs/plans/PPP-plan.md) a partir de un
  spec refinado (docs/specs/NNN-spec-refined.md). Heir del chasis
  spec-refine-loop: reusa íntegro su motor gap-driven convergente, sus sessions
  internas (control + research on-demand), AskUserQuestion con ≤3 tabs de
  contenido + 1 tab flow (Compactar/Cerrar) siempre presente, research autónomo
  con regla BD read-only, y compact/resume con Cerrar que persiste CHECKPOINT +
  BACKLOG. Sus deltas: el plan absorbe inline el nivel TECHNICAL-NOTE
  (Solution/Impacted/AS-IS/TO-BE/Validations…) + Phases/Tasks con estado vivo;
  el research aquí mapea código/impacto (componentes FE/BE/BD, wiring AS-IS,
  dependencias); y una gap taxonomy propia de planificación. Lo arranca el
  comando /w:plan-new y es reanudable. Invocar cuando un spec ya refinado deba
  convertirse en un plan ejecutable antes de implementar.
---

# plan-new-loop

> **Heir** del chasis [`spec-refine-loop`](../spec-refine-loop/SKILL.md). Aquí **solo** los deltas. El motor (gap-driven, sessions, AskUserQuestion + tab `flow`, research autónomo + regla BD, compact/resume, `Cerrar` persiste) vive en el chasis — no se repite.

## Flow
PLANIFICATION

## Layer
2 — la IA lo corre entero.

## Started by
`/w:plan-new` — **reanudable** (mismo mecanismo de 4 casos que el chasis).

## Reads
`docs/specs/NNN-spec-refined.md`

## Writes
`docs/plans/PPP-plan.md` (`generate`; **sobrescribe con confirmación** si existe). Solo escribe `docs/plans` — nunca otras carpetas `docs/` ni auto-export.

## Inherits

Del chasis [`spec-refine-loop`](../spec-refine-loop/SKILL.md), sin cambios:

- Motor **gap-driven convergente** (`detect_gaps` → resolver → integrar → repetir; gaps agotados con límite `MAX` no se re-disparan).
- **Sessions internas**: `control` (descriptor `plan-new` → `NNN-plan-new`: `SESSION` + `CHECKPOINT`, + `BACKLOG` al cerrar; Type = `refine`/`control`) + `research` on-demand (run-and-close, puede cerrar inconclusa).
- **AskUserQuestion**: ≤3 tabs de contenido + 1 tab `flow` (`Compactar`/`Cerrar`) siempre.
- **Ask-vs-research rule** + **research autónomo** + **regla BD** (pregunta MCP si >1 sin default → queries a `SCRIPTS.sql` → ejecuta read-only, `sql-mutation-guard`) + manejo de research **inconclusa** (degrada a humano / difiere a `Open questions` + límite `MAX`).
- **Compact / resume** (4 casos) y **`Cerrar` persiste** `CHECKPOINT` + `BACKLOG`.
- **Naming + numeración global** del chasis: `<run>` = descriptor `plan-new`; hijas `--name plan-new-research-<gap>`. El CLI antepone el `NNN` global y secuencial (sin reiniciar por tipo); el caller pasa solo el descriptor.

## Delta 1 — Deliverable: PLAN RICO (`PPP-plan.md`)

El plan absorbe el nivel `TECHNICAL-NOTE` **inline** (decisión del usuario) + roadmap:

```markdown
# Plan PPP — <slug>

> Derivado de docs/specs/NNN-spec-refined.md · generado por plan-new-loop

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

> **Implicación de catálogo:** `TECHNICAL-NOTE` deja de ser artefacto de exec session y se vuelve **secciones del plan-doc**. Reconciliado en [`plan-exec-loop`](../plan-exec-loop/SKILL.md): la exec session por fase **no** lleva `TECHNICAL-NOTE` ni `TASKS` propios; el detalle técnico y el progreso viven inline en el plan-doc (living).

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

El research del chasis se especializa: mapear **código/impacto** — componentes FE/BE/BD afectados, wiring AS-IS, dependencias. Alimenta las secciones `Solution`, `Impacted`, `Current state (AS-IS)`. La regla BD del chasis aplica igual (queries read-only a `SCRIPTS.sql`, MCP elegido vía tab de contenido si >1 sin default).

## Convergence / exit

Sin gaps materiales → `AskUserQuestion` (contenido: `Guardar plan` / `Preguntar algo más`; flow: `Compactar`/`Cerrar`) → al `Guardar`, escribe `docs/plans/PPP-plan.md` (con confirmación si existe) → `finalize` (persiste `CHECKPOINT` + `BACKLOG`, cierra sessions, reporta). `Cerrar` en cualquier momento → `finalize` igual.
