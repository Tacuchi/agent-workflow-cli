---
name: agent-workflow
description: Universal skill for the @tacuchi/agent-workflow-cli CLI. Teach Claude Code how to drive session-lifecycle workflows (planning → execution → validation → closure), history bookkeeping, source/branch checks, checkpoints, doctor, hooks, and self-management. Use whenever the user works with session-based development inside a workspace that hosts an `.agent-workflow/` or `.workflow/` (QTC plugin family) artifact tree.
version: 1.2.0
---

# agent-workflow — universal CLI skill

`@tacuchi/agent-workflow-cli` is a generic, namespace-aware CLI that runs the canonical session-lifecycle workflow used by the qtc-* plugin family and any other plugin that opts into the same artifact contract.

This skill teaches Claude Code:

- when to invoke the CLI vs. handing the work to a slash command,
- the 43 top-level subcommands grouped by family,
- the namespace contract that lets the same binary serve multiple plugin ecosystems without forks.

For each command family there is a dedicated reference under `references/`. Read the matching reference *before* invoking commands you have not used in the current conversation — flags and contracts evolve.

## Invocation contract

```
agent-workflow [--namespace <name>] [--flow <core|dev|design|analyze>]
               [--plugin-root <path>] [--plugin-version <semver>] [--compat <range>]
               <command> [args...]
```

Short alias: `aw`.

### Namespace resolution (highest precedence first)

1. CLI flag `--namespace <name>`
2. Env var `AW_NAMESPACE` (or `AGENT_WORKFLOW_NAMESPACE`)
3. User config `~/.config/agent-workflow/namespace`
4. Workspace auto-detect: `.<ns>/sessions/` directory in CWD
5. Default literal: `agent-workflow`

For QTC plugin compatibility, the `qtc` plugin reclaims namespace `workflow` from its SessionStart hook by writing `workflow` to `~/.config/agent-workflow/namespace`; the CLI then reads/writes `~/.workflow/`, `.workflow/sessions/`, and the `QTC-PROJECT` block in `CLAUDE.md` / `AGENTS.md`.

When you invoke the CLI from a fresh shell where no plugin has set the user-config, use `--namespace <name>` explicitly or run from inside a workspace whose `.<ns>/sessions/` dir is autodetected. The binary will otherwise operate on the default `agent-workflow` namespace.

### Output contract

Every command returns JSON on stdout (no decoration), exit code 0 on success and non-zero on error with a structured error envelope. Pipe to `jq` to extract fields.

```bash
agent-workflow sessions | jq '.next_number'
agent-workflow objetivo-data --code session035 | jq '.criterios_aceptacion'
```

## When to invoke this CLI

Invoke `agent-workflow` (directly or via the registered slash commands) whenever:

- the user asks to **create / resume / close / list** sessions,
- the user asks to **read or update** an artifact (`OBJETIVO.md`, `TASKS.md`, `DECISIONES.md`, `HISTORY.md`, `CHECKPOINT.md`),
- you need to **detect workspace state** (sources, branches, mode, stack, harness),
- a host hook (`PreToolUse`, `SessionEnd`, `PostCompact`) routes to the binary,
- the user wants to **manage the CLI itself** (doctor / update / install-skill / namespace).

Do *not* invoke the CLI for ad-hoc file edits, code refactors, business validation, or anything outside the session-lifecycle contract.

## Command families

The 43 top-level subcommands group into 11 families. Open the matching reference before composing a command.

| Family | Reference | What lives there |
|---|---|---|
| Session management | [references/session-mgmt.md](references/session-mgmt.md) | sessions, session-create, session-resume, session-close, session-artifacts |
| Objetivo / Tasks | [references/objetivo-tasks.md](references/objetivo-tasks.md) | objetivo-data, tasks-data, decisiones-list, dependencias-list |
| History | [references/history.md](references/history.md) | history-data, history-update |
| Checkpoint | [references/checkpoint.md](references/checkpoint.md) | checkpoint-read, checkpoint-write, compress-checkpoint, resume-summary, auto-compact-on-close |
| Sources / branches | [references/sources.md](references/sources.md) | sources, check-branch, workspace-mode, project-md-upsert, upgrade-hub-mode, attach-multiroot, detach-multiroot |
| Orchestration | [references/orchestration.md](references/orchestration.md) | auto-plan-decide, topic-change-check, specialty-choose, phase-detect, phase-next, stack, workflows, skill-index |
| Doctor / release | [references/doctor.md](references/doctor.md) | plugin-doctor, code-scan, release-data, graduate |
| Hooks | [references/hooks.md](references/hooks.md) | hook branch-check, hook sql-mutation-guard |
| MCP / DSN | [references/mcp.md](references/mcp.md) | mcp dbhub, bootstrap-dsn |
| Dev-only | [references/dev-only.md](references/dev-only.md) | harness, profiles, logs, next-number |
| Self | [references/self.md](references/self.md) | self namespace, self doctor, self update, self install-skill |

## Quick start cheatsheet

```bash
# Discover state
agent-workflow sessions
agent-workflow workspace-mode
agent-workflow sources

# Create + drive a session
agent-workflow session-create --flow dev --name fix-login --objetivo "Bug: login redirect loop"
agent-workflow session-resume --code session042
agent-workflow tasks-data --code session042 --only-open
agent-workflow checkpoint-write --code session042
agent-workflow session-close --code session042

# Diagnostics
agent-workflow self doctor
agent-workflow self namespace
agent-workflow plugin-doctor --plugin-root /path/to/plugin
```

## Discovery rules

1. If unsure which family a command belongs to, run `agent-workflow --help` (top-level) and pick the family from the table above.
2. If unsure about flags, read the corresponding `references/*.md`. The references list every supported flag with example payloads.
3. If a command returns `error.code = "NOT_IN_WORKSPACE"`, the namespace points at a filesystem tree that does not exist — re-check `--namespace` / env, or run `self namespace` to see the resolved value.

## Cross-references

- CLI repo: <https://github.com/Tacuchi/agent-workflow-cli>
- npm: <https://www.npmjs.com/package/@tacuchi/agent-workflow-cli>
- This skill is bundled in the CLI tarball — no standalone repo. `agent-workflow self install-skill` copies it from the bundled location to `~/.claude/skills/agent-workflow/`.
- Install: `npm i -g @tacuchi/agent-workflow-cli && agent-workflow self install-skill`
