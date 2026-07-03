# w/loops — Loop map (Layer 2)

> Los **loops** son las piezas que la **IA corre enteras** para producir entregables y orquestar el trabajo. Los arranca un comando `/w:…` (Capa 1) y, a partir de ahí, **los conduce la IA**, no el usuario.
>
> Hermanos: `../commands/` (Capa 1, comandos `/w:…`) · `.workflow/sessions/` (Capa 3, sessions + artefactos internos) · la familia `export-*` (única vía artefacto→`docs/`) · las **capacidades** componibles (roles bindeados en `.workflow/skills.toml`).

---

## What a loop is

Un loop es una **skill** que le enseña a la IA *cómo iterar* hasta producir un entregable. **No es invocable por nombre** como skill suelta (no se registra como tal; en Claude Code, la invocación por nombre es el tool `Skill` — su binding, no un universal): es el cuerpo de su comando `/w:…`, que lo **carga leyendo `<loop>/SKILL.md`** y lo ejecuta inline.

Los 5 loops corren el mismo **motor común**, cuyo canon vive en [`CHASSIS.md`](CHASSIS.md): objetivo persistente + verification-first, gap-driven convergente, session única por run con research inline, structured-choice + control `flow` (`Compactar`/`Cerrar`, siempre presente), compact/resume, artefactos como log vivo, convergence gate y el boundary de `docs/`. Cada loop es un **heir**: su `## Inherits` manda leer el chasis antes de sus deltas — nada del motor se repite acá.

## Loops and their flow

| Loop (`name:`) | Flow | Started by | Reads | Writes |
|---|---|---|---|---|
| [`spec-refine-loop`](spec-refine-loop/SKILL.md) | SPEC | `/w:spec-refine` | `docs/specs/NNN-spec*.md` (el spec mismo) | `docs/specs/NNN-spec-<slug>.md` (in place) |
| [`plan-new-loop`](plan-new-loop/SKILL.md) | PLAN | `/w:plan-new` | `docs/specs/NNN-spec-*.md` | `docs/plans/PPP-plan-<slug>.md` |
| [`plan-refine-loop`](plan-refine-loop/SKILL.md) | PLAN | `/w:plan-refine` *(aux, opcional)* | `docs/plans/PPP-plan-*.md` (el plan mismo) | `docs/plans/PPP-plan-<slug>.md` (in place) |
| [`plan-exec-loop`](plan-exec-loop/SKILL.md) | PLAN | `/w:plan-exec` | `docs/plans/PPP-plan-*.md` | `docs/plans/PPP-plan-<slug>.md` (update); resto vía `export-*` |
| [`quick-loop`](quick-loop/SKILL.md) | QUICK | `/w:quick` | — (prompt) | edita código + session ligera; **no** `docs/` |

> `/w:spec-new` no tiene loop (es single-pass). Por eso hay **6 comandos / 5 loops**.

### `docs/` boundary (regla dura)

Cada loop escribe **solo** el doc de su propio flujo (SPEC→`docs/specs` · PLAN→`docs/plans` · QUICK→ninguno) y **nunca** gradúa otros artefactos a `docs/` — esa promoción la hacen las skills `export-*`, aparte y explícitas. Canon: [`CHASSIS.md`](CHASSIS.md) § *docs/ boundary*.

## Schema of each loop file

| Field | Description |
|---|---|
| `## Flow` | A qué flujo pertenece (SPEC · PLAN · QUICK) |
| `## Layer` | Siempre 2 (la IA lo corre entero) |
| `## Started by` | Comando `/w:…` que lo arranca (reanudable) |
| `## Reads` | Documento(s) de entrada |
| `## Writes` | Documento(s) de salida (`generate` / `read-update`) |
| `## Internal sessions` | Sessions que crea y sus artefactos |
| `## Sequence` | Pseudocódigo del loop |
| `## Convergence / exit` | Cuándo para |

Los **5 loops** son heirs: usan `## Inherits` (referencia de 1 línea a [`CHASSIS.md`](CHASSIS.md), que se lee **siempre antes** de los deltas) + sus secciones propias. Las secciones del motor viven en el chasis, no en ningún loop.

## Chassis / heirs

El **motor vive en [`CHASSIS.md`](CHASSIS.md)** (doc referenciado, no una skill); los 5 loops —incluido `spec-refine-loop`— son **heirs** de ese motor. La lista canónica de heirs y sus deltas está en el propio chasis (§ *Heirs*). El chasis **no es una capacidad bindeable**: es el motor de los loops; lo enchufable son las **capacidades** que un loop compone (ej. `ui-design`, `sql`, `git`), resueltas por `.workflow/skills.toml`.

## Composed capabilities (roles)

Los loops componen **capacidades por su rol**, no skills concretas; la skill que cumple el rol la resuelve `.workflow/skills.toml` (`built-in default → ~/.workflow/skills.toml → .workflow/skills.toml`).

| Role | Default built-in | Composed by |
|---|---|---|
| `ui-design` | `ui-spec` | `spec-refine-loop` (cuando hay UI) · `plan-new-loop` / `plan-refine-loop` (design SPECs `NNN-SPEC-<SLUG>.md`) |
| `sql` | `sql` | research · `plan-exec-loop` · `quick-loop` |
| `git` | `git` | `plan-exec-loop` · `quick-loop` |
| `research` | `research` | todos los loops (research inline) |
| `overview` | `workflow` | cualquiera (orientación) |

> **Convenciones ambientes (no roles):** estándares de código/testing/redacción y `creating-tools` son skills standalone que el host auto-descubre por su `description` — el workflow no las bindea ni depende de ellas. Doctrina completa: [../roles/README.md](../roles/README.md).

`off` en config → capacidad desactivada: el loop sigue sin ella; si era necesaria, lo dice o pregunta al humano.

## Index

- [`CHASSIS.md`](CHASSIS.md) — el motor común de los 5 loops (doc referenciado; no es una skill)
- [`spec-refine-loop/SKILL.md`](spec-refine-loop/SKILL.md)
- [`plan-new-loop/SKILL.md`](plan-new-loop/SKILL.md)
- [`plan-refine-loop/SKILL.md`](plan-refine-loop/SKILL.md) — aux, opcional (refina el plan in place)
- [`plan-exec-loop/SKILL.md`](plan-exec-loop/SKILL.md)
- [`quick-loop/SKILL.md`](quick-loop/SKILL.md)
