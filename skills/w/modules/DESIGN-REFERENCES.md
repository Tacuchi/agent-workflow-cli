# DESIGN-REFERENCES — how a spec and a plan cite design instead of carrying it

Loaded when the run involves UI (signal `ui`).

The **UI unspecified** gap is resolved by the [`design`](../roles/design/ROLE.md)
capability over the **UI Design Package v1**. A spec and a plan **reference** a
design; neither contains one. The block below is all they carry.

## The reference block

```markdown
## Design references

- package: `DES-001@r4`
  baseline_hint: `docs/designs/007-design-alta-familia/baselines/DES-001-r004.json`
  digest: `sha256:<64 hex>`
```

- `package` pins **identity and revision**. `latest`, a folder slug, a bare
  `DES-001` or a title are rejected: each answers a different question next year
  than it does today.
- `baseline_hint` is a **location hint**, never the identity. A renamed dossier
  keeps the reference valid and reports the hint as stale.
- `digest` seals the exact bytes; one that no longer matches never resolves
  quietly.
- Several packages are several blocks. A package named in prose **without being
  pinned** is reported, not ignored.

**Never in the document**: Screen Specifications, flow graphs, state inventories,
region or component tables, mockups, embedded images. Those live in the package,
at their own revision — a document carrying them is a document whose design
cannot be superseded without editing it.

Publishing the package is the loop writing a composed deliverable through the
CLI, not graduating a session artifact (chassis § *docs/ boundary*).

## Evidence and lifecycle

`trace` marks each criterion `visual`, `interaction` or `not_visual`. Preview
only visual acceptance; interaction relies on states, semantics and implementation
proof, never a storyboard merely to satisfy format.

The CLI marks a delta **compact** only with an existing surface, ≤2 screens, and
no journey, rule, token, asset, external dependency, blocker or adaptation.
Compact publishes one `handoff` for PLAN to reuse. Otherwise it is **expanded**:
SPEC keeps `outline`; PLAN promotes only its consumed closure. The model authors
content, not this routing.

## SPEC — close the requirement at `outline`

1. **Reuse before minting.** `aw designs` lists what the workspace already has; a
   compatible baseline is reused rather than given a second identity.
2. **Classify the lifecycle.** Compact publishes `handoff` now; otherwise open
   `outline`, which may hold unknowns until PLAN promotes its implemented roots.
3. **Publish, then reference.** Citing a baseline that was never published is the
   dangling reference this contract removes.

`spec-new` only **records the need**; it mints nothing. The section sits right
before `## Decisions`.

## PLAN — promote the closure, pin the roots

1. **Read the spec's `## Design references`.** No section and a plan with screens
   means the spec never closed its design — a gap back to `spec-refine`, not
   something PLAN invents.
2. **Express what this plan implements as exact roots** — the flows, screens and
   screen states its phases will build.
3. **Compute the closure**: a flow reaches its nodes, a screen its flows, and both
   reach the rules, tokens and assets they depend on. It stops there. `flow_refs`
   is *not* followed — it is the inverse relation, and following it drags in
   designs the plan never consumes.
4. **Reuse a valid `handoff`, or promote exactly the missing closure.** A compact
   handoff from SPEC is already the plan's baseline, not work to repeat.
5. **Publish the revision**, then write the roots.

The plan declares its own `## Design references` — same block — after
`## Dependencies`, before `## Tasks`. **Its own, not a copy of the spec's**: that
is what lets a refine move this plan to `@r5` while a sibling stays on `@r4`. A
plan whose task pins a baseline it never declared resolves against nothing, and
says so.

Then each phase or task pins the exact roots it consumes:

```markdown
- [ ] T3.2 — Alta de familia desde el formulario · DES-001@r4 / SCR-002@r2#empty
```

`<package>@rN / <artifact>@rN[#state]`. Both revisions are mandatory; the anchor
is optional and only a screen has one. A phase whose tasks share one root may pin
it once at phase level. Never acceptable: naming `DES-001` without a revision —
`plan-exec` reports it instead of guessing. And a rendition never answers for a
root: an approved image is not the current semantics, nor a conformance claim.

## quick — read it, never rewrite it

`quick` **reads and validates** (`aw designs`, `aw designs --plan`); it changes
nothing a baseline seals — normative content, a maturity, an approval. A visual
tweak that turns out to need a new state or a redrawn journey **escalates with the
evidence it gathered**: `plan-refine` for the package, `spec-refine` when behavior
or acceptance moves. Editing it silently moves the revision while every consumer
stays pinned to the old digest.

## plan-refine — the delta, and only the delta

- **New revisions only for the artifacts the refine actually affects.** An
  untouched screen keeps its revision, maturity and digest.
- **Never re-point another consumer.** Two plans may pin the same baseline;
  publishing `@rN+1` for one leaves the other's reference exactly as it was.
- **Re-point only this plan** — its `## Design references` and the tasks whose
  artifacts moved. The spec's section is not touched: it records the baseline the
  *requirement* closed on.
- **Behavior or acceptance changed → `spec-refine` first.** Redrawing a journey,
  adding a state the requirement never described or moving an acceptance criterion
  is a functional change. Closing it here leaves the spec and the package
  disagreeing with no way to tell which is right.
