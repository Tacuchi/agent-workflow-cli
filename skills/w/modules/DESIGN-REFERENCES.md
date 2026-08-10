# DESIGN-REFERENCES — how a spec and a plan cite design instead of carrying it

Loaded when the run involves UI (signal `ui`).

The **UI unspecified** gap is resolved by the [`design`](../roles/design/ROLE.md)
capability over the **UI Design Package v1**. A spec and a plan **reference** a
design; neither contains one. The block below is all they carry.

A design is **simple** — one authored `DESIGN.md`, everything else derived — by
default, or an expanded **package** with a declared cause; that vocabulary and the
authoring contract live in
[`../roles/design/CONTRACT.md`](../roles/design/CONTRACT.md), and `aw designs`
prints each mode. Only two consequences reach a citing document: the block is
identical for both, and the mode decides which task-pin form is legal.

## The reference block

```markdown
## Design references

- package: `DES-001@r4`
  baseline_hint: `docs/designs/007-design-alta-familia/baselines/DES-001-r004.json`
  digest: `sha256:<64 hex>`
```

A simple design's hint is its `DESIGN.md`.

- `package` pins **identity and revision**. `latest`, a folder slug, a bare
  `DES-001` or a title are rejected: each answers a different question next year.
- `baseline_hint` is a **location hint**, never the identity. A renamed dossier
  keeps the reference valid and reports the hint as stale.
- `digest` seals the exact bytes; one that no longer matches never resolves
  quietly.
- Several designs are several blocks. One named in prose **without being pinned**
  is reported, not ignored.

**Never in the document**: Screen Specifications, flow graphs, state inventories,
region or component tables, mockups, embedded images. Those live at their own
revision — carrying them makes a design that cannot be superseded without editing
its consumer. Publishing is the loop writing a composed deliverable through the
CLI, not graduating a session artifact (chassis § *docs/ boundary*).

## SPEC — close the requirement at `outline`

1. **Reuse before minting.** `aw designs` lists what the workspace already has; a
   compatible baseline is reused rather than given a second identity.
2. **Classify the lifecycle.** Compact publishes one `handoff` for PLAN to reuse;
   otherwise open `outline`, which may hold unknowns until PLAN promotes its
   implemented roots.
3. **Publish, then reference.** Citing a baseline never published is the dangling
   reference this contract removes.

`spec-new` only **records the need**; it mints nothing. The section sits right
before `## Decisions`.

## PLAN — promote the closure, pin the roots

1. **Read the spec's `## Design references`.** No section and a plan with screens
   means the spec never closed its design — a gap back to `spec-refine`.
2. **Express what this plan implements as exact roots.**
3. **Compute the closure**: a flow reaches its nodes, a screen its flows, and both
   reach the rules, tokens and assets they depend on. It stops there. `flow_refs`
   is *not* followed — the inverse relation drags in designs nobody consumes.
4. **Reuse a valid `handoff`, or promote exactly the missing closure**, then
   publish the revision and write the roots.

The plan declares its own `## Design references` — same block — after
`## Dependencies`, before `## Tasks`, never a copy of the spec's: that is what
lets a refine move it to `@r5` while a sibling stays on `@r4`. A task pinning a
baseline its plan never declared resolves against nothing, and says so.

```markdown
- [ ] T3.2 — Alta de familia desde el formulario · DES-001@r4 / SCR-002@r2#empty
- [ ] T3.3 — Aviso de duplicado · DES-007@r1
```

`<package>@rN / <artifact>@rN[#state]` pins inside a **package**: both revisions
mandatory, the anchor optional and only on a screen, and a phase whose tasks share
one root may pin it once at phase level. `<package>@rN` alone pins the **root** —
the only form a **simple** design has, since there is nothing to point inside.
Asking a simple design for an artifact blocks and sends you to its root; a package
task pinning a whole revision is legitimate. A root pin walks no closure and
reaches no maturity, and still resolves identity, revision and digest, refuses a
revoked revision, and fails closed when the bytes moved. A rendition never answers
for a root: an approved image is not the current semantics, nor a conformance
claim.

## quick — read it, never rewrite it

`quick` **reads and validates** (`aw designs`, `aw designs --plan`); it changes
nothing a baseline seals — normative content, a maturity, an approval. A tweak
that needs a new state or a redrawn journey **escalates with the evidence it
gathered**: `plan-refine` for the package, `spec-refine` when behavior or
acceptance moves. Editing silently moves the revision while every consumer stays
pinned to the old digest.

## plan-refine — the delta, and only the delta

- **New revisions only for the artifacts the refine actually affects.** An
  untouched screen keeps its revision, maturity and digest.
- **Never re-point another consumer.** Two plans may pin the same baseline;
  publishing `@rN+1` for one leaves the other's reference as it was.
- **Re-point only this plan** — its `## Design references` and the tasks whose
  artifacts moved. The spec's section records the baseline the *requirement*
  closed on and is not touched.
- **Behavior or acceptance changed → `spec-refine` first.** Redrawing a journey,
  adding an undescribed state or moving an acceptance criterion is functional;
  closing it here leaves the spec and the design disagreeing with no way to tell
  which is right.
