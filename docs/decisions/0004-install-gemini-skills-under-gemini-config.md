---
status: accepted
date: 2026-11-18
---

# Install Gemini skills under `~/.gemini/config/skills`

Recorded on 2026-11-18 from the comment in `src/application/self/install-targets.ts`.

## Context and Problem Statement

The `gemini` target serves Antigravity (`agy`). Earlier releases installed the `w` skill in `~/.gemini/skills`.

## Considered Options

- Keep `~/.gemini/skills`
- Move to `~/.gemini/config/skills` and keep the old root for cleanup

## Decision Outcome

Chosen option: move to `~/.gemini/config/skills`. agy 1.0.x read `~/.gemini/skills` as its shared tier; agy 1.2.x reads only `~/.gemini/config/skills`.

### Consequences

- `~/.gemini/skills` stays listed as a legacy root, cleaned only with ownership proof.
