# @tacuchi/agent-workflow-cli

Agnostic runtime CLI for session-lifecycle workflows. Pairs with the qtc-* family of plugins (and other namespace ecosystems) to provide commands like `sessions`, `session-create`, `session-close`, `checkpoint-write`, `plugin-doctor`, `auto-plan-decide`, and more.

## Install

```bash
npm install -g @tacuchi/agent-workflow-cli
```

The CLI exposes two binaries: `agent-workflow` (canonical) and `aw` (short alias).

## Bundled skill manager (v2.0.0+)

The published tarball bundles the `agent-workflow-manager` skill under `skills/agent-workflow-manager/`. Install it into your Claude Code skills directory with:

```bash
agent-workflow self install-skill
```

This copies the bundled skill to `~/.claude/skills/agent-workflow-manager/`. No network required.

### Override the source

Power users who want a specific revision (e.g., bleeding-edge from the upstream repo) can pass `--from`:

```bash
# Clone from a git URL
agent-workflow self install-skill --from https://github.com/Tacuchi/agent-workflow-manager.git

# Copy from a local checkout
agent-workflow self install-skill --from /path/to/agent-workflow-manager
```

Flags:

- `--force` — overwrite an existing destination.
- `--dry-run` — preview without writing.

## Namespace resolution

Resolution order (first match wins):

1. `--namespace <name>` flag.
2. `AW_NAMESPACE` env var.
3. **Workspace auto-detect** (v1.2.0+): scan cwd for hidden folders matching `^\.[a-z][a-z0-9-]{1,30}$` containing a `sessions/` subdirectory. If exactly one match, use it.
4. `~/.config/agent-workflow/namespace` user config.
5. Default: `agent-workflow`.

For qtc-* workspaces (with `.qtc/sessions/` present), the CLI auto-detects `qtc` without configuration.

## Commands (selected)

- `sessions` / `session-create` / `session-close` / `session-resume` / `session-artifacts` — session lifecycle.
- `checkpoint-read` / `checkpoint-write` — CHECKPOINT.md handling.
- `plugin-doctor` — plugin health check.
- `auto-plan-decide` — heuristic for skip/lite/full planning.
- `topic-change-check` — detect when an OBJETIVO drifts.
- `release-data` / `graduate` — release/handoff helpers.
- `self install-skill` / `self namespace` / `self doctor` / `self update` — CLI maintenance.

Run `agent-workflow --help` (or `aw --help`) for the full list, or `agent-workflow <command> --help` for per-command flags.

## Versioning

Semantic Versioning. Major bumps are reserved for breaking changes to commands, flags, or output schemas. See `CHANGELOG.md`.

## License

MIT — see `LICENSE`.
