---
status: accepted
date: 2026-11-18
---

# Never arm Codex hooks from the installer

Recorded on 2026-11-18 from the comment on the Codex host in `src/domain/harnesses.ts`.

## Context and Problem Statement

`self install` writes hooks for the hosts that accept them. Codex reads hooks from `~/.codex/hooks.json`, in the same shape as Claude Code. But Codex arms a new or changed hook only after an interactive human review, which it records as `trusted_hash` in `[hooks.state]`.

## Considered Options

- Write the hooks file and the `trusted_hash` that arms it
- Leave Codex hooks unmanaged and state why

## Decision Outcome

Chosen option: leave Codex hooks unmanaged. Writing the file does not arm a hook, and forging that hash would forge the person's security decision.

### Consequences

- The Codex host is declared with `managed: false` and a caveat that names the review.
- The `w` skill still works in Codex; the CLI commands stay callable by hand.
