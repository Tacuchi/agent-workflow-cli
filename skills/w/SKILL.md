---
name: workflow
description: >-
  Orientation skill for the whole agent-workflow harness — built-in default for the
  `overview` role. Load this to understand the model end-to-end: the 3-layer
  architecture (commands → loops → sessions/artifacts) plus the docs/ zone, the 3
  flows (SPEC / PLAN / QUICK), the `/w:` commands, the 4 loops and their chassis, the
  `export-*` family, the composable capability skills + `.workflow/skills.toml`
  binding cascade, and the 6 hard invariants. Use whenever an agent (or human) needs
  to know how the pieces fit, where a deliverable should land, or which command/loop/
  skill to reach for.
---

# workflow — agent-workflow overview

## Role

`overview` — built-in default. The orientation skill for the whole bundle. Rebindable in `.workflow/skills.toml`, but rarely is.

## Purpose

Explicar el **modelo completo** de agent-workflow para que un agente sepa: qué invoca el usuario, qué corre la IA, dónde aterriza cada entregable, y qué reglas no se rompen. Es el mapa; el detalle fino vive en cada loop/command/export/role.

## Composed by

Cualquiera que necesite orientación — un loop al arrancar, un agente nuevo en el workspace, o el usuario preguntando "¿cómo funciona esto?".

## Knowledge

### Workspace (sin modos)

Un solo concepto: **workspace**. No hay project/hub. La carpeta donde arranca el agente se vuelve workspace con `/w:workspace-init` (scaffolding `.workflow/` + `docs/` + bloque `WORKSPACE` en CLAUDE.md + `.workflow/skills.toml`). Tiene 1+ fuentes (repos); "standalone" = una sola fuente.

### The 3-layer architecture + `docs/` zone

```
USUARIO invoca
  LAYER 1 · COMMANDS (lo único que el usuario invoca)
    FLOWS:   spec-new · spec-refine · plan-new · plan-exec · quick
    EXPORTS: export-scripts · export-manuals · export-diagrams · export-reports
        │ arranca / delega
        ▼
  LAYER 2 · LOOPS (los corre la IA, gap-driven)
    spec-refine-loop (CHASIS) · plan-new-loop · plan-exec-loop · quick-loop
        │ crea / lee / escribe
        ▼
  LAYER 3 · SESSIONS + ARTIFACTS (.workflow/sessions/ — efímero, interno)
        │ los export-* leen artefactos
        ▼
  ZONA docs/ — documentos permanentes, cara al usuario
    specs · plans · tools (flujos) · scripts · manuals · diagrams · reports (export-*)
```

- **Layer 1** — alto nivel. Single-pass o arranca un loop. Sin lógica de iteración.
- **Layer 2** — la IA itera entera hasta converger. Sin invocación humana directa.
- **Layer 3** — efímero, interno, process-only. Nadie lo invoca a mano.

### The 3 flows

| Flow | Commands | docs/ propio | Loops |
|---|---|---|---|
| **SPEC** (el *qué*) | `spec-new` *(single-pass)* · `spec-refine` | `docs/specs` | `spec-refine-loop` |
| **PLAN** (el *cómo* + ejecutar) | `plan-new` · `plan-exec` | `docs/plans` · `docs/tools` | `plan-new-loop` · `plan-exec-loop` |
| **QUICK** (atajo liviano) | `quick` | — | `quick-loop` |

Cadena típica: prompt → `spec-new` genera `docs/specs/NNN-spec-<slug>.md` → `spec-refine` corre el loop y refina **ese mismo spec in place** → `plan-new` → `docs/plans/PPP-plan-<slug>.md` → `plan-exec` ejecuta y actualiza el plan (living doc) + artefactos en sesiones. La promoción del resto a `docs/` es **siempre** un paso aparte vía `export-*`.

### Contexto operativo — dónde aterriza cada cosa

Antes de cualquier loop, la IA resuelve su **contexto operativo** en **cada prompt** con dos detecciones: **¿workspace?** (existe `.<ns>/sessions/`) + **¿sesión a continuar?** (una activa, o una reciente que este prompt continúa). Eso decide el comportamiento y **dónde aterrizan los artefactos** (SQL, scripts, decisiones, …):

| ¿Workspace? | Trigger | → Comportamiento + ruteo |
|---|---|---|
| **Sí** | **comando de flujo** (`quick`·`spec-*`·`plan-*`) | crea sesión **nueva**, arranca el loop → artefactos a **esa** sesión (`SCRIPTS.sql`, …) |
| **Sí** | **prompt sin comando** (relacionado) | **continúa/reabre la sesión más reciente** → los scripts editan **su** `SCRIPTS.sql` (no crea otra) |
| **Sí** | **prompt sin comando** (no-relacionado / sin sesión) | **sin flujo**: trabajo directo → escribe en `docs/` por convención + numeración (`aw next-number`) |
| **No** | cualquiera | **vanilla** — sin workspace ni flujo, la IA es libre (nativo) |

**Regla de continuidad:** el **comando** señala "nueva línea de trabajo" (sesión nueva); un **prompt sin comando** es "sigo en la misma" → por default continúa/reabre la más reciente (la *última iniciada*); solo si es claramente no-relacionado ofrece elegir (`continuar NNN` | `trabajo nuevo`) o cae a "sin flujo". Convergencia cierra la sesión; un prompt relacionado posterior la **reabre** (el resume quita `.closed`). Es la cara **inter-turno** del *objetivo persistente* (mismo `CHECKPOINT`+resume, aplicado al próximo prompt) — **doctrina agnóstica**, no un hook del host. Aplica a **todo artefacto** (`SCRIPTS.sql` es el ejemplo trabajado); ver `loops/quick-loop/SKILL.md` para el caso QUICK.

### The commands (`/w:` namespace)

- `/w:workspace-init` — inicializa el workspace.
- `/w:spec-new` — genera un spec inicial (single-pass, sin loop).
- `/w:spec-refine` — arranca `spec-refine-loop` para refinar el spec.
- `/w:plan-new` — arranca `plan-new-loop` para derivar un plan ejecutable del spec refinado.
- `/w:plan-exec` — arranca `plan-exec-loop` para ejecutar y mantener el plan.
- `/w:quick` — arranca `quick-loop` (atajo, sin `docs/`).
- `/w:export-scripts` · `/w:export-manuals` · `/w:export-diagrams` · `/w:export-reports` — promueven artefactos a `docs/`.

### Transversal skills (no flow) — `/w:status` · `/w:fix-git`

Skills **invocables independientes de flujo**: se disparan con `/w:` igual que un comando, pero **no** pertenecen a SPEC/PLAN/QUICK, **no** manejan `docs/`, y **no** entran en el conteo **5 comandos de flow / 4 loops**. (En el diseño son su propia categoría —`workflow-skills/`, aparte de los comandos de flow—; en el bundle se empaquetan bajo `commands/` para que `/w:` las invoque.)

- `/w:status` — dashboard read-only del workspace (Hecho/Falta/Descartó, con fechas en español). No escribe nada; se apoya en `aw status`.
- `/w:fix-git` — resuelve conflictos de un merge en curso en cualquier repo (identifica origen↔destino, analiza intención, *structured-choice* ante ambigüedad). No crea session, no toca `docs/`; git-safe; se apoya en `aw merge-state`.

### The loops (Layer 2)

Un loop es una skill que enseña a la IA **cómo iterar** hasta un entregable. Propiedades comunes (el chasis, en `spec-refine-loop`, lo heredan los demás):

1. **Objetivo persistente + verification-first** — el loop persigue su `SESSION.Objective` y solo finaliza cuando sus `SESSION.Success criteria` (sembrados al inicio, *verification-first* / TDD generalizado: tests para código, rúbrica falsable para análisis/diseño) están **en verde**. Modelado en el `/goal` de Claude Code pero **agnóstico** (no depende de ningún host) y con registro durable.
2. **Gap-driven convergente** — el *cómo*: cada ciclo detecta huecos → resuelve (pregunta al humano o investiga) → integra → repite hasta converger.
3. **Una sola session por run + research inline** — el loop crea **una** session (la dueña del run) y maneja sus artefactos en `.workflow/sessions/`. La **investigación es inline**: una actividad dentro de esa misma session (escribe `ANALYSIS-FILE`/`CONCLUSIONS` + `SCRIPTS.sql` read-only si consulta BD), no una session aparte. El usuario nunca crea sessions. Los artefactos son el **registro vivo** del run, **ciclo artifact-first** (sembrar `Pending`/`Next` antes de ejecutar, llevar a `Completed` después); la base guía es el spec/plan.
4. **Structured-choice con dos tipos de pregunta** — *structured-choice* (capacidad del arnés — ver `harness/SKILL.md`). En **Claude Code** es `AskUserQuestion` (máx 4 preguntas/llamada → **≤3 preguntas de contenido + 1 control `flow`**); en un arnés sin elección estructurada, degrada a **markdown numerado**.
   - **pregunta(s) de contenido** — la pregunta real del momento.
   - **control `flow`** — control de ciclo de vida, **siempre presente**: `Compactar` / `Cerrar`. Responder la pregunta de contenido sin tocar `flow` = seguir iterando.
5. **Escribe solo en su carpeta `docs/`** — y nunca exporta el resto (eso es de `export-*`).

`flow → Compactar` = checkpoint + la **compactación** del arnés (en Claude Code: `/compact`; ver `harness/SKILL.md`) y reanuda. `flow → Cerrar` = persiste `CHECKPOINT` (siempre) + `BACKLOG` (solo si difiere), cierra la session, termina.

Cada loop tiene un **convergence gate** read-only antes de ofrecer `Guardar`/`done`, que es operacionalmente **"todos los `SESSION.Success criteria` en verde"** (*verification-first*): chequea invariantes propios del entregable y lo que falle vuelve como gap (en `spec-refine-loop` es el *analyze gate*; en `plan-new-loop`, la coherencia del plan; en `plan-exec-loop`, la validación final; en `quick-loop`, una validación puntual proporcional). El detalle vive en cada loop.

`spec-new` no tiene loop (single-pass): **5 comandos / 4 loops**.

### The `export-*` family (única vía artefacto → `docs/`)

| Export | Lee | Produce |
|---|---|---|
| `export-scripts` | `SCRIPTS.sql` (migraciones) de N sesiones | `docs/scripts/` (forwards numerados + `00-ROLLBACK.sql`) |
| `export-manuals` | sesiones + decisiones + plan + código | `docs/manuals/` |
| `export-diagrams` | código de las fuentes + plan (AS-IS/TO-BE) | `docs/diagrams/` (C4 / mermaid) |
| `export-reports` | corpus de sesiones + plan + `docs/` | `docs/reports/` (informe ejecutivo/funcional) |

Comunes: Capa 1, explícitos (los invoca el usuario, nunca un loop) · single-pass, read-only sobre sesiones · cross-session (consolidan N sesiones + `docs/`) · sin loop ni sessions internas (opciones por args).

### Capability skills + `.workflow/skills.toml`

Un loop **no** compone una skill concreta; compone una **capacidad por su rol** (ej. `ui-design`). Qué skill cumple el rol lo decide la config, no el loop. Cambiar de implementación = una línea del config.

```toml
[skills]
ui-design        = "ui-spec"          # built-in default
sql              = "sql"
git              = "git"
coding-standards = "coding-standards"
writing          = "writing"
testing          = "off"              # capacidad desactivada
# ui-design      = "acme/figma-spec"  # ← skill de tercero (vía skills.sh)
```

**Cascada de resolución**: built-in default → `~/.workflow/skills.toml` (global, PC) → `.workflow/skills.toml` (workspace). El workspace pisa al global; el global al default. Rol sin binding → built-in default. `off` → desactivada (el loop sigue sin ella; si era necesaria, lo dice o pregunta).

Catálogo de roles y su default:

| Role | Default | Tier | Composed by |
|---|---|---|---|
| `ui-design` | `ui-spec` | must | `spec-refine-loop` (UI) |
| `sql` | `sql` | must | research · `plan-exec-loop` · `quick-loop` · `export-scripts` |
| `git` | `git` | must | `plan-exec-loop` · `quick-loop` |
| `coding-standards` | `coding-standards` | must | `plan-exec-loop` · `quick-loop` |
| `writing` | `writing` | must | todos los loops · `export-manuals`/`export-reports` |
| `research` | `research` | should | todos los loops (capacidad inline) |
| `testing` | `testing` | should | `plan-exec-loop` · `quick-loop` |
| `tools` | `tools` | should | `plan-exec-loop` |
| `diagrams` | `diagrams` | should | `export-diagrams` |
| `overview` | `workflow` | should | cualquiera (orientación) |

El **chasis del loop** NO se bindea: **es** el loop, no es enchufable.

### Harness (agnóstico al arnés)

La doctrina nombra **capacidades** abstractas, no tools concretos de un arnés. Un solo doc —`harness/SKILL.md`— liga cada capacidad al mecanismo de cada arnés (Claude Code, Codex, opencode, Gemini, genérico). Dos principios: **capacidad-no-tool** (los loops/comandos referencian la capacidad por nombre) y **progressive-enhancement** (usar el mecanismo más rico del arnés; degradar a un fallback universal cuando no exista).

Capacidades clave:

- **structured-choice** — preguntar al humano ≤3 preguntas de contenido + 1 control `flow`. Claude Code: `AskUserQuestion`. Fallback: markdown numerado.
- **compaction** — encoger el contexto sin perder el hilo. Claude Code: `/compact`. Fallback: `CHECKPOINT` + resume.
- **command-invocation** · **procedure-loading** · **subagent-dispatch** (opt.) · **persistent-context** · **external-data** (MCP) · **dry-run/preview**.

Las únicas `must` para el ciclo de un loop son **structured-choice** y **compaction**, y ambas degradan a texto → cualquier arnés con chat + archivos corre el modelo completo. Detalle, matriz de binding y distribución (`AGENTS.md` canónico + symlink `CLAUDE.md`): ver `harness/SKILL.md`.

### The 6 hard invariants

1. **Sin auto-export** — los loops nunca graduan/exportan a `docs/`. Solo `export-*` lo hace, explícito.
2. **Cada flujo toca solo sus carpetas `docs/`** — SPEC→`specs` · PLAN→`plans`+`tools` · QUICK→ninguna · resto→`export-*`.
3. **El spec y el plan son documentos** (`docs/`), no artefactos de sesión.
4. **BD solo-scripts** — la IA nunca ejecuta DML/DDL; las migraciones quedan en `SCRIPTS.sql` y las aplica el usuario. Solo lecturas read-only vía MCP.
5. **Git seguro** — rama esperada verificada antes de editar; commits propuestos por fuente; nunca `push`/`--amend`/`--no-verify`.
6. **Chasis de loops** — **objetivo persistente + verification-first** (persigue `SESSION.Objective` hasta que sus `SESSION.Success criteria` —sembrados al inicio, TDD generalizado— están en verde) · gap-driven convergente · una sola session por run (research inline) · **structured-choice** con ≤3 preguntas de contenido + 1 control `flow` (`Compactar`/`Cerrar`) siempre · compactación/resume · artefactos como log vivo **artifact-first** (sembrar `Pending`/`Next` antes, `Completed` después; `CHECKPOINT` siempre; `BACKLOG` solo si difiere).

> **Alcance de #1/#2:** gobiernan el plano **sesión → `docs/`** (solo `export-*` lo cruza). El *authoring directo sin flujo* (ver § *Contexto operativo*) es **otro plano**: sin sesión activa, `docs/` es la única superficie gestionada → la IA escribe ahí por convención + numeración. No es auto-export (no hay sesión de la cual graduar).

## Output

Ninguno. Es orientación pura: no escribe documentos ni artefactos.

## Source

Autorada del modelo de diseño (`docs/referencias/`): README de arquitectura (3 capas + 6 invariantes), `workflow-commands/`, `workflow-loops/`, `workflow-artifacts/`, `workflow-exports/`, `workflow-skills/`, `workflow-harness/`. Modelo actual, desplegado. (Compat: reemplaza la orientación del bundle legacy `session` + flows dev/design/analyze.)
