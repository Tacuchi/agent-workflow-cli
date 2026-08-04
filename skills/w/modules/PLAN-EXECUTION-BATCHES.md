# PLAN execution batches

This module is the single contract for grouping PLAN phases into execution units. `plan-new`
and `plan-refine` declare the intended units; `plan-exec` infers them again from live state.

## Plan interface

Every new or refined plan carries this core section after `## Tasks`:

```markdown
## Execution batches

- B1 · continuous · F1-F3
- B2 · isolated · F4
```

Rows use sequential `B1..Bn` ids and form a complete, disjoint phase partition in order. A batch
contains consecutive phases and uses one of two exact modes:

- `continuous` — implement every phase first; validate and review the combined diff at batch
  close; then create one commit per changed Git source.
- `isolated` — the traditional cycle for one phase. It is still a batch, so the same state,
  validation, review and Git rules apply at its close.

The phase contracts, dependencies, risks and open questions are the reproducible evidence.

## Inference

Choose the maximal consecutive `continuous` ranges: a range stays eligible while nothing observable
breaks it. Anything else is `isolated`; if every phase is eligible, the whole plan is one batch.

> **Which facts break eligibility, and what one of them costs, is not this document's call:** the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document. It emits the closed vocabulary of those facts at the boundary that asks for them.

This is an inference from observable facts, not a preference question. The PLAN gate fails when a
phase is missing, duplicated, reordered or grouped across an ineligible boundary.

## Runtime authority

Before editing, `plan-exec` repeats the inference over pending phases using the plan plus live
dependencies, branches, working trees, blockers and risks: current evidence wins over the declared
partition. The declared section remains planning structure;
the effective batches and any difference are recorded in `CHECKPOINT`.

A legacy plan without `## Execution batches` is valid. Execution infers effective batches and
records them in `CHECKPOINT`; it does not normalize the plan merely to add the section.

## Continuous cycle

The batch — not the phase — is the execution boundary: implementation runs straight through, and
every proof, check, review and state flip happens once at its close. This is the narrow exception to
the chassis' per-phase artifact beat and clean-tree rule, and task checkboxes plus phase states are
what keep it resumable. The order of those closing steps is the CLI's, per the note above.

A real blocker or structural/functional deviation stops immediately. No unproven phase becomes
`validada`; the combined changes remain uncommitted and the actual states plus the unblocking
action go to `CHECKPOINT`.

## Git authorization

A green batch produces exactly one proposed commit per affected source. Approving is not committing,
and a check that never ran is not a green batch. For the last pending batch the same approval also
covers marking the fully validated plan `done`, so that final write rides in the source's single
commit instead of asking a second time.

> **What proves the batch was green is not this document's call:** the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document — positionally, behind the delegated validation and the review, neither of which a narration can pass.
