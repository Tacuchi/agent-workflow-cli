# PLAN-REFINE-SPLIT — splitting a plan that already exists

Loaded when an existing plan may have to be split in place (signal `split`).

## Split gate — refine semantics

The gate itself — signals, offer, anti-duplicate, sibling contract, partition — is defined **once** in [`PLAN-SPLIT-GATE.md`](PLAN-SPLIT-GATE.md), `plan-new-loop`'s `split` module (this flow's guaranteed load already includes that file); this loop only adds the **in-place semantics** of splitting an existing plan:

- The original plan **keeps its number/path**: it is rewritten **reduced** to its remaining tranche (in place, with confirmation). The extracted tranches become newly minted sibling plans (`aw next-number docs/plans` immediately before each write); their `## Origin` records "split from `docs/plans/PPP-plan-<slug>.md`" + the source spec + the siblings by path.
- The gate also fires on **partially executed** plans. **Completed tasks (`- [x]`) never move to a sibling** — execution history stays anchored to the original path (plan-exec sessions' `## Origin` keep resolving); only pending work is extracted.
- The split is recorded in `## Refinement decisions` (what moved where + why); original + siblings together keep the **complete, disjoint partition** of the spec criteria (spec-less: the Delta 2 degradation applies).
- **Closing action** on the split branch: `Guardar planes` (edit the original reduced + write the extracted siblings); the normal branch keeps `Guardar plan refinado`.
