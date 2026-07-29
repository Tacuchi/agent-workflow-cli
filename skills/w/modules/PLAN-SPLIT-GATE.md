# PLAN-SPLIT-GATE — the canonical multi-plan split gate

Loaded when the plan may have to become more than one document (signal `split`).

## Split gate (multi-plan)

Resolves the **Plan splittable** gap (Delta 2) — the canonical definition for **both** plan loops (`plan-refine-loop` references it, never redefines it). It fires **only on clear signals** (≥2 of: tranches independently executable/deliverable · no shared deps/risk between tranches · different requested moments/priorities · the plan far exceeds S-complexity phases · the user asked for staging); borderline → **one plan, no question**. It can be assessed during decomposition or at the coherence gate, always **before** `Guardar`.

- **The offer** enters the batch as a **content question** (counts in the ≤3): the body shows the proposed cut in the **user's language** — per sibling, a name + slug, a 1-line scope, the phase mapping and the order. Labels: `Dividir en varios planes` (recommended when the signals hold) | `Un solo plan`. Declining marks the gap **exhausted** (no re-offer this run); a free-form answer adjusts the cut. The accepted cut is seeded into `CHECKPOINT` — a resume does **not** re-ask.
- **Anti-duplicate** (the `create_or_resume` spirit): if sibling plans whose `## Origin` references this same spec/split already exist, the recommended option becomes resuming them (`/w:plan-refine` / `/w:plan-exec` semantics) — never a second set.
- **On acceptance** — same run, same session (one session per run, one HISTORY row): **all N siblings are elaborated complete** in this run — each gets the full Delta 1 schema and is immediately executable (`plan-exec` runs any plan; a seed without `## Tasks` would break that contract). Context pressure is absorbed by self-regulation (chassis § *Compact / resume*). Numbering: `aw next-number docs/plans` **immediately before each write** — numbers come out consecutive, so every sibling path is known after the first mint.
- **Sibling contract**: each `## Origin` records the shared source spec + `split (part i/N)` + the **siblings by path** + the order; `## Dependencies` (the existing optional section) carries the inter-plan order — **acyclic and advisory** (`plan-exec` does not enforce it; it only orients what to attack first).
- **Coherence gate, re-framed**: every spec acceptance criterion traces to **exactly one** sibling — a **complete, disjoint partition**; each sibling's Final behavior block (in `## Solution`) covers its subset; the union covers the spec. Spec-less plans anchor the partition to their own Final behavior block / `Validations`.
- **Closing action** on the split branch: `Guardar planes` (the single-plan branch keeps `Guardar plan`).
