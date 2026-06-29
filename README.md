# @tacuchi/agent-workflow-cli

Agnostic runtime CLI for AI development workflows. Bundles the universal **`w`** skill set — a **stages + loops + artifacts** harness — and pairs with optional company-specific plugins for multi-empresa parametrization.

The CLI exposes two binaries: `agent-workflow` (canonical) and `aw` (short alias).

## Install

```bash
npm install -g @tacuchi/agent-workflow-cli
```

## The model — stages + loops + artifacts

The harness has three layers plus a permanent `docs/` zone:

- **Layer 1 · Commands** (`/w:*`) — the only thing the user invokes:
  - **SPEC** — `/w:spec-new` (single-pass draft) → `/w:spec-refine` (gap-driven loop) → `docs/specs/`.
  - **PLAN** — `/w:plan-new` → `/w:plan-exec` → `docs/plans/`.
  - **QUICK** — `/w:quick` — lightweight shortcut.
  - **EXPORTS** — `/w:export-scripts` · `export-manuals` · `export-diagrams` · `export-reports` (the only path that promotes artifacts to `docs/`).
  - **Bootstrap** — `/w:workspace-init` turns any folder into a workspace (1+ sources; no project/hub distinction).
- **Layer 2 · Loops** — the AI runs them whole: `spec-refine-loop` (chassis) · `plan-new-loop` · `plan-exec-loop` · `quick-loop`. Each loop is a **persistent goal** that runs until its success criteria are green (verification-first); gap-driven, with **structured-choice** lifecycle control (compact/close — `AskUserQuestion` on Claude Code, numbered markdown elsewhere) and resumable `CHECKPOINT`.
- **Layer 3 · Sessions + artifacts** — internal, ephemeral process state under `.workflow/sessions/` (`SESSION` · `CHECKPOINT` · `BACKLOG` · `SCRIPTS.sql` · `ANALYSIS-FILE` · `CONCLUSIONS` · `DECISION` · …). Sessions are slug-named folders, created by loops, never by the user.

**Pluggable capabilities.** Loops compose capability **roles** (`ui-design`, `sql`, `git`, `research`, `diagrams`, `overview`); the concrete skill bound to each role is resolved via `.workflow/skills.toml` (cascade: built-in default → `~/.workflow/skills.toml` → workspace). Inspect bindings with `aw skills` (advisory: it also warns when a bound skill is not installed in the standard skill roots — the binding itself is not auto-validated). Code/testing/writing conventions **and tool authoring** (`creating-tools`) are **not** roles — they're ambient skills the host auto-applies when present, independent of the workflow. Per-source launch scripts live under `.workflow/launch/` (machine-specific, gitignored); created tools live under `docs/tools/`.

**Invariants.** No auto-export (only `export-*` writes `docs/`); the spec and plan are documents, not artifacts; DB scripts-only (never executes DML/DDL); git-safe (verifies the per-source working branch before edits; proposes commits).

## Bundled SKILL

The published tarball bundles the universal skill set under `skills/w/`. Install it into your host with `--target` (required):

```bash
agent-workflow self install --target claude     # or: codex · warp · oz · agents
agent-workflow self install --target all --confirm-all
agent-workflow self detect-hosts                # which hosts are present + already have it
agent-workflow self install --target claude --dry-run
```

By default the CLI clears the target host's plugin cache before installing (opt out with `--keep-cache`) and removes legacy artifacts from a prior `agent-workflow`-named install — the old SKILL and the stale `/agent-workflow:*` slash commands (keep them with `--keep-legacy`).

### Per-target install matrix

`self install --target <host>` installs **SKILL + user-level slash commands + hooks** in one shot, scaled to what the host supports:

| Host | SKILL | User-level commands (`/w:*`) | Hooks |
|---|---|---|---|
| `claude` | `~/.claude/skills/w/` | `~/.claude/commands/w/<n>.md` | `~/.claude/settings.json` (JSON merge + backup) |
| `codex` | `~/.codex/skills/w/` | `~/.codex/commands/w/<n>.md` | skipped (config.toml not yet wired) |
| `warp` | `~/.warp/skills/w/` | skipped (uses rules/notebooks) | skipped (no hook system) |
| `oz` | `~/.agents/skills/w/` | skipped | skipped |
| `agents` | `~/.agents/skills/w/` | skipped | skipped |

For hosts where a layer is skipped, the SKILL is sufficient — the AI reads it and invokes `agent-workflow <subcommand>` directly.

Opt-out flags: `--skill-only`, `--no-commands`, `--no-hooks`. Override the source with `--from /path/to/skills/w`. Other flags: `--confirm-all` (required with `--target all`), `--keep-cache`, `--force`, `--dry-run`.

## Multi-empresa via profile.json

A `profile.json` parametrizes the bundled skills for a company (namespace, lexicon, MCP databases, custom anchors). Resolution cascade (highest precedence first):

1. `--profile <path>` flag
2. `AW_PROFILE` env var
3. `~/.config/agent-workflow/profile.json` (user-level)
4. `<cwd>/.<namespace>/profile.json` (workspace-level)
5. Embedded `DEFAULT_PROFILE` (agnostic defaults)

Companion plugins package this profile + optional custom skills.

## Namespace resolution

Workspace artifacts live under `.<namespace>/`. Resolution order (first match wins):

1. `--namespace <name>` flag
2. `AW_NAMESPACE` env var
3. **Workspace auto-detect** — a single hidden `^\.[a-z][a-z0-9-]{1,30}$` folder in cwd containing `sessions/`
4. `~/.config/agent-workflow/namespace` user config
5. Default: `workflow` (→ `.workflow/`)

## Commands (selected)

- `workspace-init` — scaffold a workspace (`.workflow/` + `docs/` taxonomy + WORKSPACE block + `skills.toml`).
- `skills` — show resolved capability → skill bindings.
- `sessions` / `session-create --type <research|refine|exec|quick>` / `session-close` / `session-resume` / `session-artifacts` — internal session lifecycle (used by the loops).
- `checkpoint-read` / `checkpoint-write` — `CHECKPOINT.md` handling.
- `sources` / `check-branch` / `set-working-branch` / `set-qa-branch` — multi-source git-safety (per-source base / working / QA branches).
- `git-flow <sync|to-qa|to-prod> [--source|--all] [--target] [--dry-run]` — run the per-source branch flows (sync working ← base, promote to QA, promote to prod) with conflict-pause; also surfaced as Project-tab actions.
- `release-data` — corpus reader backing the `export-*` skills.
- `self install-skill` / `self doctor` / `self update` / `mcp` — CLI maintenance.

Run `agent-workflow --help` (or `aw --help`) for the full list, or `agent-workflow <command> --help` for per-command flags.

## Versioning

Semantic Versioning. Major bumps are reserved for breaking changes to commands, flags, or output schemas. See `CHANGELOG.md`.

## License

Copyright © 2026 Jesús Loayza (Tacuchi)

Licensed under the **GNU Affero General Public License v3.0 or later** (`AGPL-3.0-or-later`) — see [`LICENSE`](LICENSE).

In plain terms: anyone — including companies — may use, study, modify, and share this software for free, even commercially. But any copy you distribute, and any modified version you run as a network service, must stay open under this same license. It can never be turned into a closed-source/proprietary product.
