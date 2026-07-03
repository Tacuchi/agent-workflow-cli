---
name: plan-exec-loop
description: >-
  Ejecuta un plan de implementación (docs/plans/PPP-plan-<slug>.md) como
  living doc: lo lee y actualiza fase a fase mientras edita el código real,
  gestiona BD y git. Heir del chasis (loops/CHASSIS.md + CODE-POLICIES.md).
  Deltas: session única reanudable, git seguro (rama verificada, commits
  propuestos por fuente, nunca push/--amend/--no-verify), BD solo-scripts
  (nunca ejecuta DML/DDL), validación por fase y final, gate de revisión de
  cierre pre-commit, sin auto-export. Compone git y sql. Lo arranca
  /w:plan-exec. Invocar para implementar un plan ya generado.
---

# plan-exec-loop

> **Heir** del chasis común — aquí los **deltas de ejecución**: el trabajo real (código, BD, git). El motor vive en el chasis y las *Políticas de loops que editan código* en `CODE-POLICIES.md` — no se repiten.

## Flow
PLAN

## Layer
2 — la IA lo corre entero.

## Started by
`/w:plan-exec` — **reanudable** (mismo mecanismo del chasis; aquí el resume keya off el checkbox del plan-doc + CHECKPOINT, ver Delta 1).

## Reads
`docs/plans/PPP-plan-<slug>.md` (localizar vía glob `docs/plans/PPP-plan-*.md` o la ruta exacta del argumento del comando). Corre **cualquier** plan, haya pasado o no por [`plan-refine-loop`](../plan-refine-loop/SKILL.md) — plan-refine es auxiliar y no obligatorio; no hay gate que lo exija. Si el plan incluye UI, también los **design SPECs** (`NNN-SPEC-<SLUG>.md`) que sus Tasks referencian — artefactos de la sesión de plan-new/plan-refine, leídos **read-only** como referencia de diseño al implementar (ver [`SPEC.md`](../../artifacts/artifacts-design/SPEC.md)).

## Writes
- `docs/plans/PPP-plan-<slug>.md` (**read/update**, living doc: estado de fases/tareas, `Open questions`).
- Artefactos de la plan-exec session en `.workflow/sessions/` (`SCRIPTS.sql`, `DECISION`, `ANALYSIS-FILE`/`CONCLUSIONS`, …).
- **NO** escribe en otras carpetas `docs/` ni **gradúa/exporta** otros artefactos automáticamente (ver *Boundary*).

## Boundary — sin auto-export (hard rule)

Regla completa en el chasis (§ *docs/ boundary — sin auto-export*). Acá: la única carpeta `docs/` que este loop escribe es **`docs/plans`** (el plan, living); todo lo demás queda en la session hasta un `export-*` explícito y posterior.

## Inherits

Leé **[`../CHASSIS.md`](../CHASSIS.md)** — el **motor completo** del loop — **y** **[`../CODE-POLICIES.md`](../CODE-POLICIES.md)** — las *Políticas de loops que editan código* — **siempre antes** de estos deltas. *(Si `../` no resuelve: mismos nombres junto a este archivo — regla global de layout, chasis § Resolución de referencias.)*

## Composes

`git` (rama segura + commits propuestos) · `sql` (regla BD). Ambas resueltas por `.workflow/skills.toml`; `off` → el loop sigue sin la capacidad y, si era necesaria, lo dice o pregunta.

> **Convenciones ambientes (no roles):** estándares de código/testing/redacción y `creating-tools` son skills standalone que el host auto-descubre por su `description` — el workflow no las bindea ni depende de ellas. Doctrina completa: [../../roles/README.md](../../roles/README.md).

## Internal sessions (managed)

- **plan-exec session** descriptor `<slug>-plan-exec` → `NNN-<slug>-plan-exec` (el `<slug>` sale del plan-doc de entrada `docs/plans/PPP-plan-<slug>.md`): **una sola session por run** (Type = `exec`). Dueña del run; posee `SESSION` + `CHECKPOINT` + `DECISION` + `SCRIPTS.sql` (+ `BACKLOG` solo si difiere). La investigación es **inline** dentro de esta session: produce `ANALYSIS-FILE`/`CONCLUSIONS` (+ `SCRIPTS.sql` read-only si consulta BD) en su propia carpeta.

> **Numeración**: el caller pasa solo el descriptor; el CLI antepone el `NNN` global y secuencial sobre `.workflow/sessions/` (ver chasis). No reinicia por tipo.

> **Compat (legacy):** workspaces viejos pueden tener sessions `plan-exec-phase-*` (una por fase) y `*-research-*` — son históricas y se dejan tal cual; los runs nuevos usan una sola session.

## Delta 1 — One session per run; per-phase progress in the plan-doc

- Recorre las `Phases` del plan en orden (respeta deps) **dentro de la única session del run** (no hay session-por-fase).
- El **avance por fase vive en el plan-doc** (`- [x]`) y en el `CHECKPOINT` único (Completed/Pending/Next): **artifact-first** — `CHECKPOINT.Next` se fija a la fase inminente **antes** de iniciarla; el checkbox `- [x]` del plan-doc se voltea **después** de completar la tarea.
- Ejecuta las `Tasks` de la fase; **salta** las ya marcadas `- [x]` en el plan (el plan-doc es la fuente de verdad por tarea). Marca `- [x]` + estado **en el plan** (living doc; no en un `TASKS` aparte).
- En **cada límite de fase**: valida, corre el **gate de revisión de cierre** (Delta 5), actualiza el `CHECKPOINT` (Completed += Phase N, Next = Phase N+1) y propone commits.
- Registra `DECISION` solo lo **no obvio**, **a medida que se toma** (los `DECISION` por fase se acumulan en el ÚNICO `DECISION`, etiquetados por fase/tarea — ej. `Origin: T2 (F1)`).
- El motor **gap-driven** del chasis aplica acá **dentro de una tarea**: ante una decisión/duda no obvia → research inline ó structured-choice.

## Delta 2 — Git policy: **rama segura + commits propuestos**

Política completa en [`../CODE-POLICIES.md`](../CODE-POLICIES.md) (§ *Git seguro*: branch-check antes de editar, commit rechazado — los cambios quedan + se registra —, precondición de working tree entre fases). **Inline:** antes de editar, verificar rama esperada por fuente (`aw check-branch --source <alias>`; si no coincide → pausar y resolver con el humano); al cerrar cada fase y **tras el gate de revisión** (Delta 5), **commits propuestos por fuente** (aprobar antes) — nunca `push`/`--amend`/`--no-verify`.

## Delta 3 — DB policy: **la IA nunca ejecuta DML**

Política completa en [`../CODE-POLICIES.md`](../CODE-POLICIES.md) (§ *BD solo-scripts*). **Inline:** consultas read-only → `SCRIPTS.sql` de la session y se ejecutan vía MCP (`sql-mutation-guard`); migraciones DDL/DML → la IA las **redacta en `SCRIPTS.sql` pero NUNCA las ejecuta** — su promoción a `docs/scripts/` la hace un `export-*` aparte, no este loop.

## Delta 4 — Validation

- Tras ejecutar (por fase y al final): corre tests/checks contra `Validations` + `Final behavior` + acceptance/success criteria del spec.
- Validación que **corre y falla** → vuelve a la tarea (gap); no avanza.
- **Validación dependiente de una migración no aplicada**: como la IA no ejecuta el DML, **no puede correr read-only** → se **difiere** (handoff a DBA), **no bloquea el avance**. Se registra en `Open questions` del plan + `BACKLOG`, marcando "verificación pendiente tras aplicar SQL". (Reusa el patrón degradar/diferir + límite `MAX` del chasis → evita el bucle "vuelve a la tarea".)

> La **validación final** es el **convergence gate** de PLAN-exec = **`Success criteria` en verde** (*verification-first*; análogo al *analyze gate* de SPEC y al *coherence gate* de `plan-new`): el plan no se marca *done* hasta que pasa o queda explícitamente diferida (handoff de SQL). Para código son **tests ejecutables** (TDD); para migraciones BD no ejecutables, **rúbrica** (SCRIPTS.sql válido + revisado).

## Delta 5 — Gate de revisión de cierre (convenciones, pre-commit)

Gate completo en [`../CODE-POLICIES.md`](../CODE-POLICIES.md) (§ *Gate de revisión de cierre*): re-lectura **independiente** del diff + convenciones ambientes instaladas; hallazgos → corregir (re-validando la fase) o diferir justificado. Acá solo el cableado exec: corre **entre la validación de la fase (Delta 4) y sus commits (Delta 2)**; recién con el gate en verde se proponen los commits de la fase.

## Delta 6 — Completitud / cierre

- Una fase cierra **done** cuando sus tareas están `- [x]` y su validación pasó **o** quedó diferida (handoff de SQL). Estado posible: **"done — SQL pendiente de aplicar"**.
- Todas las fases done → *structured-choice* final (contenido: `Marcar plan done` / `Preguntar algo más`; flow: `Compactar`/`Cerrar`).
- **Sin export automático**: los artefactos (`SCRIPTS.sql`, `DECISION`, …) quedan en la session. Promoverlos a `docs/` (scripts, manuals, …) es un paso aparte vía `export-*`.

## Sequence

```
plan-exec-loop(PPP-plan-<slug>.md):
  session = create_or_resume("<slug>-plan-exec")           # <slug> del plan-doc; UNA sola session por run; CLI antepone NNN global; CHECKPOINT, resume
  plan = read(PPP-plan-<slug>.md)
  para cada Phase en plan (en orden, respeta deps):
    si Phase done (todas sus Tasks - [x] en el plan): skip # resume vía checkbox del plan-doc
    seed CHECKPOINT.Next = Phase N (Pending = sus Tasks)   # ANTES de iniciar la fase: sembrar intención (artifact-first)
    para cada Task de la Phase:
      si Task - [x] en el plan: skip                       # resume intra-fase por checkbox
      verificar rama esperada por fuente (branch-check)
        si no coincide → pausar + resolver con humano
      ejecutar Task:
        editar código en las fuentes (cambio mínimo)
        si crea herramienta/utilidad → la skill ambiente creating-tools la documenta en docs/tools
        si consulta BD read-only → SCRIPTS.sql + ejecutar read-only
        si cambio BD (DDL/DML) → redactar en SCRIPTS.sql (artefacto session, NO ejecutar)
        si decisión no obvia → DECISION (etiquetado por fase/tarea, en el ÚNICO DECISION)
        si duda/gap → research inline ó structured-choice    # chasis
      marcar Task - [x] + estado EN EL PLAN                # DESPUÉS de completar la Task (el plan-doc es la fuente de verdad por tarea)
    validación de la fase:
        la que corre y falla → volver a la tarea
        la dependiente de migración no aplicada → diferir (Open questions + BACKLOG)
    gate de revisión de cierre (pre-commit):               # Delta 5: CHECKPOINT.Next = "review fase N"
        re-lectura INDEPENDIENTE del diff de la fase + convenciones ambientes instaladas
        hallazgos → corregir (y re-validar la fase) ó diferir justificado (Open questions + BACKLOG)
    update CHECKPOINT (Completed += Phase N, Next = Phase N+1) # DESPUÉS: Pending→Completed + Next = fase siguiente (ver ciclo artifact-first)
    proponer commit(s) por fuente (aprobar antes)          # nunca push/amend/--no-verify; solo tras el gate en verde
        si rechazado → cambios quedan; registrar "fase sin commitear"
    precondición siguiente fase: working tree limpio o reconocido
  validación final (lo que se pueda; lo dependiente de SQL queda como handoff)
  structured_choice(contenido: [Marcar plan done, Preguntar algo más], flow: [Compactar, Cerrar])
  marcar plan done (o "done — SQL pendiente de aplicar")
  # NO export: los artefactos quedan en la session; un export-* los promueve aparte
finalize: CHECKPOINT (+ BACKLOG si difiere) + cerrar session + reportar
```

## Convergence / exit

- Plan completo + validación OK (o diferida con handoff) + **cada fase pasó su gate de revisión de cierre** antes de commitear → `Marcar plan done`.
- `Cerrar` (control `flow`, en cualquier momento) → `finalize` persiste `CHECKPOINT` (y `BACKLOG` solo si quedó algo sin ejecutar / sin commitear / sin aplicar), cierra la session, reporta.
- La promoción de artefactos a `docs/` (vía `export-*`) es **siempre** un paso posterior y explícito, fuera de este loop.
