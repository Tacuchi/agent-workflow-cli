# w/loops — Loop map (Layer 2)

> **Loops** are the pieces the **AI runs whole** to produce deliverables and orchestrate the work. A `/w:…` command (Layer 1) starts them and, from there, **the AI drives them**, not the user.
>
> Siblings: `../commands/` (Layer 1, `/w:…` commands) · `.workflow/sessions/` (Layer 3, sessions + internal artifacts) · the `export-*` family (the only artifact→`docs/` path) · the composable **capabilities** (roles bound in `.workflow/skills.toml`).

---

## What a loop is

A loop is an **operating manual** that teaches the AI *how to iterate* until it produces a deliverable. **It is not invocable by name** as a standalone skill — its file is deliberately named `LOOP.md`, **not** `SKILL.md`, so no harness indexes it as a user-facing skill (several scan skill roots recursively): it is the body of its `/w:…` command, which **loads it by reading `<loop>/LOOP.md`** and executes it inline.

The 5 loops run the same **common engine**, whose canon lives in [`CHASSIS.md`](CHASSIS.md): persistent objective + verification-first, gap-driven convergent, single session per run with inline research, structured-choice + `flow` control (`Compactar`/`Cerrar`, always present), compact/resume, artifacts as a live log, convergence gate and the `docs/` boundary. Each loop is an **heir**: its `## Inherits` orders the chassis read before its deltas — nothing of the engine is repeated here.

## Loops and their flow

| Loop (`name:`) | Flow | Started by | Reads | Writes |
|---|---|---|---|---|
| [`spec-refine-loop`](spec-refine-loop/LOOP.md) | SPEC | `/w:spec-refine` | `docs/specs/NNN-spec*.md` (the spec itself) | `docs/specs/NNN-spec-<slug>.md` (in place) |
| [`plan-new-loop`](plan-new-loop/LOOP.md) | PLAN | `/w:plan-new` | `docs/specs/NNN-spec-*.md` | `docs/plans/PPP-plan-<slug>.md` |
| [`plan-refine-loop`](plan-refine-loop/LOOP.md) | PLAN | `/w:plan-refine` *(aux, optional)* | `docs/plans/PPP-plan-*.md` (the plan itself) | `docs/plans/PPP-plan-<slug>.md` (in place) |
| [`plan-exec-loop`](plan-exec-loop/LOOP.md) | PLAN | `/w:plan-exec` | `docs/plans/PPP-plan-*.md` | `docs/plans/PPP-plan-<slug>.md` (update); the rest via `export-*` |
| [`quick-loop`](quick-loop/LOOP.md) | QUICK | `/w:quick` | — (prompt) | edits code + light session; **no** `docs/` |

> `/w:spec-new` has no loop (single-pass). Hence **6 commands / 5 loops**.

### `docs/` boundary (hard rule)

Every loop writes **only** its own flow's doc (SPEC→`docs/specs` · PLAN→`docs/plans` · QUICK→none) and **never** graduates other artifacts to `docs/` — that promotion belongs to the separate, explicit `export-*` skills. Canon: [`CHASSIS.md`](CHASSIS.md) § *docs/ boundary*.

## Schema of each loop file

| Field | Description |
|---|---|
| `## Flow` | Which flow it belongs to (SPEC · PLAN · QUICK) |
| `## Layer` | Always 2 (the AI runs it whole) |
| `## Started by` | The `/w:…` command that starts it (resumable) |
| `## Reads` | Input document(s) |
| `## Writes` | Output document(s) (`generate` / `read-update`) |
| `## Internal sessions` | Sessions it creates and their artifacts |
| `## Sequence` | The loop's pseudocode |
| `## Convergence / exit` | When it stops |

The **5 loops** are heirs: they use `## Inherits` (a one-line reference to [`CHASSIS.md`](CHASSIS.md), read **always before** the deltas) + their own sections. The engine's sections live in the chassis, in no loop.

## Chassis / heirs

The **engine lives in [`CHASSIS.md`](CHASSIS.md)** (a referenced doc, not a skill); the 5 loops — including `spec-refine-loop` — are **heirs** of that engine. The canonical heirs list and their deltas live in the chassis itself (§ *Heirs*). The chassis is **not a bindable capability**: it is the loop engine; what is pluggable are the **capabilities** a loop composes (e.g. `ui-design`, `sql`, `git`), resolved via `.workflow/skills.toml`.

## Composed capabilities (roles)

Loops compose **capabilities by role**, never concrete skills; the skill fulfilling the role is resolved by `.workflow/skills.toml` (`built-in default → ~/.workflow/skills.toml → .workflow/skills.toml`).

| Role | Default built-in | Composed by |
|---|---|---|
| `ui-design` | `ui-spec` | `spec-refine-loop` (when there is UI) · `plan-new-loop` / `plan-refine-loop` (design SPECs `NNN-SPEC-<SLUG>.md`) |
| `sql` | `sql` | research · `plan-exec-loop` · `quick-loop` |
| `git` | `git` | `plan-exec-loop` · `quick-loop` |
| `research` | `research` | every loop (inline research) |
| `overview` | `w` | anyone (orientation) |

> **Ambient conventions (not roles):** code/testing/writing standards and `creating-tools` are standalone skills the host auto-discovers by `description` — the workflow neither binds nor depends on them. Full doctrine: [../roles/README.md](../roles/README.md).

`off` in config → capability disabled: the loop continues without it; if it was needed, it says so or asks the human.

## Index

- [`CHASSIS.md`](CHASSIS.md) — the common engine of the 5 loops (referenced doc; not a skill)
- [`CODE-POLICIES.md`](CODE-POLICIES.md) — the code-editing loop policies (loaded only by plan-exec and quick)
- [`spec-refine-loop/LOOP.md`](spec-refine-loop/LOOP.md)
- [`plan-new-loop/LOOP.md`](plan-new-loop/LOOP.md)
- [`plan-refine-loop/LOOP.md`](plan-refine-loop/LOOP.md) — aux, optional (refines the plan in place)
- [`plan-exec-loop/LOOP.md`](plan-exec-loop/LOOP.md)
- [`quick-loop/LOOP.md`](quick-loop/LOOP.md)
