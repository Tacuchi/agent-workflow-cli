# SPLIT-GATE — one deliverable, or several siblings

Loaded when the prompt may hold more than one independent outcome (signal `split`).

## Split gate (multi-spec)

Right after the reconnaissance and **before writing anything**, assess whether the prompt bundles
**several independent outcomes**. The unit is the **functional outcome**, not the technical
boundary: distinct repos, a frontend/backend pair, several microservices, a migration plus the
code it enables — all **secondary evidence**, never on their own a reason to divide.

**Divide only when each part is a result that can be refined, accepted and planned on its own** —
its own purpose, its own acceptance criteria, worth delivering even if the other part is dropped.
The gate fires **only on clear signals** (>=2 of: independent deliverables/goals · explicit
enumeration of distinct features · different requested moments or order · users or value that do
not depend on each other). Borderline, or evidence too thin to tell → **one spec, no question**:
the hypothesis goes to `## Assumptions` and the doubt to `## Open questions`.

It applies only to a **raw user prompt** (direct invocation, or the `plan-new` mode-3 handoff); it
**never fires** on the reuse entries — the quick escalation and the `persist` adoption arrive
already scoped to one objective.

- **The offer** — the command's **only** interaction: **one** structured-choice (<=2 content
  questions + the `flow` control; `Cerrar` = abort, nothing is written yet). The question body
  shows the proposed cut in the **user's language**: per part, a name + slug, a 1-line scope and
  the suggested order. Labels: `Dividir en varias specs` (recommended when the signals hold) |
  `Una sola spec`. A free-form answer adjusts the cut (merge/rename/drop parts); if one part
  remains, proceed as a single spec.
- **The second content question** is allowed **only** for a functional ambiguity with two
  incompatible readings that would change the number of specs (or leave the requested outcome
  unidentifiable). Anything smaller — confirming an observable technology, closing an
  implementation detail, raising confidence from medium to high — is **not** asked: it goes to
  `## Assumptions` or `## Open questions`.
- **On acceptance** — still single-pass: the cut comes from the prompt plus the reconnaissance
  already done, never from a second look. Per part, mint with `aw next-number docs/specs`
  **immediately before each write**, then write that draft. Numbers come out consecutive, so every
  sibling path is known after the first mint.
- **Sibling contract**: each `## Origin` records the shared prompt + `split (part i/N)` + the
  **siblings by path** + the suggested order; each `## Scope` Out points to the sibling that owns
  the excluded part. Cross-reference by path, never by bare number.
- **Report**: list the N files and suggest the next step per spec (`/w:spec-refine` on the first —
  each sibling refines and plans at its own moment).
