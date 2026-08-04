# PLAN-SPLIT-GATE — the canonical multi-plan split gate

Loaded when the plan may have to become more than one document (signal `split`).

## Split gate (multi-plan)

Resolves the **Plan splittable** gap (Delta 2) — the canonical definition for **both** plan loops (`plan-refine-loop` references it, never redefines it). It fires **only on clear signals** of independently deliverable tranches, and never on a borderline plan.

> **Which signals count, how many it takes, and therefore whether the offer appears at all, is not this document's call:** the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document. Recognizing a signal is judgment; counting them is a rule.

- **The offer** enters the batch as a **content question** (counts in the ≤3): the body shows the proposed cut in the **user's language** — per sibling, a name + slug, a 1-line scope, the phase mapping and the order. Declining marks the gap **exhausted** (no re-offer this run); a free-form answer adjusts the cut. The accepted cut is seeded into `CHECKPOINT` — a resume does **not** re-ask.
- **Anti-duplicate** (the `create_or_resume` spirit): sibling plans whose `## Origin` references this same spec/split are resumed, never minted a second time.
- **On acceptance** — same run, same session (one session per run, one HISTORY row): **all N siblings are elaborated complete** in this run — each gets the full Delta 1 schema and is immediately executable (`plan-exec` runs any plan; a seed without `## Tasks` would break that contract). Context pressure is absorbed by self-regulation (chassis § *Compact / resume*). Numbering follows [`PLAN-INPUT`](PLAN-INPUT.md) § *Numbering*, minted immediately before each write.
- **Sibling contract**: each `## Origin` records the shared source spec + `split (part i/N)` + the **siblings by path** + the order; `## Dependencies` (the existing optional section) carries the inter-plan order — **acyclic and advisory** (`plan-exec` does not enforce it; it only orients what to attack first).
- **Coherence gate, re-framed**: every spec acceptance criterion traces to **exactly one** sibling — a **complete, disjoint partition**; each sibling's Final behavior block (in `## Solution`) covers its subset; the union covers the spec. Spec-less plans anchor the partition to their own Final behavior block / `Validations`.
- **Closing action** on the split branch writes every sibling in the same run; the single-plan branch writes one document. Both are the same confirmation step, and its alternatives are the CLI's.
