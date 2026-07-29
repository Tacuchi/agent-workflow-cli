# WORKSPACE-SCAFFOLD — what init versions, ignores and prunes

Loaded when the folder already has a workspace, or the user asks what `workspace-init` writes,
ignores or removes on a re-run (signal `scaffold`).

## Versioning policy (CLI-owned `.gitignore`)

Init writes and owns the full set.

- **Ignored** — `.workflow/sessions/` (machine-local live log), `.workflow/.lock`,
  `.workflow/processes.json`, `.workflow/launch/`, `docs/logs/` and, when there are external
  sources, `.claude/settings.local.json*` / `.codex/config.toml*` (the patterns cover the
  `.bak.<epoch>` backups).
- **Versioned** — `.workflow/skills.toml`, `docs/**` (the deliverables) and
  `.workflow/HISTORY.md`, the durable record: `aw session-close` upserts each closed session's
  row there.

## Re-run: reconcile + prune

A re-run adds no duplicate entries and overwrites no manual configuration. It prunes the legacy
upfront scaffold:

- `.gitkeep`-only taxonomy folders and stray `.gitkeep` files;
- an empty `docs/logs/`;
- a released `.workflow/.lock` leftover.

The `.gitignore` is completed to the current set — entries merge under the existing header, never
duplicated.
