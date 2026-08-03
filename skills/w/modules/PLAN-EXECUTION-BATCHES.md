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

Choose the maximal consecutive `continuous` ranges. A range is eligible only when all of these
are true:

1. Every dependency is already satisfied or is an earlier phase in the same range.
2. No phase result, proof, probe or human decision determines how a later phase must be built.
3. There is no unresolved question, live blocker, operative handoff or irreversible external
   action between its phases.
4. No intermediate commit, release, review or deployment is a required recovery boundary.
5. The combined change is coherent, recoverable and reviewable as one unit.

Anything else is `isolated`. If every phase is eligible, the whole plan is one batch. This is an
AI inference from observable facts, not a preference question; planning writes it without asking.
The PLAN gate fails when a phase is missing, duplicated, reordered or grouped across an
ineligible boundary.

## Runtime authority

Before editing, `plan-exec` repeats the inference over pending phases using the plan plus live
dependencies, branches, working trees, blockers and risks.
It may merge or split the declared batches without asking: current evidence wins.
The declared section remains planning structure;
the effective batches and any difference are recorded in `CHECKPOINT`.

A legacy plan without `## Execution batches` is valid. Execution infers effective batches and
records them in `CHECKPOINT`; it does not normalize the plan merely to add the section.

## Continuous cycle

For one effective batch:

1. Verify every affected source and seed one batch intent before editing.
2. Implement its phases in order. Mark local tasks done and set reached phases to `en ejecución`,
   but run no phase proof, test runner, build, lint or closing review between them.
3. After all implementation is written, run every phase proof in order, then the justified
   focused/risk checks and applicable cross-cutting validations. The last pending batch also runs
   the plan's final validation here, before Git.
4. Fix failures autonomously and rerun the affected checks. Review the whole batch diff once.
5. Only when every check, exit condition and review is green, flip all batch phases to `validada`,
   update `CHECKPOINT`, and enter the Git step.

This is the narrow exception to the chassis' per-phase artifact beat and clean-tree rule: the
batch is the execution boundary. Task checkboxes and phase states keep it resumable.

A real blocker or structural/functional deviation stops immediately. No unproven phase becomes
`validada`; the combined changes remain uncommitted and the actual states plus the unblocking
action go to `CHECKPOINT`.

## Git authorization

A green batch produces exactly one proposed commit per affected source. One consolidated approval
covers all of those commits. If the user explicitly pre-authorized commits conditional on every
batch check passing, record that authorization before editing and commit without another question.
A failed or unrun check never satisfies the condition and never creates a commit. For the last
pending batch, the same authorization also marks the fully validated plan `done` before committing,
so that final plan write is included in the source's single commit; there is no second completion
question or commit.
