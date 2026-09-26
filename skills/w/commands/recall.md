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

1. `aw host-memory --json` — reads the other hosts' curated memory and writes nothing. Only Workline learnings come back; the rest is a count.
2. **Report every row of `hosts`**: which memories were read, and which are absent, keep none of their own, are disabled or unreadable, each with its reason. With no entries, say which case it is — no other host's memory was found (no row is `read`), or it was read and holds nothing about Workline yet — and carry on.
3. **Leave out working state** — a run log, a plan's progress, a session's status. Keep what holds beyond one run.
4. **Contrast each learning** into one of three states:
   - **possibly stale** — it carries a `stale` signal, or `aw <command> --help` or the installed doctrine contradicts it. Do not apply it;
   - **current** — it holds against them. Apply it;
   - **unverified** — nothing here can check it. Check it when its situation arises.
5. **Apply in this session** what is current and serves the work at hand: when its situation arises, act on it instead of researching again.
6. **Present each learning with its host and its date** (`date` null → say it carries none).
7. **Flag what two or more hosts found separately** as a possible Workline defect: say so, open no flow. Copies never count — an entry whose `provenance` is `copy` is the same finding as its original.
8. **Offer to save only what is current and absent** (`present_in_destination: false`): show what gets saved and where, `current_host.destination.path`. Canonical [option shape](../loops/CHASSIS.md#structured-choice-design--batching) and [host binding](../harness/HARNESS.md#harness-binding-matrix). Save nothing without confirmation.
9. **Save through the host's own channel** — the one `destination.channel` names, following that host's memory rules — with its `origin_mark` copied verbatim, so the next reading knows the copy.
10. **With `destination` null**, give its `destination_reason`: say this host has nowhere to save and offer nothing.

> **Never write another host's memory.** Only the current host's destination is ever touched, and only after the person confirms.

Degradation is declared, never silent: with no structured-choice, list the options as labeled markdown with the `flow` control among them.

## More context

`aw context-plan --command recall --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists.
