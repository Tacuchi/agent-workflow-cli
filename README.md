# @tacuchi/agent-workflow-cli

Agnostic runtime CLI for **Workline** — the **stages + loops + artifacts** system for agent work. Bundles the universal **`w`** skill set (`w` = *workline*) and pairs with optional company-specific plugins for multi-empresa parametrization.

The CLI exposes two binaries: `agent-workflow` (canonical) and `aw` (short alias).

## Install

```bash
npm install -g @tacuchi/agent-workflow-cli
```

## The model — stages + loops + artifacts

Workline has three layers plus a permanent `docs/` zone:

- **Layer 1 · Commands** (`/w:*`) — the only thing the user invokes:
  - **SPEC** — `/w:spec-new` (single-pass draft after a bounded reconnaissance of the sources; may split into sibling specs) → `/w:spec-refine` (gap-driven loop; converges at `status: ready-for-plan` — the blocking functional decisions closed, the technical ones declared for PLAN) → `docs/specs/`.
  - **PLAN** — `/w:plan-new` → (`/w:plan-refine` — aux, optional) → `/w:plan-exec` → `docs/plans/` (the plan loops may split into sibling plans). A plan is a sequence of **functional states**: every phase names a verifiable state, carries its own primary proof, and — **only when the change carries temporary behavior** — declares where a simulation lives and when it retires. Ticking every checkbox is not validation, and validating every phase is not closing the plan.
  - **QUICK** — `/w:quick` — lightweight shortcut; escalates live to SPEC when the goal outgrows a quick.
  - **EXPORTS** — `/w:export-scripts` · `export-manuals` · `export-diagrams` · `export-reports` (the only path that promotes artifacts to `docs/`).
  - **Bootstrap** — `/w:workspace-init` turns any folder into a workspace (1+ sources; no project/hub distinction).
  - **Transversal** — `/w:status` · `/w:resume` (read-only: composes `/w:status` and proposes how to continue, routed to the target command) · `/w:fix-git` · `/w:generate-launch` · `/w:persist` (persists in-conversation work into `docs/` — classify → `docs/research` · spec draft · plan adoption; the host→`docs/` counterpart of `export-*`).
- **Layer 2 · Loops** — the AI runs them whole: `spec-refine-loop` · `plan-new-loop` · `plan-refine-loop` · `plan-exec-loop` · `quick-loop` — all heirs of the shared engine `skills/w/loops/CHASSIS.md` (+ `CODE-POLICIES.md` for the code-editing loops). Each loop is a **persistent goal** that runs until its success criteria are green (verification-first); gap-driven, with **structured-choice** lifecycle control (compact/close — `AskUserQuestion` on Claude Code, numbered markdown elsewhere) and resumable `CHECKPOINT`.
- **Layer 3 · Sessions + artifacts** — internal, ephemeral process state under `.workflow/sessions/` (`SESSION` · `CHECKPOINT` · `BACKLOG` · `SCRIPTS.sql` · `ANALYSIS-FILE` · `CONCLUSIONS` · `DECISION` · …). Sessions are slug-named folders, created by loops, never by the user.

**Pluggable capabilities.** Loops compose capability **roles** (`ui-design`, `sql`, `git`, `research`, `diagrams`, `overview`); the concrete skill bound to each role is resolved via `.workflow/skills.toml` (cascade: built-in default → `~/.workflow/skills.toml` → workspace). Inspect bindings with `aw skills` (advisory: it also warns when a bound skill is not installed in the standard skill roots — the binding itself is not auto-validated). Code/testing/writing conventions **and tool authoring** (`creating-tools`) are **not** roles — they're ambient skills the host auto-applies when present, independent of Workline. Per-source launch scripts live under `.workflow/launch/` (machine-specific, gitignored); created tools live under `docs/tools/`.

**Invariants.** No auto-export (only `export-*` writes `docs/`); the spec and plan are documents, not artifacts; DB scripts-only (never executes DML/DDL); git-safe (verifies the per-source working branch before edits; proposes commits).

### PLAN — a plan is a sequence of functional states

A `### Fn` phase is a **verifiable state of the system**, not a batch of technical tasks. It answers one question: *what can the system do or demonstrate at the end that it could not at the start?* The contract is defined **once** in `skills/w/loops/plan-new-loop/LOOP.md` (§ *Phase contract*); the other two plan loops reference it and never redefine it.

- **Phase shape** — required always: `Resultado` · `Trabajo` · `Validación de fase` · `Condición de salida`. Conditional, each only when its condition holds: `Estado inicial`, `Recorrido afectado`, `Dependencias`, `Límite de simulación` and `Diferido`. A conditional block is **never written empty** — no `no aplica` placeholders. Granularity is semantic: a task is a unit of purpose that may touch several files, never an edit operation ("create class X").
- **Phase state** — one `> Estado:` line per phase (`pendiente` | `en ejecución` | `bloqueada` | `validada`), machine state that `aw status` parses. A phase reaches `validada` only with its proof green, its exit condition true and the closing review gate passed — **never** because its checkboxes are ticked. A `bloqueada` phase states what it waits on in its own `> Bloqueo:` line.
- **Plan state** — one `> Estado:` line under the title (`open` | `done`), plus a `> Cierre: YYYY-MM-DD · sesión NNN` line on close. It is the third axis, not a summary of the other two: every phase validated with no closure is a plan still `open`, awaiting its **final validation**.
- **Temporary simulation** — **only when the change carries one**, and then planned with a lifecycle: where it is born, how it moves (`antes → después`), which phase retires it, and what prevents it from being selected in a production runtime. A change with no temporary behavior declares no boundary and no gate asks for one. A stub still live on the main path with no declared removal is a review finding.
- **Evidence** — one primary proof per phase; focused tests only where a layer owns rules, transformation, persistence or integration; risk tests on top of those. Tests that only mirror structure are flagged `overtest` at the closing review gate.

The authoring side and the execution side share one gate, seen from both ends:

```
  plan-new ──┐
             ├──▶ executability gate ──▶ plan-exec ──▶ phase cycle ──▶ validada
  plan-refine ┘                              │
                                             ├─ structural deviation ─▶ plan-refine
                                             └─ functional change ────▶ spec-refine
```

`plan-refine` converges when the plan is executable; `plan-exec` re-checks that same shape on entry, normalizes only minor gaps with consent, and returns the work instead of redesigning it silently.

Progress is reported on **three** independent axes, and none stands in for another:

| Axis | Question | Field |
|---|---|---|
| task completed | what work was done | `progress_pct` (checkbox-derived, unchanged) |
| phase validated | what functional state was demonstrated | `phases_validated` / `phases_total` |
| plan closed | whether the whole solution was validated | `plan_state` |

A plan at 100% of checkboxes with zero validated phases is work implemented, not validated. A plan with every phase validated and no closure is `open` with `final_validation_pending: true` — the **final validation** never ran. A plan declaring `done` over open tasks or unvalidated phases is `inconsistent`, reported as a contradiction rather than a closure. Both `/w:status` and `/w:resume` say so, and a `bloqueada` phase is shown with the `> Bloqueo:` reason that says what unblocks it.

## Bundled SKILL

The published tarball bundles the universal skill set under `skills/w/`. Install it into your host with `--target` (required):

```bash
agent-workflow self install --target claude     # or: codex · warp · oz · agents · gemini · opencode · crush
agent-workflow self install --target all --confirm-all
agent-workflow self detect-hosts                # which hosts are present + already have it
agent-workflow self install --target claude --dry-run
```

By default the CLI clears the target host's plugin cache before installing (opt out with `--keep-cache`) and removes legacy artifacts from prior installs — the old `agent-workflow`-named SKILL, the stale `/agent-workflow:*` slash commands, the inert `~/.codex/commands/w` dir ≤v18 wrote, the pre-rename `agent-workflow-*` flattened sub-skills, and skill roots the host never reads (`~/.crush/skills` ≤v19.1, ownership-verified) — keep them with `--keep-legacy`.

### Per-target install matrix

`self install --target <host>` installs **SKILL + user-level slash commands + hooks** in one shot, scaled to what the host supports:

| Host | SKILL | User-level commands | Hooks |
|---|---|---|---|
| `claude` | `~/.claude/skills/w/` | `~/.claude/commands/w/<n>.md` → `/w:<n>` | `~/.claude/settings.json` (JSON merge + backup) |
| `codex` | `~/.codex/skills/w/` | synthesized skills `~/.codex/skills/w-<n>/` → `$w-<n>` (Codex reads no commands dir) | skipped (config.toml not yet wired) |
| `warp` | `~/.warp/skills/w/` | synthesized skills `~/.warp/skills/w-<n>/` → `/w-<n>` | skipped (no hook system) |
| `oz` | `~/.agents/skills/w/` | synthesized skills `~/.agents/skills/w-<n>/` | skipped |
| `agents` | `~/.agents/skills/w/` | skipped (shared dir, not a host) | skipped |
| `gemini` | `~/.gemini/skills/w/` | synthesized skills `~/.gemini/skills/w-<n>/` (Antigravity `agy`) + `~/.gemini/commands/w/<n>.toml` → `/w:<n>` (legacy Gemini CLI) | skipped |
| `opencode` | `~/.opencode/skills/w/` | `~/.opencode/command/w/<n>.md` → `/w/<n>` | skipped |
| `crush` | `~/.config/crush/skills/w/` (XDG — the only global root Crush reads; `~/.crush` holds commands only) | `~/.crush/commands/w/<n>.md` → palette `user:w:<n>` | skipped |

The bundle's internal manuals (`loops/*/LOOP.md`, `roles/*/ROLE.md`, `exports/*/EXPORT.md`, `harness/HARNESS.md`) are deliberately **not** `SKILL.md` files, so hosts that scan skill roots recursively (Codex, OpenCode, Crush) never list them as invocable skills — only the commands and the `w` orientation skill surface. Where a layer is skipped, the SKILL is sufficient — the AI reads it and invokes `agent-workflow <subcommand>` directly.

Opt-out flags: `--skill-only`, `--no-commands`, `--no-hooks`. Override the source with `--from /path/to/skills/w`. Other flags: `--confirm-all` (required with `--target all`), `--keep-cache`, `--force`, `--dry-run`.

## TUI

Running `agent-workflow` (or `aw`) with no arguments opens the tab-based TUI:

| Tab | What it does |
|---|---|
| **Status** | Doctor dashboard: CLI / hosts / hooks / MCP tiles + daily operational logs. The hosts tile jumps to [Workline]. |
| **Workline** | Per-host administration of the bundled `w` SKILL (install / reinstall / uninstall, `hooks armed` state) plus a compact flows overview. |
| **Project** | Workspace sources, branches and git-flow actions. |
| **MCP** | dbhub connections. **Install writes the host's user-scope config** (e.g. `~/.claude.json`, `~/.codex/config.toml`) — never the project `.mcp.json`; install once, use it in every project. `aw mcp setup` remains the workspace-capable CLI path (workspace by default; `--workspace <dir>` / `--global --force`). |
| **Skills** | Standalone third-party skills manager (skills.sh model): register from `owner/repo`, a git URL (`#ref` supported) or an absolute local path; install materializes a canonical copy in `~/.agents/skills/<name>` (the open-standard dir every non-Claude host scans) plus a symlink replica in `~/.claude/skills/<name>` (copy fallback where symlinks are unavailable). Seeded with the recommended external skills from the companion marketplace README — keep both lists in sync. |
| **Config** | Namespace, host-targeting preferences, and the workspace branch defaults (written to the WORKSPACE block). |

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
- `git-flow <sync|to-dev|to-qa|to-prod> [--source|--all] [--target] [--dry-run]` — run the per-source branch flows (sync working ← base, promote to dev/QA/prod) with conflict-pause; `--all` processes every source and reports each one. Also surfaced as Project-tab actions.
- `release-data` — corpus reader backing the `export-*` skills.
- `self install-skill` / `self doctor` / `self update` / `mcp` — CLI maintenance.

Run `agent-workflow --help` (or `aw --help`) for the full list, or `agent-workflow <command> --help` for per-command flags.

## Versioning

Semantic Versioning. Major bumps are reserved for breaking changes to commands, flags, or output schemas. See `CHANGELOG.md`.

## License

Copyright © 2026 Jesús Loayza (Tacuchi)

Licensed under the **GNU Affero General Public License v3.0 or later** (`AGPL-3.0-or-later`) — see [`LICENSE`](LICENSE).

In plain terms: anyone — including companies — may use, study, modify, and share this software for free, even commercially. But any copy you distribute, and any modified version you run as a network service, must stay open under this same license. It can never be turned into a closed-source/proprietary product.
