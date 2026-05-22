# agent-workflow-cli

Agnostic runtime CLI + universal `agent-workflow` SKILL for session-lifecycle workflows across AI coding hosts (Claude Code, Codex, Warp, OZ).

Published as [`@tacuchi/agent-workflow-cli`](https://www.npmjs.com/package/@tacuchi/agent-workflow-cli). Bundles the full `agent-workflow` SKILL in the npm tarball: `self install --target <host>` copies skills + commands + hooks to the host's config directory.

## Layout

```
src/
  application/      services (hex core; pure functions, no I/O)
    profile/        profile.json cascade resolver (DEFAULT → env → ~/.config → workspace → flag)
    self/           install / uninstall / clean-cache / clean-legacy / detect-hosts
  cli/              CLI entry + commands + TUI (Ink)
  infrastructure/   adapters (FileSystem, Env)
skills/agent-workflow/   universal SKILL (35 skills + 17 commands + 7 hooks template)
tests/unit/         Vitest unit suite (645+ tests)
tests/golden/       Snapshot tests for SKILL parametrization + TUI
tests/fixtures/     Sample workspaces (EN + ES legacy)
```

## Commands

```bash
npm install          # install dependencies
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
npm run lint         # biome check (lint + format)
npm run test         # vitest run (full suite)
npm run test:watch   # vitest watch mode
npm run test:golden  # snapshot tests only
```

`prepublishOnly` chains lint + typecheck + test + build. Never bypass.

## Conventions

- **Architecture**: hexagonal. `application/` is pure; ports + adapters in `infrastructure/`. Side effects (fs, env) flow through ports.
- **Schema validation**: manual (no Zod). DEC-001 per consistency with existing codebase. Throw typed errors with `code` keys (`TARGET_REQUIRED`, `INVALID_TARGET`, etc.).
- **Cyclomatic complexity**: max 15 per function (Biome enforced). Extract sub-functions when over.
- **TypeScript strict + ESM**: `exactOptionalPropertyTypes: true`. Use `{ ...(x !== undefined ? { x } : {}) }` for optional spreads.
- **Error model**: throw `Error` with `code: string` + `message`. CLI layer catches and prints JSON `{ ok: false, error: { code, message } }`.
- **No external deps for the runtime SKILL**: the SKILL.md files in `skills/agent-workflow/` are pure markdown + JSON; no compilation. `tsc` only compiles `src/`.

## Multi-empresa (`profile.json`)

The CLI is agnostic. Empresas (e.g. QTC) extend behavior via a companion plugin that ships a `profile.json` with:

```json
{
  "namespace": "acme",
  "company": "Acme Corp",
  "claude_md_block": "ACME-PROJECT",
  "mcp_databases": [
    { "alias": "acme-stage", "host": "...", "port": 5432, "database": "..." }
  ],
  "lexicon_path": "profiles/lexico-acme.md",
  "examples_path": "profiles/examples-acme.md",
  "migrate_legacy_rules": [],
  "custom_anchors": []
}
```

Cascade resolution: `--profile <path>` flag → `AW_PROFILE` env → `~/.config/agent-workflow/profile.json` → `<workspace>/.agent-workflow/profile.json` → embedded defaults.

The companion plugin (`qtc-workflow-plugin`, etc.) auto-copies its `profile.json` via a SessionStart hook on first install. Not required for the agnostic install path — the CLI alone is functional.

## Slash commands

User-level commands installed under `~/.<host>/commands/agent-workflow/` (Claude/Codex). Invoked as `/agent-workflow:<name>` (e.g. `/agent-workflow:session`, `/agent-workflow:compact`).

For Warp/OZ, only the SKILL is copied (no slash commands or hooks).

## Hooks

Claude-only. `self install --target claude` JSON-merges 5 events into `~/.claude/settings.json` (with backup): SessionStart, PreToolUse, SessionEnd, PreCompact, PostCompact. Other hosts skip with a warning.
