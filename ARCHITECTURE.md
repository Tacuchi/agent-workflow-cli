# Architecture of agent-workflow-cli

Reviewed on 2026-11-18 against version 33.0.0 (commit `88b01746`).

The overview: what the CLI installs and where, how a command runs, what it reads and writes, and which rules never break. It leaves out each command, each loop of the `w` skill and the content of the documents a flow writes. All values are defaults; nothing here was measured on a particular machine.

In short:

- A command-line tool, `aw`, and the `w` skill bundle that run specs, plans and quick tasks for coding agents.
- A person uses it in a terminal; coding agents in eight hosts use it through `/w:*` commands and a session-start hook.
- It talks only to the npm registry and each source's git remote; it opens no database connection.
- Data lives in files: the hub's `.workflow/` and `docs/`, and the user folder `~/.workflow/`.
- It never runs SQL: database changes ship as script files a person applies.

## 1. Purpose and quality goals

agent-workflow-cli is the runtime of agent-workflow, a system of stages, loops and artifacts for coding-agent work. It ships the binaries `agent-workflow` and its alias `aw`, and the `w` skill bundle, which `self install` copies with its command wrappers and hooks into each supported host. The agent invokes `/w:*` commands, the bundle calls `aw`, and `aw` keeps hub state on disk: specs and plans in `docs/`, process state in `.workflow/`.

What it is not:

- It is not an agent. The coding agent does the work; the CLI resolves state, checks rules and writes files.
- It is not a background service. Each call is one process.
- It is not a database client. It never runs DML or DDL and opens no database connection.

| Goal | Scenario |
|---|---|
| No installed hook blocks an agent's tool | The only hook the template installs is `SessionStart`. A hook an earlier version installed answers like an unknown command, exit 1, never the exit 2 a host treats as "block". |
| Publishing to production is deliberate | A git flow that pushes to a source's PROD branch stops at a preview until the person consents to exactly those sources. With `--all` it refuses. |
| Install and uninstall stay inside what they own | A folder or a legacy root is removed only when its bytes prove that agent-workflow wrote it; other copies are kept and reported. |

Two more goals, for help and for the session-start hook, are in [docs/runtime.md](docs/runtime.md#more-quality-goals).

## 2. Context and scope

![Context diagram of agent-workflow-cli](docs/architecture/context.svg)

[Interactive version](https://tacuchi.github.io/agent-workflow-cli/architecture/context.html).

| External interface | Direction | When it happens |
|---|---|---|
| Coding agent (Claude Code, Codex, Warp, Oz, Gemini/Antigravity, OpenCode, Crush, Kimi Code) | Local | In every session: the host reads the installed skill and runs the session-start hook. |
| You, in a terminal | Local | When you run `aw` commands or open the TUI with `aw` and no arguments inside a hub. |
| npm registry | Outbound | When the TUI opens (one `npm view` for the latest version) and when you run `aw self update`. |
| Git remote of each source | Outbound | When `git-flow` syncs or promotes a branch: `git fetch` and `git push` to `origin`. |
| Herdr | Local | Only with `aw hubs sync --herdr`. |

## 3. Building blocks

![Container diagram of agent-workflow-cli](docs/architecture/containers.svg)

[Interactive version](https://tacuchi.github.io/agent-workflow-cli/architecture/containers.html).

| Block | Responsibility | Code |
|---|---|---|
| Entry point | Keeps the session-start hook silent outside a hub before loading the full CLI. | `src/cli/main.ts` |
| CLI, TUI and commands | Parses arguments, resolves the hub, dispatches to one registered command per subcommand and renders the result; the Ink screen opens with no arguments. | `src/cli/`, `src/cli/tui/`, `src/cli/commands/` |
| Application services | The logic behind each command: hub, sources, flows, plans, install, doctor, release passes. | `src/application/` |
| Domain, ports and adapters | Pure types and rules, such as redaction, plus interfaces for files, environment, git, processes and archives with their Node.js implementations. | `src/domain/`, `src/ports/`, `src/adapters/` |
| Runtime | Namespace and hub resolution, the hub marker and the runtime configuration. | `src/runtime/` |
| `w` skill bundle | Markdown and JSON that the hosts read: commands, loops, roles, exports and the hook template. Not compiled. | `skills/w/` |

Command registration: [docs/runtime.md](docs/runtime.md#commands-registry).

Rules that never break:

- No command runs SQL or opens a database connection; migrations are files in `docs/scripts/`.
- A push to a source's PROD branch needs the person's consent for exactly those sources, checked in the service, so no caller skips it.
- Install and uninstall delete only what agent-workflow owns; a legacy root is cleaned only with ownership proof.
- The installer never arms Codex hooks: each one needs Codex's own interactive review.
- `$HOME` is never a hub.
- A command that fails returns `{ ok: false, error: { code, message } }` and a non-zero exit code.

## 4. Runtime view

A command, from the terminal or from an agent:

1. `main.ts` reads the arguments. The session-start hook stays silent without loading the full CLI when no hub is visible.
2. The full CLI parses the arguments and resolves the output mode.
3. It resolves the namespace and the hub root, in the order of [docs/runtime.md](docs/runtime.md#how-a-command-finds-its-hub).
4. A hub that still carries a pre-29 block or the retired session model stops with a migration error that names `aw hub-migrate`.
5. It builds the `CliContext`: the adapters, the runtime configuration, the resolved skills and the logger.
6. It dispatches to the registered command, which returns a result with an exit code.
7. The result is printed as JSON or for a person, and one line goes to the daily log. The hub is recorded in the user-level registry.

## 5. Deployment view

Installed per user with `npm install -g @tacuchi/agent-workflow-cli`.

| What | Default | When it applies | How to change it |
|---|---|---|---|
| Binaries | `agent-workflow` and `aw` | After the global install | `aw self update` |
| Hub folder | `.workflow/` at the hub root, marked by `.workflow/agent-workflow.json` | Inside a hub | `--namespace`, `AW_NAMESPACE` or `aw self namespace --pin` |
| User folder | `~/.workflow/`: `hubs.json`, `skills.toml`, `logs/` | Always | The namespace names the folder |
| `w` skill | A `w/` folder in each host's skills folder | After `self install --target <host>` | `--from`, `--skill-only`, `aw self uninstall` |
| Claude Code hooks | Merged into `~/.claude/settings.json` | After `self install --target claude` | `--no-hooks` |
| Output | JSON, or text for a person in a terminal | Every command | `AW_ASCII` for ASCII-only output |

Each host's folder: [docs/host-support.md](docs/host-support.md#where-self-install-writes-the-skill). The pinned namespace and the daily log: [docs/runtime.md](docs/runtime.md#two-more-files-on-disk).

Requirements: Node.js 18 or newer, `git`, and `npm` for updates. `herdr` only for `hubs sync --herdr`.

## 6. Cross-cutting concepts

### Data and privacy

| Question | Answer |
|---|---|
| What leaves the machine, and where does it go? | The package name, to the npm registry, to check or install a version; commits `git-flow` pushes to each source's `origin`. |
| What never leaves it? | The hub, its `docs/`, the logs and the registry of hubs. The code has no telemetry: the context receipt states `local-only`. |
| When does it happen? | Version check when the TUI opens; installs with `aw self update`; pushes with `git-flow`. |
| Where is it stored, and for how long? | Hub state in the hub's `.workflow/` and `docs/`, versioned where you commit it; user state in `~/.workflow/`; daily logs until `aw logs --clear`. |
| How can you see exactly what was sent? | `git-flow --dry-run` shows the plan before it runs; `aw logs` shows the daily log. |
| How is it turned off? | Do not open the TUI and do not run `self update`; do not run `git-flow`. |

### Local security

- Values that look like secrets are redacted before a log line is written.
- Host configuration files are written to a temporary file with `0600` permissions and renamed into place, under a lock.

### Persistence

- Hub artifacts are Markdown and JSON files. Specs and plans live in `docs/` and carry their own state line; process state lives under `.workflow/`.
- Every write goes to a temporary file renamed into place, so no reader sees half a file. The registry of hubs and older hubs: [docs/runtime.md](docs/runtime.md#persistence-details).

## 7. Decisions

Decision records live in [`docs/decisions/`](docs/decisions/). The first four come from comments the code already carried:

| Decision | Record |
|---|---|
| The installer never arms Codex hooks | [0001](docs/decisions/0001-never-arm-codex-hooks-from-the-installer.md) |
| The SQL guard fails closed (superseded by 0005) | [0002](docs/decisions/0002-the-sql-guard-fails-closed.md) |
| PROD consent is enforced in the git-flow service | [0003](docs/decisions/0003-enforce-prod-consent-in-the-git-flow-service.md) |
| The Gemini skill root is `~/.gemini/config/skills` | [0004](docs/decisions/0004-install-gemini-skills-under-gemini-config.md) |
| The SQL guard and the database surface are retired | [0005](docs/decisions/0005-retire-the-sql-guard-and-the-database-surface.md) |

Not recorded yet:

- Manual schema validation, without Zod.
- Ports and adapters injected through `CliContext`.
- One process per call, with no background service.
- The AGPL-3.0-or-later license.

## Appendix: evidence

Line numbers refer to commit `88b01746`. Every row cites code or configuration; the text above does not link to the code on purpose.

| Section | Evidence |
|---|---|
| 1. Goals | `package.json:4-9`, `skills/w/hooks/hooks.template.json:1-16`, `src/application/git-flow-service.ts:188-200`, `src/application/self/install-skill.ts:171`, `src/application/self/install-targets.ts:24` |
| 2. Context | `src/domain/harnesses.ts:336-363`, `src/application/self/update-self.ts:156-160`, `src/application/git-flow-service.ts:380-386`, `src/adapters/herdr-cli.ts:38` |
| 3. Blocks | `src/cli/main.ts:5-37`, `src/cli/full-cli.ts:136-186`, `src/cli/commands/index.ts:54-118`, `src/cli/tui/run.tsx:40-55` |
| 3. Rules | `skills/w/hooks/hooks.template.json:1-16`, `src/application/git-flow-service.ts:188-200`, `src/domain/harnesses.ts:390-397`, `src/cli/render.ts:20-30` |
| 4. Runtime | `src/cli/main.ts:5-37`, `src/runtime/namespace-resolver.ts:133-145`, `src/cli/full-cli.ts:226-252`, `src/cli/full-cli.ts:144-186`, `src/cli/full-cli.ts:64-97` |
| 5. Deployment | `package.json:44-46`, `src/runtime/agent-workflow-marker.ts:21`, `src/application/paths-service.ts:33-47`, `src/application/self/install-targets.ts:12-22`, `src/application/self/install-hooks.ts:408-415` |
| 6. Privacy | `src/cli/tui/app.tsx:425-431`, `src/application/context/plan-service.ts:177`, `src/application/logging/logger.ts:48`, `src/application/mcp-host-writer.ts:12-45`. A search for telemetry and analytics in `src/` found only the `local-only` receipt |
| 7. Decisions | `src/domain/harnesses.ts:390-397`, `skills/w/hooks/hooks.template.json:1-16`, `src/application/git-flow-service.ts:188-191`, `src/application/self/install-targets.ts:31`, `src/application/session-binding-service.ts:17` |
