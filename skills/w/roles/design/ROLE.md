---
name: design
description: >-
  UI design authoring over the **UI Design Package v1** — the durable dossier
  under `docs/designs/NNN-design-<slug>/` that a spec references and a plan
  implements against. Authors **flows** (the journey: nodes, edges, actors) and
  **screens** (the surface: states, structure, data, accessibility) as Markdown
  with versioned YAML frontmatter, plus the rules, tokens, renditions and
  governance records around them. Knows the package layout, the six canonical
  schemas, the maturity ladder (`outline` → `handoff`), the reference grammar
  `DES-NNN/SCR-NNN@rN#anchor`, and what a document must close before an
  implementation may be planned against it. Use when a loop refines a spec,
  builds or refines a plan, or executes one that involves screens, forms,
  dashboards, modals or any UI surface.
---

# design — UI design over the UI Design Package v1

## Role

`design` — this is its **built-in default implementation**, and `design` is the
**only public identity** of this capability. `ui-design` (the role this
replaces) and `ui-spec` (the skill that used to fill it) are **not** aliases,
**not** alternative implementations and **not** accepted names: a second name
for one capability is a second contract in disguise, and the day the two
disagree there is no way to say which one the package obeys.

Rebindable in `.workflow/skills.toml` to a third-party skill or `off`.
Resolution: built-in default → `~/.workflow/skills.toml` (global) →
`.workflow/skills.toml` (workspace). See [`../README.md`](../README.md).

## Purpose

Given a UI requirement, author the **semantic** design of its journeys and
surfaces into a package that outlives the session that produced it: durable,
versioned, referenceable by digest, and complete enough that an implementation
can be planned against it without reopening the design conversation.

The package is the deliverable. A spec **references** it; it never contains it.

## Composed by

- **`spec-refine-loop`** — the requirement involves UI: reuse a compatible
  baseline or, for a compact delta, publish the exact `handoff` in one pass;
  expanded work opens an `outline` revision. The spec leaves only `## Design
  references`.
- **`plan-new-loop` · `plan-refine-loop`** — the plan consumes UI: reuse that
  valid handoff, or promote exactly the missing closure, and write the exact
  roots into each phase or task.
- **`plan-exec-loop`** — reads and validates; **never redesigns**. A design that
  turns out wrong stops execution and goes back to the refining loop.

In all of them the composing loop contributes the human questions
(*structured-choice*, chassis § *Structured-choice*), the gap-driven iteration
and the curation. This skill contributes what a correct package looks like.

## Knowledge

### Package layout

```
docs/designs/NNN-design-<slug>/
  design-manifest.json          mutable index — catalog, governance, currentness
  baselines/DES-NNN-rNNN.json   immutable: what the package IS at that revision
  flows/FLW-NNN-rNNN-<slug>.md
  screens/SCR-NNN-rNNN-<slug>.md
  design-system/rules/RUL-NNN-rNNN-<slug>.md
  tokens/TOK-NNN-rNNN-<slug>.tokens.json
  renditions/VIS-NNN-rNNN-<slug>/rendition.json
  assets/<digest>-<name>.<ext>
  governance/reviews/REV-NNN.json
  governance/revocations/RVK-NNN.json
  PACKAGE.md · design-system/DESIGN.md    regenerable projections, never sealed
```

The revision is **in the file name**, so publishing `@r2` writes a new file and
*cannot* overwrite `@r1` — not by policy, by path. An asset carries the digest
of its own bytes, so different content can never occupy the same name.

### The two documents this skill authors

Both are Markdown: versioned YAML frontmatter (identity, relations, trace,
unknowns) plus a **fixed list of `##` sections**, once each, in order, none
empty. A section that genuinely does not apply is declared in
`not_applicable: {key: reason}` — silence is not closure, and the **essential**
sections admit no such claim.

| | `flow` (`workline.ui-flow/v1`) | `screen` (`workline.ui-screen/v1`) |
|---|---|---|
| Answers | how the journey runs | what one surface is |
| Frontmatter core | `actors`, `entry`, `nodes`, `edges` | `default_state`, `states[]`, `flow_refs`, `dependencies` |
| Sections | Goal and outcome · Preconditions and entry · Main journey · Alternatives and recovery · Permissions and privacy · Traceability | Purpose and context · Structure and content · Components and design-system deltas · Data, permissions and validation · States and transitions · Interaction and navigation · Responsive and adaptation · Localization · Accessibility · Edge cases and degradation · Traceability |
| Essential (no waiver) | Goal and outcome · Main journey · Traceability | Purpose and context · Structure and content · States and transitions · Interaction and navigation · Accessibility · Traceability |

### Reference grammar

`DES-001/SCR-001@r2#error` — package / artifact @ revision # state anchor. A
reference always pins the revision: **a later revision never invalidates a
reference already fixed**. Baselines are cited as `DES-001@r2` plus the digest
that seals them.

### Maturity: `outline` → `handoff`

`outline` is a legitimate state, not a failure — it exists precisely to hold
what is not yet decided. A document may declare `handoff` only when:

- its **applicable completeness** is closed (every section says something or is
  waived with a reason);
- it carries **no blocking unknown** (`unknowns[].blocking: true`);
- a flow **resolves its graph** — nodes with no edges are not a journey;
- every reference to **another package** is pinned in `external[]` by provider,
  revision and digest;
- no essential section answers with a **rendition and nothing else**: an
  approved image is not the current semantics and is not a WCAG conformance.
- a screen with a **visual** criterion preserves a local static preview of its
  default state; a purely interaction/non-visual screen does not fabricate a
  storyboard just to satisfy this gate.

### Governance: four independent dimensions

**Maturity** (`outline`/`handoff`), **review** (a `REV-*.json` that approves or
rejects an exact baseline *by digest*), **currentness** (derived from
`supersedes` — superseded warns and still executes) and **execution policy**
(whether the workspace demands approval) move **separately**. An approval is
never inherited: a new revision returns to `proposed`, and the only way to
forbid an intact revision is an explicit, audited revocation.

## Operations

Five semantic operations, all over the **same** package. `create` and `update`
are one route with a different compare-and-swap base, not two formats.

| Operation | Does | Writes |
|---|---|---|
| `create` | first revision of a package | manifest, baseline, artifacts, projections |
| `update` | next revision of an existing package | idem, over a declared base |
| `validate` | judges without writing: schemas, naming, references, maturity, closure | nothing |
| `render` | regenerates the projections | `PACKAGE.md`, `design-system/DESIGN.md` — never sealed |
| `record` | seals a governance decision about a revision that exists | `governance/reviews/` · `governance/revocations/` |

None of them may invent a layout or a schema of its own. There is no «direct
package», no parallel Markdown render and no side JSON: **one format, one
authority**.

## Canonical authority

The normative contract is the six published JSON Schemas under
[`../../schemas/design/`](../../schemas/design/) — manifest, baseline, flow,
screen, review, revocation — and the validators that implement them. The
built-in floor and **every** improvement bound to this role validate their
output against exactly those, with the same gates.

- A missing external improvement **never blocks the floor**: with nothing bound,
  the role resolves to this skill and the capability keeps working.
- A contributor extends the domain by **adding fields to a schema**, never by
  declaring a format of their own. Nobody redefines the canonical authority —
  not a bound skill, not a host, not a workspace.

## Boundary with Spec 014

The **transversal capability lifecycle belongs to Spec 014 and is not
reimplemented here**: skill descriptor, enable/disable lifecycle, the
`request` / `outcome` / `receipt` envelope, routing between direct and composed
paths, `off`, effects, and host-native projection are governed there.

This contract adds **only** what is proper to the design domain: fields,
validators and completeness. Where the two meet, Spec 014 decides the envelope
and this one decides the payload. Duplicating either side is the failure mode
being avoided.

### How it is invoked

Both routes reach the same dispatcher and each caller has a fixed row of
operations it may ask for. That contract is stated once, in
[`CONTRACT.md`](CONTRACT.md) — the same file the installed wrapper points at.
Nothing about invocation is restated here.

## CLI ↔ agent split

Explicit, and it is the whole point of the handshake:

- **The CLI owns** inventory, numbering, digests, validation, authorization and
  **writing**. It is the only thing that touches the filesystem.
- **The agent owns** exactly one step: authoring the **semantic content**. Its
  answer is *data to be validated*, never an instruction to be trusted.

Three stages, and only the third writes: `prepare` (what was read, where writing
is allowed, and an `input_digest` sealing the state seen) → `validate` (parse the
answer against that request; on survival, a preview and an `approval_digest`
over the exact bytes proposed) → `apply` (recompute the input digest, check the
approval still matches, publish all-or-nothing).

## Output

The package itself — new artifact files plus the revision that seals them. The
**loop** writes (through the CLI), never this skill on its own.

What this skill does **not** produce: design inside a spec or a plan document.
A spec carries `## Design references` (package, baseline, digest, path hint); a
plan carries the exact roots each phase or task consumes. Embedding the design
in the document is what the package exists to end.

## Retired path — `retired/unsupported`, and nothing else

The legacy path is **gone**: the `ui-design` binding, the `ui-spec` skill, the
spec's `## UI spec` section and the per-screen design SPECs that PLAN sessions
carried. `design` is the only identity and the package above the only format.

Presenting any of it — a binding or invocation naming a retired name, a `## UI
spec` section, a session design SPEC, an output of `ui-spec-generator` — is
reported **`retired/unsupported`**. It is never read as a contract, and never
satisfies a gate as evidence. There is **no alias, no dual-read, no importer, no
conversion, no migrate-on-touch and no bulk migration**: a design that is still
needed is **recreated** over the package from current sources.

What retirement does not do is destroy: every document already written stays
exactly where it is, byte for byte, readable by whoever opens it. Retiring an
input is not the same as deleting a record.

**`ui-spec-generator` is outside this topology.** It is not a dependency, not an
adapter and not a source of truth for anything here; nothing in Workline reads,
invokes or imports it. Whatever becomes of that repository is its own business —
cleaning it up is explicitly not part of this contract.

## Source

Requirement: `docs/specs/013-spec-estandarizar-ui-spec.md`. Contract and
rationale: the six schemas under [`../../schemas/design/`](../../schemas/design/).
