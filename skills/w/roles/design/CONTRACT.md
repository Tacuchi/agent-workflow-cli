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

## Sources, and what an omission costs

The v1 catalog: Markdown or text, images and screenshots, PDF, DOCX, PPTX, host
context or attachments, an existing package, and provider locators. Binary
documents are read by the **host's** multimodal capability — no parser ships in
the CLI — so what the catalog declares is what the domain can account for.

Every source ends in one of five dispositions, and each one that is not `used`
carries its reason: `used` · `skipped` (a decision) · `unsupported` (a format v1
never promised, every retired UI format included) · `unavailable` (it should
have been readable and was not) · `redacted` (withheld on purpose).

The consequence is fail-closed: a source that did not contribute blocks
`handoff` unless someone states, in writing, why the design does not need it. A
run that silently dropped a requirements document and still declared itself
ready for implementation is the failure this exists to prevent. Original
documents are never copied into the package unless a person names them, and
never when they are sensitive.

## Where the output lands

Inside a workspace the package defaults to `docs/designs/` and is discoverable
by the index — which is what lets a spec or a plan reference it later without it
ever having had a relationship with those flows. Outside a workspace the caller
must name an explicit root; the result is still a conformant, portable package,
and it is simply not indexed. What never happens is a guess: no root declared,
nothing written.

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
