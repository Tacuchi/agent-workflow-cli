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

Cadena típica: prompt → `spec-new` genera `docs/specs/NNN-spec.md` → `spec-refine` corre el loop → `NNN-spec-refined.md` → `plan-new` → `docs/plans/PPP-plan.md` → `plan-exec` ejecuta y actualiza el plan (living doc) + artefactos en sesiones. La promoción del resto a `docs/` es **siempre** un paso aparte vía `export-*`.

### The commands (`/w:` namespace)

- `/w:workspace-init` — inicializa el workspace.
- `/w:spec-new` — genera un spec inicial (single-pass, sin loop).
- `/w:spec-refine` — arranca `spec-refine-loop` para refinar el spec.
- `/w:plan-new` — arranca `plan-new-loop` para derivar un plan ejecutable del spec refinado.
- `/w:plan-exec` — arranca `plan-exec-loop` para ejecutar y mantener el plan.
- `/w:quick` — arranca `quick-loop` (atajo, sin `docs/`).
- `/w:export-scripts` · `/w:export-manuals` · `/w:export-diagrams` · `/w:export-reports` — promueven artefactos a `docs/`.

### The loops (Layer 2)

Un loop es una skill que enseña a la IA **cómo iterar** hasta un entregable. Propiedades comunes (el chasis, en `spec-refine-loop`, lo heredan los demás):

1. **Gap-driven convergente** — cada ciclo: detecta huecos → resuelve (pregunta al humano o investiga) → integra → repite hasta converger.
2. **Puede crear sessions internas** — si el trabajo es profundo (ej. investigar el código), el loop crea una session (`research`, etc.), maneja sus artefactos en `.workflow/sessions/`, la cierra y reporta. El usuario nunca crea esas sessions.
3. **AskUserQuestion con dos tipos de tab**:
   - **tab(s) de contenido** — la pregunta real del momento.
   - **tab `flow`** — control de ciclo de vida, **siempre presente**: `Compactar` / `Cerrar`. Responder el tab de contenido sin tocar `flow` = seguir iterando.
4. **Escribe solo en su carpeta `docs/`** — y nunca exporta el resto (eso es de `export-*`).

`flow → Compactar` = checkpoint + `/compact` del host y reanuda. `flow → Cerrar` = persiste `CHECKPOINT` + `BACKLOG`, cierra sessions internas, termina.

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
| `research` | `research` | should | todos los loops (on-demand) |
| `testing` | `testing` | should | `plan-exec-loop` · `quick-loop` |
| `tools` | `tools` | should | `plan-exec-loop` |
| `diagrams` | `diagrams` | should | `export-diagrams` |
| `overview` | `workflow` | should | cualquiera (orientación) |

El **chasis del loop** NO se bindea: **es** el loop, no es enchufable.

### The 6 hard invariants

1. **Sin auto-export** — los loops nunca graduan/exportan a `docs/`. Solo `export-*` lo hace, explícito.
2. **Cada flujo toca solo sus carpetas `docs/`** — SPEC→`specs` · PLAN→`plans`+`tools` · QUICK→ninguna · resto→`export-*`.
3. **El spec y el plan son documentos** (`docs/`), no artefactos de sesión.
4. **BD solo-scripts** — la IA nunca ejecuta DML/DDL; las migraciones quedan en `SCRIPTS.sql` y las aplica el usuario. Solo lecturas read-only vía MCP.
5. **Git seguro** — rama esperada verificada antes de editar; commits propuestos por fuente; nunca `push`/`--amend`/`--no-verify`.
6. **Chasis de loops** — gap-driven convergente · `AskUserQuestion` con ≤3 tabs de contenido + 1 tab `flow` (`Compactar`/`Cerrar`) siempre · compact/resume · `Cerrar` persiste `CHECKPOINT`+`BACKLOG`.

## Output

Ninguno. Es orientación pura: no escribe documentos ni artefactos.

## Source

Autorada del modelo de diseño (`docs/referencias/`): README de arquitectura (3 capas + 6 invariantes), `workflow-commands/`, `workflow-loops/`, `workflow-exports/`, `workflow-skills/`. Reemplaza la orientación del bundle viejo (`session` + flows dev/design/analyze, CLI v11), que se descarta.
