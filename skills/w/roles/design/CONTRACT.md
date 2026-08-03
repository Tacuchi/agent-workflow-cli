# design — invocation contract

The single authority for **how** `design` is invoked. The installed wrapper
(`design/SKILL.md`) and [`ROLE.md`](ROLE.md) both point here instead of
restating it: two descriptions of one contract disagree the day either changes.

The machine-readable form is the descriptor published next to the wrapper
(`workline-capability.json`, schema `../../schemas/capability-descriptor.schema.json`).
This file is what a person or a loop reads.

## One door, four stages

```
aw capability prepare  --capability design --operation <op> [--input k=v ...]
aw capability continue                                       # stdin: {"parent": <request>}
aw capability validate                                       # stdin: {"request": …, "answer": …}
aw capability apply --approval <digest>                      # stdin: {"request": …, "plan": …}
```

The verbs are **stages**, never operations: the operation travels in the
envelope. Every attempt returns `outcome`, `output` and `receipt`. A
`needs_input` is answered with `continue`, which builds the NEXT attempt of the
same `invocation_id` — it never reuses the previous request.

## What each caller may invoke

| Caller | Operations | Then |
|---|---|---|
| direct wrapper | all five | converses in the host; opens no flow session or document |
| SPEC REFINE | `create` · `update` · `validate` | keeps its own questions, gate and publication |
| PLAN NEW · PLAN REFINE | `update` · `validate` | closes its plan over the revision it references |
| PLAN EXEC · QUICK | `validate` | **consumes** the package inside its own lifecycle |

There is no sixth `consume` operation: consuming is what a flow DOES with a
validated package, not something it asks the capability to do. An operation
outside its row is refused, never improvised. A flow may add gates of its own and
may never lower one the capability already failed; a durable output produced
through the direct route is adopted later **by exact reference** — same identity,
revision and digest — with no recreation and no format conversion.

## What the direct route does not do

- Never creates, advances, closes or publishes a SPEC, PLAN or QUICK session or
  document.
- Never initializes a workspace: an operation that needs one and does not find
  it returns an explicit result.
- Never exercises an effect the descriptor does not declare, nor one that
  requires approval without asking for it first.

`off` is decided per operation by the descriptor and no host, wrapper or legacy
name reverts it. `aw skills --detail` reports the live state, its evidence and
the next action.
