---
status: accepted
date: 2026-11-18
---

# Enforce PROD consent in the git-flow service

Recorded on 2026-11-18 from the comment in `src/application/git-flow-service.ts`.

## Context and Problem Statement

`git-flow` can push a source's working branch to its PROD branch. It is reachable from the CLI and from the TUI, and other callers may come later.

## Considered Options

- Ask for consent in each caller, the CLI and the TUI
- Check consent in the service that plans and runs the flow

## Decision Outcome

Chosen option: check consent in the service. A plan that pushes to a source's PROD branch runs only with the person's consent for exactly those sources, so no caller, including one written later, publishes without it.

### Consequences

- Without a matching consent, the service returns a preview instead of running.
- `--all` is refused for a flow that publishes to PROD.
