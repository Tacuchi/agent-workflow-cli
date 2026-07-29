# PLAN-MODE — what every Workline command does when the host is planning

Loaded only when the host reports it is in plan mode (signal `plan-mode`). Sixteen commands
used to carry a paragraph of this each; the rule was the same in all of them, so it is stated
once here.

## The rule

In plan mode a command **describes** and **writes nothing**. It resolves its input, states what
it would do and what it would touch, and stops:

- **Flow commands** (`spec-new`, `spec-refine`, `plan-new`, `plan-refine`, `plan-exec`, `quick`):
  describe the loop actions they would run — the gaps they would close, the questions they would
  ask, the phases they would execute, the files they would touch and the commits they would
  propose. No session is created, no loop is started, no document is written.
- **Direct surfaces** (`status`, `resume`, `persist`, `fix-git`, `generate-launch`,
  `workspace-init`, `export-*`): run their read-only `prepare` step if they have one and report
  what it returned. Never `validate`, never `apply`.

## Two things it does NOT change

1. **A read-only command is already safe.** `status` and `resume` write nothing in any mode;
   plan mode does not make them describe instead of answering.
2. **The gates that would fire still get named.** A size gate that would escalate, a spec that
   would be sent back to refine, a structural deviation that would stop execution — plan mode
   reports them as part of the description instead of hiding them until the real run.
