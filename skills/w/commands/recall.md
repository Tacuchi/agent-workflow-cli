---
description: Use when the user asks what other hosts learned about Workline, to apply what still holds and offer to save it.
argument-hint: "(none)"
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# recall — learnings from the other hosts

Runs only when the person invokes it, never at session start. No loop, no session, no `docs/`.

## Run

1. `aw host-memory --json` writes nothing; unrelated topics return a count.
2. **Report every row of `hosts`** with its reason (read, absent, empty, disabled, unreadable). With no entries distinguish: no other host's memory was found (no row is `read`), or it was read and holds nothing about Workline yet.
3. **Leave out working state** (run logs, plan progress, session status); retain reusable learnings.
4. **Contrast each learning** into one of three states:
   - **possibly stale** — it carries a `stale` signal, or `aw <command> --help` or doctrine contradicts it. Do not apply;
   - **current** — it holds against them. Apply it;
   - **unverified** — nothing here can check it. Check it when its situation arises.
5. Apply current, relevant learnings in this session: act on it instead of researching again.
6. **Present each learning with its host and its date** (`date` null → say it carries none).
7. **Flag what two or more hosts found separately** as a possible Workline defect: say so, open no flow. Copies never count (`provenance: copy`).
8. **Offer to save only what is current and absent** (`present_in_destination: false`): show what gets saved and where (`current_host.destination.path`). Use canonical [options](../loops/CHASSIS.md#structured-choice-design--batching) and [binding](../harness/HARNESS.md#harness-binding-matrix). Save nothing without confirmation.
9. Save via `destination.channel` under host rules with its `origin_mark` copied verbatim.
10. If `destination` is null, give `destination_reason`: say this host has nowhere to save and offer nothing.

> **Never write another host's memory.** Write here only after confirmation.

Without structured-choice, use labeled Markdown options including `flow`.

## More context

`aw context-plan --command recall --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists.
