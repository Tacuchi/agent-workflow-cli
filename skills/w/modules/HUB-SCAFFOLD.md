# HUB-SCAFFOLD — runtime materialization and configuration

Loaded when the folder already has a materialized hub, or the user asks what
`hub-init` writes, ignores or reconciles on a re-run (signal `scaffold`).

## Versioning policy (CLI-owned `.gitignore`)

The first mutation (or `hub-init` without sources) writes only the runtime set, under the
hub lock. The sessions marker is created last.

- **Ignored** — `.<namespace>/sessions/` (machine-local live log), `.<namespace>/.lock`,
  `.<namespace>/processes.json`, `.<namespace>/launch/` and `docs/logs/` (legacy inert artifacts). The runtime block is
  added only when the root belongs to Git.
- **Not created by materialization** — `docs/**`, `skills.toml`, a hub block, launch
  files, HISTORY and Git metadata. Those belong to their owning command.

## Re-run: reconcile

A re-run adds no duplicate runtime entries and overwrites no manual configuration. When explicit
sources are supplied, it reconciles their metadata, branches and multiroot visibility; a
`hub` alias is reserved for the implicit root. It creates `skills.toml` only for a real
override.

The `.gitignore` runtime block merges idempotently; a read such as `status` or `resume` never
creates it or any other hub file.
