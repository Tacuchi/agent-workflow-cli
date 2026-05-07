# Changelog

All notable changes to `@tacuchi/agent-workflow-cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] — 2026-05-07

Breaking — paquete renombrado de `@tacuchi/agent-workflow` a `@tacuchi/agent-workflow-cli`. Repo upstream renombrado de `Tacuchi/agent-workflow` a `Tacuchi/agent-workflow-cli`. Bin (`agent-workflow`) y alias (`aw`) sin cambios. Roadmap del upgrade en hub `qtc-plugin-upgrade` (RFC 001 v2).

### Changed

- `package.json:name` → `@tacuchi/agent-workflow-cli`.
- `package.json:repository`, `bugs`, `homepage` → URLs del repo nuevo.

### Migration

Consumidores de `@tacuchi/agent-workflow@^2`:

```bash
npm uninstall -g @tacuchi/agent-workflow
npm install -g @tacuchi/agent-workflow-cli
```

Las rutas instaladas (`agent-workflow`, `aw`) y la API pública del CLI no cambian — sólo el nombre del paquete y la URL del repo.

## [2.0.2] — 2026-05-06

Patch UX fix for the interactive TUI menu. RFC 002 follow-up (session010 in the qtc-plugin-v2 hub).

### Fixed

- **Menu `Install/Update skill` failing with `DEST_EXISTS`**: when the bundled skill was already installed, selecting the menu option failed because the dispatcher invoked `self install-skill` without `--force`. Since the menu label literally reads "Install/**Update**", the user's intent on selection is overwrite. The dispatcher now passes `--force` automatically. The CLI directly (`agent-workflow self install-skill`) is unchanged and still requires explicit `--force` to overwrite — preserving the safety net for scripts and CI.

## [2.0.1] — 2026-05-06

Patch fix for the interactive TUI menu. RFC 002 follow-up (session009 in the qtc-plugin-v2 hub).

### Fixed

- **Interactive menu missing `install-skill` option**: when running `aw` or `agent-workflow` without arguments in a TTY, the menu only exposed `Doctor / Update / Help / Exit`. The bundled `self install-skill` command introduced in v2.0.0 was reachable only from the command line. The menu now lists 5 options: `Doctor / Install/Update skill (manager bundled) / Update CLI / Help / Exit`. The `Update CLI` label was clarified (previously just "Update").

### Internal

- `MenuAction` union extended with `"install-skill"`. `dispatchMenuAction` switch wires it to `["self", "install-skill"]`.

## [2.0.0] — 2026-05-06

Bundle the `agent-workflow-manager` skill in the published tarball. **Breaking change** in the default behavior of `agent-workflow self install-skill`: it now copies from the bundled skill shipped alongside the CLI instead of git-cloning the upstream repo. RFC 002 Fase D (session007 in the qtc-plugin-v2 hub).

### Breaking changes

- **`self install-skill` default source**: previously `git clone https://github.com/Tacuchi/agent-workflow-manager.git`; now copies from `<package_root>/skills/agent-workflow-manager/` (bundled in the tarball). Users who relied on the default to fetch bleeding-edge from git must now pass `--from <url>` explicitly.
- **`SelfInstallSkillData.source_kind`** gains a new variant `"bundled"` (alongside `"path"` and `"url"`). Consumers that exhaustively pattern-match must add the new variant.
- **New error code** `BUNDLED_NOT_FOUND` returned when `--from` is omitted and the resolver cannot locate `skills/agent-workflow-manager/SKILL.md` relative to the install (e.g., dev checkouts without a build, or tarballs missing `skills/`).

### Added

- **Bundled skill manager**: the npm tarball now ships `skills/agent-workflow-manager/` (5 files + `docs/` + `references/`). `package.json` `files` array extended to `["dist", "skills", "LICENSE", "README.md"]`.
- **`resolveBundledSkillPath()`** helper exported from `application/self/install-skill.js` — walks up from the current module's directory until it finds `skills/agent-workflow-manager/SKILL.md`. Works in both dist (post-build) and dev (vitest) layouts.
- **`BUNDLED_SKILL_REL_PATH`** constant exported (default `"skills/agent-workflow-manager"`).
- 2 new unit tests in `tests/unit/self-install-skill.test.ts` covering bundled-default and `BUNDLED_NOT_FOUND`. `selfInstallSkill` accepts an optional `resolveBundled` injector for testability.

### Changed

- `selfInstallSkill` flow: (1) `--from <X>` provided → use as path or url (unchanged behavior); (2) `--from` omitted → call bundled resolver; bundled found → use as `source_kind: "bundled"`; bundled missing → `BUNDLED_NOT_FOUND`.
- Package `description` updated to highlight the bundled skill manager.

### Migration guide (v1.2.0 → v2.0.0)

| Use case | v1.x | v2.x |
|---|---|---|
| Install bundled skill | `agent-workflow self install-skill` (clones git) | `agent-workflow self install-skill` (copies bundled, faster, offline-capable) |
| Install bleeding-edge | (default, implicit) | `agent-workflow self install-skill --from https://github.com/Tacuchi/agent-workflow-manager.git` |
| Install from local checkout | `agent-workflow self install-skill --from /path/to/repo` | unchanged |
| `--force` / `--dry-run` flags | unchanged | unchanged |

If your tooling pinned `^1.0.0`, bumping to `^2.0.0` is a single major bump. The CLI surface (commands, flags, output schema) stays compatible aside from the new `source_kind: "bundled"` enum value.

### Internal

- `agent-workflow-manager` repo (origin) is preserved unmodified. Strangler Fig: the standalone repo will be archived in Fase E (≥2 weeks post-v2.0.0).

## [1.2.0] — 2026-05-05

Workspace-aware namespace resolution. The CLI now infers `namespace` from the cwd when no flag/env/config is set, so qtc-* (and other) workspaces work out-of-the-box without per-invocation configuration.

### Added

- **Workspace auto-detect** as a 3rd resolution step (between env and user config). When no `--namespace` flag and no `AW_NAMESPACE` env are present, the resolver scans the current directory for hidden folders matching `^\.[a-z][a-z0-9-]{1,30}$/` that contain a `sessions/` subdirectory. If exactly one match is found, that namespace is used (source = `workspace`). This makes `agent-workflow sessions` "just work" inside qtc-* (or any other) workspace without per-invocation config.
- New `NamespaceSource` value `workspace` reported by `self namespace` and `self doctor`.
- 5 new unit tests in `tests/unit/namespace-resolver.test.ts` covering: detection of `.qtc/sessions/`, ignoring `.git/` (no sessions/ subdir), ambiguity fallback (multiple candidates → default), config-file precedence over auto-detect, and unreadable cwd graceful handling.

### Changed

- **Resolution order**: workspace auto-detect now wins over `~/.config/agent-workflow/namespace` (locality > preference). A user with `qtc` in their user config but cwd inside a `.foo/sessions/` workspace gets `foo`, not `qtc`. New full order: flag > env > workspace > user-config > default.
- `NAMESPACE_REGEX` exported from `runtime/namespace.ts` so the resolver can reuse the same validation pattern for workspace candidates.
- Help text updated to document the new resolution order.
- Package description: highlights the workspace auto-detect.

## [1.1.0] — 2026-05-05

Sub-proyecto 2 del spec `agent-workflow-agnostic-design`: poblar el repo `agent-workflow-manager` y entregar la implementación real de `self install-skill` que lo consume.

### Added

- `self install-skill` real implementation:
  - Default source: `https://github.com/Tacuchi/agent-workflow-manager.git` (cloneable via `git`).
  - `--from <url|path>` flag accepts an alternate git URL or a local filesystem path.
  - `--force` overwrites an existing `~/.claude/skills/agent-workflow-manager/` directory.
  - `--dry-run` previews source/destination without copying.
  - Validates `SKILL.md` frontmatter (`name`, `description`) before installing.
  - Skips `.git/` when copying so the installed skill folder is clean.
- 10 new unit tests in `tests/unit/self-install-skill.test.ts` covering local-path install, URL clone via fake `ProcessPort`, force overwrite, dry-run, missing source, missing/invalid SKILL.md, and clone failure.

### Changed

- `self doctor` now reports the skill at `~/.claude/skills/agent-workflow-manager/` (was `~/.claude/skills/agent-workflow/`). Skill folder name now matches the canonical skill repo name.

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
