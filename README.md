# @tacuchi/agent-workflow-cli

> Runtime CLI and `w` skill bundle for agent-workflow: stages, loops and artifacts for coding agents.

Agnostic runtime CLI for **agent-workflow** — the **stages + loops + artifacts** system for agent work. Bundles the universal **`w`** skill set (`w` = *workflow*); host-provided help is optional and never bypasses a flow's approvals or validation.

The CLI exposes two binaries: `agent-workflow` (canonical) and `aw` (short alias).

## Table of Contents

- [Install](#install)
- [Usage](#usage)
- [How it works](#how-it-works)
- [Contributing](#contributing)
- [License](#license)

## Install

### Requirements

Node.js 18 or newer, `git`, and `npm` for updates.

### Install the package

```bash
npm install -g @tacuchi/agent-workflow-cli
```

### Install the bundled skill

The published tarball bundles the universal skill set under `skills/w/`. Install it into your host with `--target` (required):

```bash
agent-workflow self install --target claude     # or: codex · warp · oz · gemini · opencode · crush · kimi · agents
agent-workflow self install --target all --confirm-all
agent-workflow self detect-hosts                # which hosts are present + already have it
agent-workflow self install --target claude --dry-run
```

La instalación actualiza sólo artefactos propios: el bundle `w`, wrappers y hooks administrados. Al actualizar, retira un wrapper `design` anterior únicamente si sus bytes prueban propiedad de agent-workflow; conserva e informa copias intervenidas o ajenas. `--keep-legacy` conserva también el legado propio identificado. Para ayudas externas, usa el mecanismo nativo del host.

#### Per-target install matrix

`self install --target <host>` installs **SKILL + user-level slash commands + hooks** in one shot, scaled to what the host supports:

| Host | Level | SKILL | User-level commands | Hooks |
|---|---|---|---|---|
| `claude` | official | `~/.claude/skills/w/` | `~/.claude/commands/w/<n>.md` → `/w:<n>` | `~/.claude/settings.json` (JSON merge + backup) |
| `codex` | official | `~/.codex/skills/w/` | synthesized skills `~/.codex/skills/w-<n>/` → `$w-<n>` (Codex reads no commands dir) | **not armed, and not for lack of wiring**: they would go in `~/.codex/hooks.json` (Claude-shaped, every template event fits), but Codex requires an *interactive human review per hook* — writing the file does not arm it, and forging its `trusted_hash` would forge your approval |
| `warp` | official | `~/.warp/skills/w/` | synthesized skills `~/.warp/skills/w-<n>/` → `/w-<n>` | none (no hook system) |
| `gemini` | official | `~/.gemini/config/skills/w/` | synthesized skills `~/.gemini/config/skills/w-<n>/` (Antigravity `agy`) + `~/.gemini/commands/w/<n>.toml` → `/w:<n>` (legacy Gemini CLI) | not armed (extension-bundled) |
| `kimi` | official · pre-1.0 | `~/.kimi-code/skills/w/` (also reads `~/.agents/skills`) | synthesized skills `~/.kimi-code/skills/w-<n>/` → `/skill:w-<n>` | `~/.kimi-code/config.toml` → managed `[[hooks]]` block (marked + backup) |
| `oz` | best-effort · pre-1.0 | `~/.agents/skills/w/` | synthesized skills `~/.agents/skills/w-<n>/` | none |
| `opencode` | best-effort | `~/.opencode/skills/w/` | `~/.opencode/command/w/<n>.md` → `/w/<n>` | not armed (JS plugins) |
| `crush` | best-effort · pre-1.0 | `~/.config/crush/skills/w/` (XDG — the only global root Crush reads; `~/.crush` holds commands only) | `~/.crush/commands/w/<n>.md` → palette `user:w:<n>` | not armed (preliminary) |
| `agents` | *shared destination, not a host* | `~/.agents/skills/w/` | skipped (shared dir) | skipped |

The bundle's internal manuals (`loops/*/LOOP.md`, `roles/*/ROLE.md`, `exports/*/EXPORT.md`, `harness/HARNESS.md`) are deliberately **not** `SKILL.md` files, so hosts that scan skill roots recursively (Codex, OpenCode, Crush) never list them as invocable skills — only the commands and the `w` orientation skill surface. Where a layer is skipped, the SKILL is sufficient — the AI reads it and invokes `agent-workflow <subcommand>` directly.

Opt-out flags: `--skill-only`, `--no-commands`, `--no-hooks`. Override the source with `--from /path/to/skills/w`. Other flags: `--confirm-all` (required with `--target all`), `--keep-legacy`, `--force`, `--dry-run`.

Los flujos verifican la rama declarada por fuente antes de editar (`aw check-branch`), sin hooks generales de rama o commit. La integración conserva una unidad con conflicto y exige resolución externa antes del reintento.

**What `--target all` means.** Every **host** — never the shared skills dirs, which are install destinations rather than hosts and are reached explicitly (`--target agents`). `install` and `uninstall` use the same set, so the round trip matches: what `all` installs is what `all` removes. (`oz` installs into `~/.agents/skills`, so that directory is still covered under `all` through its host.)

### Update

`aw self update` installs the latest published version with `npm`.

Semantic Versioning. Major bumps are reserved for breaking changes to commands, flags, or output schemas. See `CHANGELOG.md`.

### Uninstall

`aw self uninstall` removes what `self install` wrote into each host. Then remove the package with `npm uninstall -g @tacuchi/agent-workflow-cli`.

### Platforms

Validation platform: **macOS** is where all eight runtimes live and where the suite is expected to pass. **Windows** remains best-effort; **Linux** is documented without a guarantee.

### Support levels and how long a verification is worth

**official** — Claude Code, Codex, Warp, Gemini/Antigravity, Kimi Code. **best-effort** — Oz, OpenCode, Crush. `agents` is a shared destination, not a host, and never counts as one.

What each level checks, the maintainer's host run and how a host is retired are in [docs/host-support.md](docs/host-support.md).

## Usage

### The model — stages + loops + artifacts

agent-workflow has three layers plus a permanent `docs/` zone:

- **Layer 1 · Commands** (`/w:*`) — the only thing the user invokes:
  - **SPEC** — `/w:spec-new` (single-pass draft after a bounded reconnaissance of the sources; may split into sibling specs) → `/w:spec-refine` (gap-driven loop; converges at `status: ready-for-plan` — the blocking functional decisions closed, the technical ones declared for PLAN) → `docs/specs/`.
  - **PLAN** — `/w:plan-new` → (`/w:plan-refine` — aux, optional) → `/w:plan-exec` → `docs/plans/` (the plan loops may split into sibling plans). A plan is a sequence of **functional states**: every phase names a verifiable state, carries its own primary proof, and — **only when the change carries temporary behavior** — declares where a simulation lives and when it retires. Ticking every checkbox is not validation, and validating every phase is not closing the plan.
  - **QUICK** — `/w:quick` — lightweight shortcut; escalates live to SPEC when the goal outgrows a quick.
  - **EXPORTS** — `/w:export-scripts` consolidates the SQL of `docs/scripts/`. Diagrams, manuals and reports are written straight to `docs/diagrams`, `docs/manuals` and `docs/reports`; `/w:persist` saves work already produced.
  - **Hub** — every invoked directory is usable immediately. `/w:hub-init` only materializes the runtime early, or configures sources when they are supplied.
  - **Transversal** — `/w:status` · `/w:doctor` (read-only diagnosis across every detected host, with the verdict in the exit code; repairs only what agent-workflow owns, over a batch approved by digest) · `/w:resume` (read-only: composes `/w:status` and proposes how to continue, routed to the target command) · `/w:recall` (what the other hosts' curated memory learned about agent-workflow, contrasted and applied; saving goes to the current host's own memory only after confirmation) · `/w:persist` (persists in-conversation work into `docs/` — classify → `docs/research` · spec draft · plan adoption; the host→`docs/` counterpart of `export-*`).
- **Layer 2 · Loops** — the AI runs them whole: `spec-refine-loop` · `plan-new-loop` · `plan-refine-loop` · `plan-exec-loop` · `quick-loop` — all heirs of the shared engine `skills/w/loops/CHASSIS.md` (+ `CODE-POLICIES.md` for the code-editing loops). Each loop is a **persistent goal** that runs until its success criteria are green (verification-first); gap-driven, with **structured-choice** lifecycle control (compact/close — the host's own question surface where one is reachable, **labeled markdown** where none is; the binding per host is stamped into what gets installed) and resumable `CHECKPOINT`.
- **Layer 3 · Sessions + artifacts** — internal, ephemeral process state under `.workflow/sessions/` (`SESSION` · `CHECKPOINT` · `BACKLOG` · `SCRIPTS.sql` · `ANALYSIS-FILE` · `CONCLUSIONS` · `DECISION` · …). Sessions are slug-named folders, created by loops, never by the user.

**Capacidad propia.** `overview` orienta sobre agent-workflow mediante la skill `w`. Su binding se resuelve por `skills.toml` (default → global → hub); `off` conserva el opt-out y los bindings históricos ajenos se avisan sin reescribirlos. `aw skills --detail` informa sólo sobre capacidades y wrappers propios. SPEC resuelve las decisiones UI como decisiones funcionales ordinarias; PLAN y QUICK aceptan ayuda del host sin exigir una skill externa. Los exports conservan destinos y guardas independientemente de cómo se produzca el contenido. Los lanzadores y registros de procesos anteriores son artefactos inertes y permanecen gitignorados.

**Invariants.** No auto-export (only `export-*` writes `docs/`); the spec and plan are documents, not artifacts; DB scripts-only (never executes DML/DDL); git-safe (verifies the per-source working branch before edits; proposes commits).

A plan is a sequence of functional states: its phase contract, its three progress axes and how authoring and execution share one gate are in [docs/plan-model.md](docs/plan-model.md).

### TUI

Running `agent-workflow` (or `aw`) with no arguments inside a hub opens one screen that answers «where is my work and what can I do now?»:

- the hub's pending items, each with its next step and the command that resumes it (read from `aw status --format json`);
- each source with its current branch and whether it has uncommitted changes;
- the git flow over one source or «todas las fuentes»: align with PROD, send to development, QA or PROD. «Enviar a PROD» shows the preview and publishes only on `y`;
- one update line, only when a newer CLI exists; `u` runs `aw self update`.

Keys: `↑↓` move · `⏎` open or run · `esc` back · `y`/`n` confirm or cancel · `r` refresh · `q` quit · `u` update (only with the update line). Each view shows only the keys it accepts. Outside a hub, `aw` prints a line naming `aw hub-init` and exits 0. The TUI reads and writes no preferences.

Everything else is a command:

| Capability | Command |
|---|---|
| Host coverage, skills, hooks and hub visibility | `aw doctor` |
| Install, reinstall or uninstall the bundle in hosts; clean leftovers | `aw self install-skill --target <host\|all>`, `aw self uninstall`, `aw self clean-legacy` |
| Create the hub and declare sources | `aw hub-init --source …`, `aw add-source` |
| Remove a source | `aw remove-source` |
| Hub default branches | `aw hub-block --init --default-main-branch <b> --default-dev-branch <b> --default-qa-branch <b>` |
| Namespace | `aw self namespace --pin` |

### Namespace resolution

Hub artifacts live under `.<namespace>/`. Resolution order (first match wins):

1. `--namespace <name>` flag
2. `AW_NAMESPACE` env var
3. **Hub auto-detect** — the closest folder at or above cwd (never `$HOME`) with a single hidden `^\.[a-z][a-z0-9-]{1,30}$` folder holding the `agent-workflow.json` marker; two such folders at one level are an error
4. `~/.config/agent-workflow/namespace` user config
5. Default: `workflow` (→ `.workflow/`)

### CLI

The most used commands, each with what it does, are in [docs/commands.md](docs/commands.md).

Run `agent-workflow --help` (or `aw --help`) for the full list, or `agent-workflow <command> --help` for per-command flags.

## How it works

`aw` runs as one process per call. It resolves the hub from the working folder, runs one registered command and prints its result as JSON or as text for a person. The coding agent reaches it through the installed `w` skill and the host's `SessionStart` hook. It talks to the npm registry, each source's git remote and Herdr only when a command asks for them. It opens no database connection.

![Context diagram of agent-workflow-cli](docs/architecture/context.svg)

The full picture is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Contributing

Issues and pull requests are welcome.

## License

Copyright © 2026 Jesús Loayza (Tacuchi)

Licensed under the **GNU Affero General Public License v3.0 or later** (`AGPL-3.0-or-later`) — see [`LICENSE`](LICENSE).

In plain terms: anyone — including companies — may use, study, modify, and share this software for free, even commercially. But any copy you distribute, and any modified version you run as a network service, must stay open under this same license. It can never be turned into a closed-source/proprietary product.
