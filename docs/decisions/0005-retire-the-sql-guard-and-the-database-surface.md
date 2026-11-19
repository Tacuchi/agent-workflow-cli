---
status: accepted
date: 2026-11-18
---

# Retire the SQL guard and the database surface

Recorded on 2026-11-18 for version 33.0.0. Supersedes [0002](0002-the-sql-guard-fails-closed.md).

## Context and Problem Statement

The CLI carried its own database surface: a read-only executor, a connection registry, MCP servers for database tools and for structured choice, a `--catalog` check in `export-scripts`, and a `PreToolUse` hook that blocked SQL mutations sent through any host's `execute_sql` tool. Hosts already reach databases through their own MCP servers, and the rule that the agent never runs DML or DDL lives in the flows, which ship migrations as files a person applies. The surface kept a dependency tree, two doctor categories and two host-run surfaces alive for little use.

## Considered Options

- Keep the guard and the database tools
- Keep only the guard, as a host-wide safety net
- Retire the guard and the whole database surface

## Decision Outcome

Chosen option: retire the guard and the whole database surface. `aw mcp`, `aw tool`, `aw hook` and `aw self mcp` leave the CLI, `export-scripts` loses `--catalog`, and the hook template keeps only `SessionStart`.

### Consequences

- An invocation of a retired command answers like an unknown command: exit 1, never the exit 2 a host treats as "block". A host not yet reinstalled that still runs the old `PreToolUse` hook gets that answer; on Claude Code under Windows without Git Bash a shell hook that exits 1 blocks the tool until `aw self install-hooks` removes the entry.
- `aw self install-hooks` already removes the entries the CLI owns from every event, so reinstalling cleans the old hook on Claude Code, crush and kimi. On agy and Codex the old entry is removed by hand.
- The CLI no longer reads or writes connection files, and `aw doctor` reports no MCP or authentication category.
- The flows keep the rule: research reads through the host's own MCP, read-only, and migrations are delivered as scripts in `docs/scripts/`.
