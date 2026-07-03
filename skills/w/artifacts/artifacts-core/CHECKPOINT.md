# CHECKPOINT.md — session resume state (common)

> What it is: the live resume state of a session — lets the loop resume exactly where it left off.
> **Live log (artifact-first):** `Pending / Next` = the intent (what is about to be done, seeded BEFORE executing); `Completed` = the result (AFTER). Updated at every gap/phase boundary, not only on `Compactar`/`Cerrar`.
> Owned by: **every session** (`refine` · `exec` · `quick`). Persisted **always** on close/compact (the resume key), unlike `BACKLOG`, which is written only when something is deferred.

## Contract (hard rules)

1. **Fixed headings, exactly these three**: `## Completed` · `## Pending / Next` · `## Open questions` (plus the optional ones below).
2. **Update in place — NEVER duplicate a section.** Every update edits the existing section's content; appending a second `## <same heading>` is a contract violation.
3. New entries go at the top of their section (most recent first) or extend an existing bullet — each section stays a single block.

## Completed
What already happened: finished phases/tasks/gaps with their outcome (ref: plan-doc `docs/plans/PPP-plan.md`, the spec's gaps, or `TASKS.md` if the session created its own split). Fold the key context a resume needs (settled decisions, discoveries) into these bullets.

## Pending / Next
The intent: what remains and what comes immediately next (seeded BEFORE executing — artifact-first). A resume starts here.

## Open questions
Live doubts not yet resolved (ideally "None"). Deferred ones move to the session's `BACKLOG` or the flow doc's `## Open questions`.

### Optional sections

- `## Excluded` — phases/tasks explicitly excluded, with reason (the `aw status` dashboard reads it for the discarded list).
- The `checkpoint-write` hook (PreCompact/SessionEnd) may write a **machine snapshot** with its own headings (`Last action`, `Next step`, `Files touched`, `Refs`, …) and `_[AI: …]_` placeholders — complete the placeholders; the loop-owned contract above still governs what the loop writes.
