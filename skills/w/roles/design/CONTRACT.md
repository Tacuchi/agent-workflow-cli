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

## What a person actually sees

Four stages is the machinery. The **visible** journey is four moments and exactly
one decision:

```
comprender fuentes → redactar y organizar → vista previa → Aprobar y guardar | Refinar
```

`prepare` publishes what a valid answer must contain and where it may land;
`validate` seals the exact bytes and returns the preview; the person decides once.
`Aprobar y guardar` runs `apply` with that digest and covers the whole proposal —
document, manifest, index and derived state — in one atomic write. `Refinar`
produces no effect at all and the proposal is written again. An identical retry
reuses the approval; any change of content, destination, base, scope or effect
class invalidates it and shows a new preview.

Discovery, classification, numbering, digests, validation, publication and indexes
never become questions of their own. What keeps its OWN boundary: sensitive
sources, network, execution, destruction, external effects, and any scope the
preview did not show.

## Two shapes, one contract

`create` and `update` publish a **simple** design by default: one authored
`DESIGN.md` (`## Objetivo`, `## Diseño propuesto`, `## Validación`, plus
`## Recorrido`, `## Decisiones` or `## Abiertos` only when they say something).
The CLI derives the identity, the folder, the revision, the digest and a minimal
manifest — the caller administers none of it, and `maturity` answers null because
one document has no ladder to climb.

The full **UI Design Package v1** appears only with a cause, and the vocabulary is
closed to five — one is enough:

| Signal | Means | Who says it |
|---|---|---|
| `design.independent-outcomes` | two or more results each worth delivering | agent |
| `design.functional-blocking` | an unclosed functional decision blocks the design | agent |
| `design.clarity-lost` | one document would stop being readable | agent |
| `design.governance-or-system-reuse` | the package already carries governance or several revisions | **CLI derives** |
| `design.special-source-or-effect` | a sensitive source, an external transmission, or a declared source that did not contribute | **CLI derives** |

Recognizing a semantic signal is judgment and travels as `--input expansion=<id>`;
the two structural ones are facts about the invocation, so declaring one is
refused rather than believed. The receipt carries the mode, the signals that fired
and the one-line cause — every artifact beyond the simple document traces back to
the need it covers. `render` and `record` are package operations regardless.

Publishing a second simple revision archives the outgoing bytes inside the same
approved proposal, so a reference pinned to `@r1` keeps resolving after `@r2`
lands: a published revision is never taken away by the next one.

## Evidence and lifecycle inside a package

`trace` marks each criterion `visual`, `interaction` or `not_visual`. Preview only
visual acceptance; interaction relies on states, semantics and implementation
proof, never a storyboard to satisfy format.

The CLI marks a delta **compact** only with an existing surface, ≤2 screens, and
no journey, rule, token, asset, external dependency, blocker or adaptation.
Compact publishes one `handoff` for PLAN to reuse; otherwise SPEC keeps `outline`
and PLAN promotes only its consumed closure. The model authors content, not this
routing — the same split the simple route applies to expansion.

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

Inside a workspace the design defaults to `docs/designs/` and is discoverable by
the index — which is what lets a spec or a plan reference it later without it ever
having had a relationship with those flows. On the simple route the exact folder
is derived from the title (`docs/designs/NNN-design-<slug>/`) and travels back as
the one allowed destination, so `target` is optional and naming it only narrows
the default. Outside a workspace the caller MUST name an explicit root; the result
is still a conformant, portable package — and it takes the expanded route, because
a simple design derives its identity from an index that is not there. What never
happens is a guess: no root declared outside a workspace, nothing written.

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
