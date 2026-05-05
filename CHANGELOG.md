# Changelog

All notable changes to `@tacuchi/agent-workflow` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-05-DD

First stable release. The CLI is now namespace-agnostic and reusable beyond the `qtc-*` plugin family.

### ⚠ BREAKING CHANGES

- **Default namespace changed.** Previous default behavior wrote to `~/.qtc/...` and `.qtc/sessions/`. The new default namespace is `agent-workflow`, so paths become `~/.agent-workflow/...` and `.agent-workflow/sessions/`. To preserve previous behavior, set `AW_NAMESPACE=qtc` (recommended for qtc-* plugin users) or pass `--namespace qtc` per invocation.
- **Env var renamed:** `QTC_AGENT_WORKFLOW_BIN` → `AW_AGENT_WORKFLOW_BIN`.
- **Env vars renamed:** `QTC_SQL_GUARD` / `QTC_SQL_GUARD_ALLOW` → `AW_SQL_GUARD` / `AW_SQL_GUARD_ALLOW`.
- **MCP guard patterns no longer hardcoded.** The `hook sql-mutation-guard` PreToolUse hook now reads patterns from `runtime.mcpGuards.sqlMutation` in the runtime config JSON. Guard is disabled when no config is provided. qtc-* plugins must ship a runtime config with the qtc-cert/qtc-prod patterns.
- **Plugin-doctor expectations changed.**
  - `expectedScripts` input field removed (Python era ended).
  - `scripts` output field removed.
  - Expected MCP servers now read from `runtime.expectedMcpServers` (was hardcoded to `["qtc-cert", "qtc-prod"]`).
- **Block markers parametric.** `parseProjectBlock` and `renderProjectBlock` now accept optional `markers: ProjectBlockMarkers` and `historicoPath` parameters. Defaults still produce `<!-- QTC-PROJECT-START -->` and `.qtc/HISTORY.md` for legacy callers, but services that pass `paths.blockMarkers()` will get namespace-aware markers.
- **CLI exit code change:** Invoking `agent-workflow` with no arguments now exits 0 (was 1). This avoids "red" rendering in terminals that interpret non-zero exit as an error.

### Added

- `--namespace <name>` flag (or env `AW_NAMESPACE`) for runtime namespace selection. Resolution order: flag > env > `~/.config/agent-workflow/namespace` file > default `agent-workflow`.
- `Namespace` branded type with kebab-case validation (`^[a-z][a-z0-9-]{1,30}$`).
- `PathsService` central path resolver with namespace-aware paths.
- Runtime config schema extended with optional fields: `schemaVersion`, `displayName`, `mcpGuards.sqlMutation`, `expectedMcpServers`, `slashCommands.{migrate,projectInit,hubInit,resume,session}`.
- Interactive TTY menu when `agent-workflow` is invoked without arguments. Choices: Doctor / Update / Help / Exit.
- `self` subcommand family:
  - `self namespace` — print resolved namespace and source.
  - `self doctor` — report CLI version, namespace, paths, runtime config, skill install status.
  - `self update` — run `npm install -g @tacuchi/agent-workflow@latest` with optional TTY confirm.
  - `self install-skill` — STUB; full implementation deferred to sub-project 2 (the agent-workflow skill repo).

### Changed

- All hardcoded `.qtc/` and `~/.qtc/` paths in services replaced with `PathsService` calls.
- All `[qtc-core]` / `[qtc-dev]` message prefixes replaced with `runtime.displayName ?? "agent-workflow"`.
- Help text and `package.json` description genericized.
- Log filename `qtc-utils.log` renamed to `agent-workflow.log`.

### Removed

- Obsolete `// Mirror de qtc_core/...` comments referencing deleted Python sources.
- `DEFAULT_EXPECTED_SCRIPTS_BY_FLOW` table (Python script existence check).

### Migration for `qtc-*` plugin users

Install or upgrade your qtc-* plugins; they will set `AW_NAMESPACE=qtc` in their `SessionStart` hook (sub-project 3). Until then, manually set `export AW_NAMESPACE=qtc` in your shell, or pass `--namespace qtc` per invocation. Existing data under `~/.qtc/...` is unchanged and the CLI continues to read/write there with namespace=qtc.

## [0.9.1] — 2026-05-02

Last release before the agnostic refactor. See git history for details.
