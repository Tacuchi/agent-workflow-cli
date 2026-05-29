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
# Specific host (alias 'install' = 'install-skill' desde v7.0.3)
agent-workflow self install --target claude
agent-workflow self install --target codex
agent-workflow self install --target warp

# All detected hosts (requires --confirm-all)
agent-workflow self install --target all --confirm-all
```

By default, the CLI clears any plugin cache for the target host before installing. Opt out with `--keep-cache`.

### Per-target install matrix

Since v7.0.2+v7.0.4, `self install --target <host>` installs **SKILL + user-level slash commands + hooks** in a single shot. The full set varies per host based on what the host supports:

| Host | SKILL | User-level commands (`/agent-workflow:*`) | Hooks |
|---|---|---|---|
| `claude` | `~/.claude/skills/agent-workflow/` | `~/.claude/commands/agent-workflow/<n>.md` | `~/.claude/settings.json` (JSON merge + backup) |
| `codex` | `~/.codex/skills/agent-workflow/` | `~/.codex/commands/agent-workflow/<n>.md` | skipped (config.toml format not yet wired) |
| `warp` | `~/.warp/skills/agent-workflow/` | skipped (uses rules/notebooks, not slash commands — DEC-W3) | skipped (no hook system — DEC-W4) |
| `oz` | `~/.agents/skills/agent-workflow/` | skipped (same as Warp) | skipped (same as Warp) |
| `agents` | `~/.agents/skills/agent-workflow/` | skipped | skipped |

For hosts where a layer is skipped, the SKILL is sufficient — the AI reads the SKILL contents and invokes CLI commands directly via `agent-workflow <subcommand>`.

Opt-out flags for granular control:

- `--skill-only` → only the SKILL (legacy v7.0.0/v7.0.1 behavior).
- `--no-commands` → SKILL + hooks, no user commands.
- `--no-hooks` → SKILL + commands, no hooks merge.

```bash
# Detect which hosts are present + which already have the SKILL
agent-workflow self detect-hosts

# Install hooks separately (claude only for now)
agent-workflow self install-hooks --target claude

# Dry-run
agent-workflow self install --target claude --dry-run
```

## Multi-empresa via profile.json

The universal SKILL reads a `profile.json` to parametrize 10 sensitive skills (project-init, hub-init, doctor, migrate, rules, analyze-investigate, coding-standards, export-arq, export-report, refactor). Profile resolution cascade (highest precedence first):

1. `--profile <path>` flag (explicit)
2. `AW_PROFILE` env var
3. `~/.config/agent-workflow/profile.json` (user-level)
4. `<cwd>/.<namespace>/profile.json` (workspace-level)
5. Embedded `DEFAULT_PROFILE` (8 fields with agnostic defaults)

Schema (8 fields): `namespace` (kebab) · `company` · `claude_md_block` (`[A-Z][A-Z0-9_-]*`) · `mcp_databases[]` · `lexicon_path` · `examples_path` · `migrate_legacy_rules[]` · `custom_anchors[]`. See `skills/agent-workflow/references/profile-parametrization.md` for the per-skill contract.

Example profile (replace `acme` with your company namespace):

```json
{
  "namespace": "acme",
  "company": "Acme Corp",
  "claude_md_block": "ACME-PROJECT",
  "mcp_databases": [
    { "alias": "acme-stage", "host": "10.0.0.10", "port": 5432, "database": "acme_stage" },
    { "alias": "acme-prod", "host": "10.0.0.11", "port": 5432, "database": "acme_prod" }
  ],
  "lexicon_path": "profiles/lexico-acme.md",
  "examples_path": "profiles/examples-acme.md",
  "migrate_legacy_rules": [
    { "from": ".claude/sessions", "to": ".workflow/sessions", "scope": "anchor" }
  ],
  "custom_anchors": [
    { "anchor": "acme:super-admin-bypass", "target": "profiles/anchors/acme-super-admin-bypass.md" }
  ]
}
```

Companion plugins package this profile + optional legacy aliases + custom skills. The QTC plugin (`qtc-workflow-plugin@v4.0.0+`) is a reference implementation.

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

Copyright © 2026 Jesús Loayza (Tacuchi)

Licensed under the **GNU Affero General Public License v3.0 or later** (`AGPL-3.0-or-later`) — see [`LICENSE`](LICENSE).

In plain terms: anyone — including companies — may use, study, modify, and share this software for free, even commercially. But any copy you distribute, and any modified version you run as a network service, must stay open under this same license. It can never be turned into a closed-source/proprietary product.
