# @tacuchi/agent-workflow-cli

Agnostic runtime CLI for session-lifecycle workflows. Bundles the universal `agent-workflow` skill (35 skills + 17 commands + 7 hooks template) and supports multi-empresa parametrization via `profile.json` cascade. Pairs with optional company-specific plugins for legacy aliases.

## Install

```bash
npm install -g @tacuchi/agent-workflow-cli
```

The CLI exposes two binaries: `agent-workflow` (canonical) and `aw` (short alias).

## Bundled SKILL (v7.0.0+)

The published tarball bundles the universal `agent-workflow` SKILL under `skills/agent-workflow/`. Install it into your host's skill directory with `--target` (obligatorio desde v7.0.0):

```bash
# Specific host
agent-workflow self install-skill --target claude
agent-workflow self install-skill --target codex
agent-workflow self install-skill --target warp

# All detected hosts (requires --confirm-all)
agent-workflow self install-skill --target all --confirm-all
```

By default, the CLI clears any plugin cache for the target host before installing. Opt out with `--keep-cache`.

```bash
# Detect which hosts are present + which already have the SKILL
agent-workflow self detect-hosts

# Install hooks into ~/.claude/settings.json (claude only for now)
agent-workflow self install-hooks --target claude

# Dry-run
agent-workflow self install-skill --target claude --dry-run
```

## Multi-empresa via profile.json

The universal SKILL reads a `profile.json` to parametrize 10 sensitive skills (project-init, hub-init, doctor, migrate, rules, analyze-investigate, coding-standards, export-arq, export-report, refactor). Profile resolution cascade (highest precedence first):

1. `--profile <path>` flag (explicit)
2. `AW_PROFILE` env var
3. `~/.config/agent-workflow/profile.json` (user-level)
4. `<cwd>/.<namespace>/profile.json` (workspace-level)
5. Embedded `DEFAULT_PROFILE` (8 fields with agnostic defaults)

Schema (8 fields): `namespace` (kebab) · `company` · `claude_md_block` (`[A-Z][A-Z0-9_-]*`) · `mcp_databases[]` · `lexicon_path` · `examples_path` · `migrate_legacy_rules[]` · `custom_anchors[]`. See `skills/agent-workflow/references/profile-parametrization.md` for the per-skill contract.

Example QTC profile:

```json
{
  "namespace": "qtc",
  "company": "QuetalCompra",
  "claude_md_block": "QTC-PROJECT",
  "mcp_databases": [
    { "alias": "qtc-cert", "host": "10.0.0.10", "port": 5432, "database": "qtc_cert" },
    { "alias": "qtc-prod", "host": "10.0.0.11", "port": 5432, "database": "qtc_prod" }
  ],
  "lexicon_path": "profiles/lexico-qtc.md",
  "examples_path": "profiles/examples-qtc.md",
  "migrate_legacy_rules": [
    { "from": ".claude/sessions", "to": ".workflow/sessions", "scope": "anchor" }
  ],
  "custom_anchors": [
    { "anchor": "qtc:super-admin-bypass", "target": "profiles/anchors/qtc-super-admin-bypass.md" }
  ]
}
```

The QTC profile + legacy aliases ship in the `qtc-workflow-plugin` companion plugin (v4.0.0+).

### Override the source

Power users who want a specific revision can pass `--from`:

```bash
# Copy from a local checkout (skill development)
agent-workflow self install-skill --target claude --from /path/to/agent-workflow-cli/skills/agent-workflow
```

Flags:

- `--target <claude|codex|warp|oz|agents|all>` — obligatorio.
- `--confirm-all` — required when `--target all`.
- `--keep-cache` — skip the automatic plugin cache clear before install.
- `--force` — overwrite existing destination.
- `--dry-run` — preview without writing.

## Namespace resolution

Resolution order (first match wins):

1. `--namespace <name>` flag.
2. `AW_NAMESPACE` env var.
3. **Workspace auto-detect** (v1.2.0+): scan cwd for hidden folders matching `^\.[a-z][a-z0-9-]{1,30}$` containing a `sessions/` subdirectory. If exactly one match, use it.
4. `~/.config/agent-workflow/namespace` user config.
5. Default: `agent-workflow`.

For plugin workspaces with a single `.<namespace>/sessions/` directory, the CLI auto-detects the namespace without configuration.

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
