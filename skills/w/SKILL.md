---
name: workflow
description: >-
  Orientation skill for the whole agent-workflow harness — built-in default for the
  `overview` role. Load this to understand the model end-to-end: the 3-layer
  architecture (commands → loops → sessions/artifacts) plus the docs/ zone, the 3
  flows (SPEC / PLAN / QUICK), the `/w:` commands, the 5 loops and their chassis, the
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
    FLOWS:   spec-new · spec-refine · plan-new · plan-refine · plan-exec · quick
    EXPORTS: export-scripts · export-manuals · export-diagrams · export-reports
        │ arranca / delega
        ▼
  LAYER 2 · LOOPS (los corre la IA, gap-driven; motor: loops/CHASSIS.md)
    spec-refine-loop · plan-new-loop · plan-refine-loop · plan-exec-loop · quick-loop
        │ crea / lee / escribe
        ▼
  LAYER 3 · SESSIONS + ARTIFACTS (.workflow/sessions/ — efímero, interno)
        │ los export-* leen artefactos
        ▼
  ZONA docs/ — documentos permanentes, cara al usuario
    specs · plans (flujos) · scripts · manuals · diagrams · reports (export-*) · tools (ambiente)
```

- **Layer 1** — alto nivel. Single-pass o arranca un loop. Sin lógica de iteración.
- **Layer 2** — la IA itera entera hasta converger. Sin invocación humana directa.
- **Layer 3** — efímero, interno, process-only. Nadie lo invoca a mano.

### The 3 flows

| Flow | Commands | docs/ propio | Loops |
|---|---|---|---|
| **SPEC** (el *qué*) | `spec-new` *(single-pass)* · `spec-refine` | `docs/specs` | `spec-refine-loop` |
| **PLAN** (el *cómo* + ejecutar) | `plan-new` · `plan-refine` *(aux, opcional)* · `plan-exec` | `docs/plans` | `plan-new-loop` · `plan-refine-loop` · `plan-exec-loop` |
| **QUICK** (atajo liviano) | `quick` | — | `quick-loop` |

Cadena típica: prompt → `spec-new` genera `docs/specs/NNN-spec-<slug>.md` → `spec-refine` corre el loop y refina **ese mismo spec in place** → `plan-new` → `docs/plans/PPP-plan-<slug>.md` → *(opcional)* `plan-refine` ajusta **ese mismo plan in place** si hay cambios antes de ejecutar → `plan-exec` ejecuta y actualiza el plan (living doc) + artefactos en sesiones. La promoción del resto a `docs/` es **siempre** un paso aparte vía `export-*`.

QUICK puede **escalar en vivo a SPEC** si el objetivo excede un quick (gate de tamaño a la entrada) o la tarea crece mid-loop: con consentimiento vía structured-choice, la línea de trabajo pasa al flujo SPEC (borrador por procedimiento `spec-new` + `spec-refine-loop` directo); a PLAN la escalación queda **diferida** (siembra + puntero). Ver `loops/quick-loop/SKILL.md` § *Delta QUICK*.

### Contexto operativo — dónde aterriza cada cosa

Antes de cualquier loop, la IA resuelve su **contexto operativo** en **cada prompt** con dos detecciones: **¿workspace?** (existe `.<ns>/sessions/`) + **¿sesión a continuar?** (una activa, o una reciente que este prompt continúa). Eso decide el comportamiento y **dónde aterrizan los artefactos** (SQL, scripts, decisiones, …):

| ¿Workspace? | Trigger | → Comportamiento + ruteo |
|---|---|---|
| **Sí** | **comando de flujo** (`quick`·`spec-*`·`plan-*`) | **nueva línea de trabajo** → crea sesión **nueva** (salvo re-run del mismo flujo sobre la misma entrada: `create_or_resume` reabre la existente), arranca el loop → artefactos a **esa** sesión (`SCRIPTS.sql`, …) |
| **Sí** | **prompt sin comando** (relacionado) | **continúa/reabre la sesión más reciente** → los scripts editan **su** `SCRIPTS.sql` (no crea otra) |
| **Sí** | **prompt sin comando** (no-relacionado / sin sesión) | **sin flujo**: trabajo directo → escribe en `docs/` por convención + numeración (`aw next-number`) |
| **No** | cualquiera | **vanilla** — sin workspace ni flujo, la IA es libre (nativo) |

**Regla de continuidad:** el **comando** señala "nueva línea de trabajo" (sesión nueva) — **salvo re-correr el mismo comando sobre la misma entrada** (ej. `/w:spec-refine` sobre el mismo spec), que **no** abre otra línea: `create_or_resume` localiza la sesión de ese flujo (por descriptor + `## Origin`) y la **reanuda o reabre** (quita `.closed`), sin duplicarla; un **prompt sin comando** es "sigo en la misma" → por default continúa/reabre la más reciente (la *última iniciada*); solo si es claramente no-relacionado ofrece elegir (`continuar NNN` | `trabajo nuevo`) o cae a "sin flujo". Convergencia cierra la sesión; un prompt relacionado posterior la **reabre** (el resume quita `.closed`). Es la cara **inter-turno** del *objetivo persistente* (mismo `CHECKPOINT`+resume, aplicado al próximo prompt) — **doctrina agnóstica**, no un hook del host. Aplica a **todo artefacto** (`SCRIPTS.sql` es el ejemplo trabajado); ver `loops/quick-loop/SKILL.md` para el caso QUICK. **Excepción consentida:** la **escalación aceptada** dentro de un loop (ej. quick → SPEC) también abre una **nueva línea de trabajo** sin comando — la señal es el **consentimiento explícito** del usuario en la structured-choice, equivalente a haber invocado el comando del flujo destino.

### The commands (`/w:` namespace)

- `/w:workspace-init` — inicializa el workspace.
- `/w:spec-new` — genera un spec inicial (single-pass, sin loop).
- `/w:spec-refine` — arranca `spec-refine-loop` para refinar el spec.
- `/w:plan-new` — arranca `plan-new-loop` para derivar un plan ejecutable del spec refinado.
- `/w:plan-refine` — arranca `plan-refine-loop` para refinar el plan in place (auxiliar, **no obligatorio**) antes de ejecutar.
- `/w:plan-exec` — arranca `plan-exec-loop` para ejecutar y mantener el plan.
- `/w:quick` — arranca `quick-loop` (atajo, sin `docs/`; escala en vivo a SPEC si el objetivo excede un quick).
- `/w:export-scripts` · `/w:export-manuals` · `/w:export-diagrams` · `/w:export-reports` — promueven artefactos a `docs/`.

### Transversal skills (no flow) — `/w:status` · `/w:fix-git`

Skills **invocables independientes de flujo**: se disparan con `/w:` igual que un comando, pero **no** pertenecen a SPEC/PLAN/QUICK, **no** manejan `docs/`, y **no** entran en el conteo **6 comandos de flow / 5 loops**. (En el diseño son su propia categoría —`workflow-skills/`, aparte de los comandos de flow—; en el bundle se empaquetan bajo `commands/` para que `/w:` las invoque.)

- `/w:status` — dashboard read-only del workspace (Hecho/Falta/Descartó, con fechas en español). No escribe nada; se apoya en `aw status`.
- `/w:fix-git` — resuelve conflictos de un merge en curso en cualquier repo (identifica origen↔destino, analiza intención, *structured-choice* ante ambigüedad). No crea session, no toca `docs/`; git-safe; se apoya en `aw merge-state`.

### The loops (Layer 2)

Un loop es una skill que enseña a la IA **cómo iterar** hasta un entregable: detecta huecos, los resuelve (humano vía structured-choice, research inline o una capacidad compuesta), integra y repite hasta converger. Los 5 loops corren el mismo **motor común** — objetivo persistente + verification-first, gap-driven convergente, session única por run, structured-choice + control `flow` (`Compactar`/`Cerrar`), compact/resume, artefactos como log vivo, convergence gate — cuyo canon vive en [`loops/CHASSIS.md`](loops/CHASSIS.md); cada loop es un **heir** que agrega solo sus deltas.

Los loops que **editan código** (`plan-exec-loop`, `quick-loop`) aplican además las *Políticas de loops que editan código*: git seguro, BD solo-scripts y el **gate de revisión de cierre** pre-commit (nada llega a un commit propuesto sin revisar) — ver [`loops/CODE-POLICIES.md`](loops/CODE-POLICIES.md) (doc hermano del chasis; los loops de documento no lo cargan).

`spec-new` no tiene loop (single-pass): **6 comandos / 5 loops**.

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
research         = "research"
# diagrams       = "off"              # ← capacidad desactivada
# ui-design      = "acme/figma-spec"  # ← skill de tercero (vía skills.sh)
```

**Cascada de resolución**: built-in default → `~/.workflow/skills.toml` (global, PC) → `.workflow/skills.toml` (workspace). El workspace pisa al global; el global al default. Rol sin binding → built-in default. `off` → desactivada (el loop sigue sin ella; si era necesaria, lo dice o pregunta).

Catálogo de roles y su default:

| Role | Default | Tier | Composed by |
|---|---|---|---|
| `ui-design` | `ui-spec` | must | `spec-refine-loop` (UI) · `plan-new-loop` / `plan-refine-loop` (design SPECs) |
| `sql` | `sql` | must | research · `plan-exec-loop` · `quick-loop` · `export-scripts` |
| `git` | `git` | must | `plan-exec-loop` · `quick-loop` |
| `research` | `research` | should | todos los loops (capacidad inline) |
| `diagrams` | `diagrams` | should | `export-diagrams` |
| `overview` | `workflow` | should | cualquiera (orientación) |

> **Convenciones ambientes (no roles):** estándares de código/testing/redacción y `creating-tools` son skills standalone que el host auto-descubre por su `description` — el workflow no las bindea ni depende de ellas. Doctrina completa: [roles/README.md](roles/README.md).

El **chasis del loop** NO se bindea: es el motor común de los 5 loops ([`loops/CHASSIS.md`](loops/CHASSIS.md), un doc referenciado), no una capacidad enchufable.

### Harness (agnóstico al arnés)

La doctrina nombra **capacidades** abstractas, no tools concretos de un arnés. Un solo doc —`harness/SKILL.md`— liga cada capacidad al mecanismo de cada arnés (Claude Code, Codex, Gemini/Antigravity, OpenCode, Crush, Warp, genérico). Dos principios: **capacidad-no-tool** (los loops/comandos referencian la capacidad por nombre) y **progressive-enhancement** (usar el mecanismo más rico del arnés; degradar a un fallback universal cuando no exista).

Capacidades clave:

- **structured-choice** — preguntar al humano ≤3 preguntas de contenido + 1 control `flow`. Claude Code: `AskUserQuestion`. Fallback: markdown numerado.
- **compaction** — encoger el contexto sin perder el hilo. Claude Code: `/compact`. Fallback: `CHECKPOINT` + resume.
- **command-invocation** · **procedure-loading** · **subagent-dispatch** (opt.) · **persistent-context** · **external-data** (MCP) · **dry-run/preview**.

Las únicas `must` para el ciclo de un loop son **structured-choice** y **compaction**, y ambas degradan a texto → cualquier arnés con chat + archivos corre el modelo completo. Detalle, matriz de binding y distribución (`AGENTS.md` canónico + symlink `CLAUDE.md`): ver `harness/SKILL.md`.

### The 6 hard invariants

1. **Sin auto-export** — los loops nunca graduan/exportan a `docs/`. Solo `export-*` lo hace, explícito.
2. **Cada flujo toca solo sus carpetas `docs/`** — SPEC→`specs` · PLAN→`plans` · QUICK→ninguna · resto→`export-*`. (`docs/tools` no es de un flujo: lo escribe la skill ambiente `creating-tools`.)
3. **El spec y el plan son documentos** (`docs/`), no artefactos de sesión. *(No confundir con los **design SPECs** `NNN-SPEC-<SLUG>.md`: artefactos de diseño de UI **por pantalla** que las sesiones de PLAN producen vía la capacidad `ui-design` cuando el plan incluye UI — ver `artifacts/artifacts-design/` — no son el requirement-spec.)*
4. **BD solo-scripts** — la IA nunca ejecuta DML/DDL; las migraciones quedan en `SCRIPTS.sql` y las aplica el usuario. Solo lecturas read-only vía MCP.
5. **Git seguro** — rama esperada verificada antes de editar; commits propuestos por fuente; nunca `push`/`--amend`/`--no-verify`.
6. **Chasis de loops** — los 5 loops corren el mismo **motor común**; cada loop es un heir que agrega solo sus deltas, nada del motor se re-declara. Detalle: `loops/CHASSIS.md`.

> **Alcance de #1/#2:** gobiernan el plano **sesión → `docs/`** (solo `export-*` lo cruza). El *authoring directo sin flujo* (ver § *Contexto operativo*) es **otro plano**: sin sesión activa, `docs/` es la única superficie gestionada → la IA escribe ahí por convención + numeración. No es auto-export (no hay sesión de la cual graduar).

## Output

Ninguno. Es orientación pura: no escribe documentos ni artefactos.

## Source

Autorada del modelo de diseño (`docs/referencias/`): README de arquitectura (3 capas + 6 invariantes), `workflow-commands/`, `workflow-loops/`, `workflow-artifacts/`, `workflow-exports/`, `workflow-roles/`, `workflow-skills/`, `workflow-harness/`. Modelo actual, desplegado. (Compat: reemplaza la orientación del bundle legacy `session` + flows dev/design/analyze.)
