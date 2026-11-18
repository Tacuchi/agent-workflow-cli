---
status: accepted
date: 2026-11-18
---

# The SQL guard fails closed

Recorded on 2026-11-18 from the comments in `src/cli/main.ts` and `src/cli/full-cli.ts`.

## Context and Problem Statement

The host runs `agent-workflow hook sql-mutation-guard` before an agent's `execute_sql` call. The host blocks the call only when the hook exits 2. Any other exit, including a crash, lets the call through.

## Considered Options

- Treat a guard that cannot evaluate like any other failed command, with exit 1
- Exit 2 whenever the guard cannot load, parse or evaluate the call

## Decision Outcome

Chosen option: exit 2 whenever the guard cannot evaluate. A guard that cannot evaluate fails closed, or any crash would let the mutation through.

### Consequences

- The entry point catches a failed load of the full CLI and exits 2 for the guard.
- The guard runs even without a hub, because it protects user-level connections.
