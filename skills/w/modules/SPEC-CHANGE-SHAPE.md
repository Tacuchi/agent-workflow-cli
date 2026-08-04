# SPEC-CHANGE-SHAPE — same, split or replace

Loaded when the investigation may have changed the spec shape (signal `shape`).

## The two shape branches are not the same question

`split` and `replace` are different findings, so they ask different things and do different things — reusing one for the other asks about cardinality when what changed was purpose:

| Finding | What it asks | What it writes |
|---|---|---|
| **`split`** — independent functional outcomes discovered | cardinality: one spec, or several siblings | the original, rewritten reduced, **plus** one new file per extracted outcome |
| **`replace`** — the purpose itself changed | `Crear una nueva spec` \| `Reformular esta spec` | `Crear` → one **new** file, this spec untouched · `Reformular` → **no new file**: this same file, same number, same path |

## Change-shape gate

The investigation can reveal the draft's shape was wrong. Does the spec still carry **one** functional outcome, did its purpose survive, can the delivery be accepted as a unit? The verdict is **one of three shapes** — `same` | `split` | `replace` — each with its own branch; only the last two ask anything.

> **When it runs, and that it never travels inside the gap loop, is not this document's call:** the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document. Why it matters: a shape decision parked among the gap questions is erased by the next batch — or never asked at all, because a spec with no blocking gap leaves the loop before a batch is built.

- same outcome — more clarity, or more technical components → **`same`**: no shape question, keep refining this spec;
- independent functional outcomes discovered → **`split`** (below);
- purpose fundamentally changed → **`replace`** (below);
- refactor indispensable to the outcome → a consideration for `PLAN`, never its own spec; refactor with no functional change → out of the contract;
- evidence insufficient → **`same`** + the uncertainty recorded. Thin evidence never justifies a cut.

**Split criterion** — the one `spec-new` already uses ([`SPLIT-GATE.md`](SPLIT-GATE.md), `spec-new`'s `split` module), never a different one: divide **only** when each part can be refined, accepted and planned on its own. Repos, technologies, layers or teams are **secondary evidence**, never the reason.

**Split semantics (in place).** The offer enters the batch as a content question. On acceptance: the original **keeps its number/path**, rewritten reduced to its remaining outcome; each extracted outcome is minted with `aw next-number docs/specs` right before its write and is born **`status: draft`**. Siblings are **not** elaborated here — unlike the multi-plan gate, where `plan-exec` would break on a plan with no `## Tasks`; a draft spec is legitimate input to this very loop — so the run keeps refining the **reduced original** and reports `/w:spec-refine` as each sibling's next step. Every `## Origin` records "split from `docs/specs/NNN-spec-<slug>.md`" + the siblings **by path**. Closing action on this branch: `Guardar specs`.

**Replace semantics.** Its offer is its own — `Crear una nueva spec` | `Reformular esta spec`, **never** the split labels: what gets decided is which identity carries the new purpose. Recommend **a new spec** when the main functional outcome or the actor/consumer changed; **reformulating** when the user confirms this file is still the same unit of work and wants to keep its identity.

- **New spec:** this one is **preserved**, its purpose never silently rewritten; the new one is minted with `aw next-number docs/specs`, born **`status: draft`**, its `## Origin` recording the origin spec, the replaced purpose and the user's decision. Its path goes to the `CHECKPOINT`; the run closes reporting `/w:spec-refine <new path>` as the next step.
- **Reformulate:** same number/path, the work treated as `refining` while rewritten; baseline, gap classification and the *ready-for-plan gate* run again over the new purpose; `status` is stamped only on the save that follows the passing gate, and the material decision lands in `## Decisions`.

**Every branch has a way out that changes nothing.** The `flow` control present on every structured-choice (chassis) is that exit here: `Cerrar` closes the run **without applying the shape change** — no sibling minted, no spec reformulated, the document untouched and the decision recorded in `CHECKPOINT` as declined. And no branch writes a file without the user's confirmation: minting siblings and minting a replacement both go through the same confirm-before-write rule as an in-place save.

Neither branch adds a `superseded` status or archives the replaced spec: a historical close needs its own runtime contract, out of scope here.
