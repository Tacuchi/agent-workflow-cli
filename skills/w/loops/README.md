# w/loops — Loop map (Layer 2)

> Los **loops** son las piezas que la **IA corre enteras** para producir entregables y orquestar el trabajo. Los arranca un comando `/w:…` (Capa 1) y, a partir de ahí, **los conduce la IA**, no el usuario.
>
> Hermanos: `../commands/` (Capa 1, comandos `/w:…`) · `.workflow/sessions/` (Capa 3, sessions + artefactos internos) · la familia `export-*` (única vía artefacto→`docs/`) · las **capacidades** componibles (roles bindeados en `.workflow/skills.toml`).

---

## What a loop is

Un loop es una **skill** que le enseña a la IA *cómo iterar* hasta producir un entregable. **No es invocable por nombre** con el tool `Skill` (no se registra como skill suelta): es el cuerpo de su comando `/w:…`, que lo **carga leyendo `<loop>/SKILL.md`** y lo ejecuta inline. La IA lo corre de punta a punta: detecta huecos, los resuelve (preguntando al humano o investigando), integra y repite hasta converger.

Propiedades comunes a **los 5 loops**:

1. **Objetivo persistente + verification-first** — el loop persigue su `SESSION.Objective` y solo finaliza cuando sus `SESSION.Success criteria` están **en verde** (o el humano aborta vía `flow` `Cerrar`). Esos criterios —la condición de término— se **siembran al inicio** (*verification-first*, TDD generalizado: tests ejecutables para código, rúbrica falsable para análisis/diseño), no se improvisan al final. Modelado en el `/goal` de Claude Code pero como **doctrina agnóstica** (sin depender de ningún host) y con registro durable. El "no parar hasta converger" es del loop, no del arnés. **Entre turnos**, el mismo `CHECKPOINT`+resume hace que un prompt **sin comando** **continúe/reabra la sesión más reciente** en vez de arrancar trabajo suelto — la cara *inter-turno* del objetivo persistente (ver [`../SKILL.md`](../SKILL.md) § *Contexto operativo*).
2. **Gap-driven convergente** — el *cómo* del objetivo persistente: cada ciclo `detect_gaps` → resolver (humano o research) → integrar → repetir hasta que no queden gaps materiales. Los gaps "agotados" (límite `MAX` de intentos) no se re-disparan → garantiza convergencia.
3. **Una sola session por run + research inline** — el loop crea **una** session en `.workflow/sessions/` (la dueña del run) y maneja **sus** artefactos. La **investigación es inline**: una actividad dentro de esa misma session que escribe `ANALYSIS-FILE`/`CONCLUSIONS` (+ `SCRIPTS.sql` read-only si consulta BD) en su propia carpeta — ya no es una session aparte. **El usuario nunca crea sessions.** Los artefactos son el **registro vivo** del run — **ciclo artifact-first**: sembrar `CHECKPOINT.Pending/Next` (la intención) antes de ejecutar, llevar a `Completed`/DECISION después; CHECKPOINT actualizado en cada límite de gap/fase, BACKLOG solo si difiere. El spec/plan es la base guía.
4. **Structured-choice con dos planos** (capacidad del arnés — ver [`../harness/SKILL.md`](../harness/SKILL.md); en **Claude Code** es `AskUserQuestion`, máx 4 preguntas/llamada → **≤3 + 1 control `flow`**; sin elección estructurada degrada a markdown numerado):
   - **pregunta(s) de contenido** (≤3) — la(s) pregunta(s) real(es) del momento (resolver una duda, elegir MCP, o en convergencia: `Guardar` / `Preguntar algo más`).
   - **control `flow`** (1, SIEMPRE presente) — control de ciclo de vida por un canal lateral. Así el contenido lo maneja la IA y el ciclo de vida lo dirige el humano.
5. **Escribe solo en su propia carpeta `docs/`** — y **nunca** gradúa/exporta otros artefactos a `docs/`. Esa promoción la hacen las skills `export-*`, aparte y explícita.

## flow control — options

El control `flow` es **fijo**: `Compactar` / `Cerrar`, presente en los 5 loops. Responder la pregunta de contenido **sin tocar `flow`** = seguir iterando ("continuar" es el comportamiento por defecto del loop, no una opción del canal de control).

| Option | What it does |
|---|---|
| `Compactar` | Escribe `CHECKPOINT` (session dueña del run) + dispara la **compactación** del arnés (en Claude Code: `/compact`; ver [`../harness/SKILL.md`](../harness/SKILL.md)) y reanuda sin perder el hilo. |
| `Cerrar` | `finalize`: persiste lo pendiente (`CHECKPOINT` siempre; `BACKLOG` solo si hay algo diferido), cierra la session y termina el loop. |

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

Los loops **nunca** graduan/exportan artefactos a `docs/` automáticamente. Cada loop escribe **solo** su(s) carpeta(s):

| Flow | Carpetas `docs/` que escribe |
|---|---|
| SPEC | `docs/specs` |
| PLAN | `docs/plans` (living) |
| QUICK | ninguna |

Todo lo demás (migraciones → `docs/scripts`, manuales → `docs/manuals`, diagramas → `docs/diagrams`, informes → `docs/reports`) queda como **artefacto de session** hasta que un `export-*` lo promueva, como paso aparte y explícito.

## Loops × flow control

| Loop | pregunta(s) de contenido típicas | control `flow` |
|---|---|---|
| `spec-refine-loop` | dudas-de-humano · elección de MCP · convergencia (`Guardar especificación refinada` / `Preguntar algo más`) | `Compactar` / `Cerrar` |
| `plan-new-loop` | dudas · elección de MCP · convergencia (`Guardar plan` / `Preguntar algo más`) | `Compactar` / `Cerrar` |
| `plan-refine-loop` | dudas · elección de MCP · convergencia (`Guardar plan refinado` / `Preguntar algo más`) | `Compactar` / `Cerrar` |
| `plan-exec-loop` | decisiones/dudas no obvias · elección de MCP · cierre (`Marcar plan done` / `Preguntar algo más`) | `Compactar` / `Cerrar` |
| `quick-loop` | dudas no obvias · escalar a SPEC/PLAN · cierre (`Cerrar tarea` / `Preguntar algo más`) | `Compactar` / `Cerrar` |

## Schema of each loop file

| Field | Description |
|---|---|
| `## Flow` | A qué flujo pertenece (SPEC · PLAN · QUICK) |
| `## Layer` | Siempre 2 (la IA lo corre entero) |
| `## Started by` | Comando `/w:…` que lo arranca (reanudable) |
| `## Reads` | Documento(s) de entrada |
| `## Writes` | Documento(s) de salida (`generate` / `read-update`) |
| `## Internal sessions` | Sessions que crea y sus artefactos |
| `## Sequence` | Pseudocódigo + mermaid del loop |
| `## Convergence / exit` | Cuándo para |

El **chasis** (`spec-refine-loop`) además detalla `## Composes` (capacidades que compone), `## Deliverable schema`, `## Gap taxonomy`, `## Ask-vs-research rule`, `## Research: autonomy, scope & failure`, `## Structured-choice`, `## Compact / resume`, `## Integration`.

Los **heirs** (`plan-new-loop`, `plan-refine-loop`, `plan-exec-loop`, `quick-loop`) usan `## Inherits` (lo que reusan del chasis, sin repetirlo) + `## Delta N` (sus diferencias).

## Chassis / heirs

```
spec-refine-loop  ── CHASIS (patrón de referencia: objetivo persistente + verification-first, gap-driven, sesión única,
        │            structured-choice + control flow, research autónomo INLINE + regla BD,
        │            compact/resume, artefactos como log vivo: CHECKPOINT siempre,
        │            BACKLOG solo si difiere)
        ├── plan-new-loop    (heir)  → deltas: plan rico, gap taxonomy de plan
        ├── plan-refine-loop (heir)  → deltas: refina el plan in place (aux, opcional);
        │                               reusa gap taxonomy + coherence gate de plan-new
        ├── plan-exec-loop   (heir)  → deltas: ejecución real (código/BD/git),
        │                               una sola session por run, gate de revisión
        │                               de cierre pre-commit, sin auto-export
        └── quick-loop       (heir)  → deltas: ceremonia mínima, 1 session,
                                        hereda git/BD/no-export de plan-exec
```

El chasis **no es una capacidad bindeable**: *es* `spec-refine-loop` y los demás loops lo heredan. Lo enchufable son las **capacidades** que un loop compone (ej. `ui-design`, `sql`, `git`), resueltas por `.workflow/skills.toml`.

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

- [`spec-refine-loop/SKILL.md`](spec-refine-loop/SKILL.md) — el chasis
- [`plan-new-loop/SKILL.md`](plan-new-loop/SKILL.md)
- [`plan-refine-loop/SKILL.md`](plan-refine-loop/SKILL.md) — aux, opcional (refina el plan in place)
- [`plan-exec-loop/SKILL.md`](plan-exec-loop/SKILL.md)
- [`quick-loop/SKILL.md`](quick-loop/SKILL.md)
