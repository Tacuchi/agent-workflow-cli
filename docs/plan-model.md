# PLAN — a plan is a sequence of functional states

A `### Fn` phase is a **verifiable state of the system**, not a batch of technical tasks. It answers one question: *what can the system do or demonstrate at the end that it could not at the start?* The contract is defined **once** in `skills/w/loops/plan-new-loop/LOOP.md` (§ *Phase contract*); the other two plan loops reference it and never redefine it.

- **Phase shape** — required always: `Resultado` · `Trabajo` · `Validación de fase` · `Condición de salida` and `> Fuentes:`. The plan also declares `> Límite de ejecución: checkout`; every task names a non-empty subset of its phase sources with `_(fuentes: …)_`. Conditional, each only when its condition holds: `Estado inicial`, `Recorrido afectado`, `Dependencias`, `Límite de simulación` and `Diferido`. A conditional block is **never written empty** — no `no aplica` placeholders. Granularity is semantic: a task is a unit of purpose that may touch several files, never an edit operation ("create class X").
- **Phase state** — one `> Estado:` line per phase (`pendiente` | `en ejecución` | `bloqueada` | `validada`), machine state that `aw status` parses. A phase reaches `validada` only with its proof green, its exit condition true and the closing review gate passed — **never** because its checkboxes are ticked. A `bloqueada` phase states what it waits on in its own `> Bloqueo:` line.
- **Plan state** — one `> Estado:` line under the title (`open` | `done`), plus a `> Cierre: YYYY-MM-DD · sesión NNN` line on close. It is the third axis, not a summary of the other two: every phase validated with no closure is a plan still `open`, awaiting its **final validation**.
- **Temporary simulation** — **only when the change carries one**, and then planned with a lifecycle: where it is born, how it moves (`antes → después`), which phase retires it, and what prevents it from being selected in a production runtime. A change with no temporary behavior declares no boundary and no gate asks for one. A stub still live on the main path with no declared removal is a review finding.
- **Evidence** — one primary proof per phase; focused tests only where a layer owns rules, transformation, persistence or integration; risk tests on top of those. Tests that only mirror structure are flagged `overtest` at the closing review gate.

The authoring side and the execution side share one gate, seen from both ends:

```
  plan-new ──┐
             ├──▶ executability gate ──▶ plan-exec ──▶ phase cycle ──▶ validada
  plan-refine ┘                              │
                                             ├─ structural deviation ─▶ plan-refine
                                             └─ functional change ────▶ spec-refine
```

`plan-refine` converges when the plan is executable; `plan-exec` re-checks that same shape on entry, normalizes only minor gaps with consent, and returns the work instead of redesigning it silently.

Progress is reported on **three** independent axes, and none stands in for another:

| Axis | Question | Field |
|---|---|---|
| task completed | what work was done | `progress_pct` (checkbox-derived, unchanged) |
| phase validated | what functional state was demonstrated | `phases_validated` / `phases_total` |
| plan closed | whether the whole solution was validated | `plan_state` |

A plan at 100% of checkboxes with zero validated phases is work implemented, not validated. A plan with every phase validated and no closure is `open` with `final_validation_pending: true` — the **final validation** never ran. A plan declaring `done` over open tasks or unvalidated phases is `inconsistent`, reported as a contradiction rather than a closure. Both `/w:status` and `/w:resume` say so, and a `bloqueada` phase is shown with the `> Bloqueo:` reason that says what unblocks it.
