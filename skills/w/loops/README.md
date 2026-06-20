# w/loops — Loop map (Layer 2)

> Los **loops** son las piezas que la **IA corre enteras** para producir entregables y orquestar el trabajo. Los arranca un comando `/w:…` (Capa 1) y, a partir de ahí, **los conduce la IA**, no el usuario.
>
> Hermanos: `../commands/` (Capa 1, comandos `/w:…`) · `.workflow/sessions/` (Capa 3, sessions + artefactos internos) · la familia `export-*` (única vía artefacto→`docs/`) · las **capacidades** componibles (roles bindeados en `.workflow/skills.toml`).

---

## What a loop is

Un loop es una **skill** que le enseña a la IA *cómo iterar* hasta producir un entregable. **No es invocable por nombre** con el tool `Skill` (no se registra como skill suelta): es el cuerpo de su comando `/w:…`, que lo **carga leyendo `<loop>/SKILL.md`** y lo ejecuta inline. La IA lo corre de punta a punta: detecta huecos, los resuelve (preguntando al humano o investigando), integra y repite hasta converger.

Propiedades comunes a **los 4 loops**:

1. **Gap-driven convergente** — cada ciclo: `detect_gaps` → resolver (humano o research) → integrar → repetir hasta que no queden gaps materiales. Los gaps "agotados" (límite `MAX` de intentos) no se re-disparan → garantiza convergencia.
2. **Puede crear sessions internas** — si refinar/planificar/ejecutar requiere trabajo profundo (ej. investigar el código), el loop crea una session en `.workflow/sessions/` que maneja **sus** artefactos, la cierra y reporta de vuelta. **El usuario nunca crea esas sessions.**
3. **AskUserQuestion con dos tipos de tab** (límite host: 4 preguntas/llamada):
   - **tab(s) de contenido** (≤3) — la(s) pregunta(s) real(es) del momento (resolver una duda, elegir MCP, o en convergencia: `Guardar` / `Preguntar algo más`).
   - **tab `flow`** (1, SIEMPRE presente) — control de ciclo de vida por un canal lateral. Así el contenido lo maneja la IA y el ciclo de vida lo dirige el humano.
4. **Escribe solo en su propia carpeta `docs/`** — y **nunca** gradúa/exporta otros artefactos a `docs/`. Esa promoción la hacen las skills `export-*`, aparte y explícita.

## flow tab — options

El tab `flow` es **fijo**: `Compactar` / `Cerrar`, presente en los 4 loops. Responder el tab de contenido **sin tocar `flow`** = seguir iterando ("continuar" es el comportamiento por defecto del loop, no una opción del canal de control).

| Option | What it does |
|---|---|
| `Compactar` | Escribe `CHECKPOINT` (session dueña del run) + dispara `/compact` del host y reanuda sin perder el hilo. |
| `Cerrar` | `finalize`: persiste lo pendiente (`CHECKPOINT` + `BACKLOG`), cierra sessions internas y termina el loop. |

## Loops and their flow

| Loop (`name:`) | Flow | Started by | Reads | Writes |
|---|---|---|---|---|
| [`spec-refine-loop`](spec-refine-loop/SKILL.md) | SPEC | `/w:spec-refine` | `docs/specs/NNN-spec.md` (o `…-spec-refined.md` si ya existe) | `docs/specs/NNN-spec-refined.md` |
| [`plan-new-loop`](plan-new-loop/SKILL.md) | PLANIFICATION | `/w:plan-new` | `docs/specs/NNN-spec-refined.md` | `docs/plans/PPP-plan.md` |
| [`plan-exec-loop`](plan-exec-loop/SKILL.md) | PLANIFICATION | `/w:plan-exec` | `docs/plans/PPP-plan.md` | `docs/plans/PPP-plan.md` (update) + `docs/tools`; resto vía `export-*` |
| [`quick-loop`](quick-loop/SKILL.md) | QUICK | `/w:quick` | — (prompt) | edita código + session ligera; **no** `docs/` |

> `/w:spec-new` no tiene loop (es single-pass). Por eso hay **5 comandos / 4 loops**.

### `docs/` boundary (regla dura)

Los loops **nunca** graduan/exportan artefactos a `docs/` automáticamente. Cada loop escribe **solo** su(s) carpeta(s):

| Flow | Carpetas `docs/` que escribe |
|---|---|
| SPEC | `docs/specs` |
| PLANIFICATION | `docs/plans` (living) + `docs/tools` (herramientas creadas — salida directa) |
| QUICK | ninguna |

Todo lo demás (migraciones → `docs/scripts`, manuales → `docs/manuals`, diagramas → `docs/diagrams`, informes → `docs/reports`) queda como **artefacto de session** hasta que un `export-*` lo promueva, como paso aparte y explícito.

## Loops × flow tab

| Loop | tab(s) de contenido típicos | tab `flow` |
|---|---|---|
| `spec-refine-loop` | dudas-de-humano · elección de MCP · convergencia (`Guardar especificación refinada` / `Preguntar algo más`) | `Compactar` / `Cerrar` |
| `plan-new-loop` | dudas · elección de MCP · convergencia (`Guardar plan` / `Preguntar algo más`) | `Compactar` / `Cerrar` |
| `plan-exec-loop` | decisiones/dudas no obvias · elección de MCP · cierre (`Marcar plan done` / `Preguntar algo más`) | `Compactar` / `Cerrar` |
| `quick-loop` | dudas no obvias · escalar a SPEC/PLAN · cierre (`Cerrar tarea` / `Preguntar algo más`) | `Compactar` / `Cerrar` |

## Schema of each loop file

| Field | Description |
|---|---|
| `## Flow` | A qué flujo pertenece (SPEC · PLANIFICATION · QUICK) |
| `## Layer` | Siempre 2 (la IA lo corre entero) |
| `## Started by` | Comando `/w:…` que lo arranca (reanudable) |
| `## Reads` | Documento(s) de entrada |
| `## Writes` | Documento(s) de salida (`generate` / `read-update`) |
| `## Internal sessions` | Sessions que crea y sus artefactos |
| `## Sequence` | Pseudocódigo + mermaid del loop |
| `## Convergence / exit` | Cuándo para |

El **chasis** (`spec-refine-loop`) además detalla `## Composes` (capacidades que compone), `## Deliverable schema`, `## Gap taxonomy`, `## Ask-vs-research rule`, `## Research: autonomy, scope & failure`, `## AskUserQuestion`, `## Compact / resume`, `## Integration`.

Los **heirs** (`plan-new-loop`, `plan-exec-loop`, `quick-loop`) usan `## Inherits` (lo que reusan del chasis, sin repetirlo) + `## Delta N` (sus diferencias).

## Chassis / heirs

```
spec-refine-loop  ── CHASIS (patrón de referencia: motor gap-driven, sessions,
        │            AskUserQuestion + tab flow, research autónomo + regla BD,
        │            compact/resume, Cerrar persiste CHECKPOINT+BACKLOG)
        ├── plan-new-loop   (heir)  → deltas: plan rico, gap taxonomy de plan
        ├── plan-exec-loop  (heir)  → deltas: ejecución real (código/BD/git),
        │                              session por fase, sin auto-export
        └── quick-loop      (heir)  → deltas: ceremonia mínima, 1 session,
                                       hereda git/BD/no-export de plan-exec
```

El chasis **no es una capacidad bindeable**: *es* `spec-refine-loop` y los demás loops lo heredan. Lo enchufable son las **capacidades** que un loop compone (ej. `ui-design`, `sql`, `git`, `testing`), resueltas por `.workflow/skills.toml`.

## Composed capabilities (roles)

Los loops componen **capacidades por su rol**, no skills concretas; la skill que cumple el rol la resuelve `.workflow/skills.toml` (`built-in default → ~/.workflow/skills.toml → .workflow/skills.toml`).

| Role | Default built-in | Composed by |
|---|---|---|
| `ui-design` | `ui-spec` | `spec-refine-loop` (cuando hay UI) |
| `sql` | `sql` | research · `plan-exec-loop` · `quick-loop` |
| `git` | `git` | `plan-exec-loop` · `quick-loop` |
| `coding-standards` | `coding-standards` | `plan-exec-loop` · `quick-loop` |
| `writing` | `writing` | todos los loops |
| `research` | `research` | todos los loops (research on-demand) |
| `testing` | `testing` | `plan-exec-loop` · `quick-loop` |
| `tools` | `tools` | `plan-exec-loop` |
| `overview` | `workflow` | cualquiera (orientación) |

`off` en config → capacidad desactivada: el loop sigue sin ella; si era necesaria, lo dice o pregunta al humano.

## Index

- [`spec-refine-loop/SKILL.md`](spec-refine-loop/SKILL.md) — el chasis
- [`plan-new-loop/SKILL.md`](plan-new-loop/SKILL.md)
- [`plan-exec-loop/SKILL.md`](plan-exec-loop/SKILL.md)
- [`quick-loop/SKILL.md`](quick-loop/SKILL.md)
