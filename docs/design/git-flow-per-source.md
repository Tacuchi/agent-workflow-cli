# Design — per-source git-flow actions

> Status: approved (2026-06-19). Per-source git workflow actions (sync / promote to dev / to QA / to prod) exposed in the TUI Project tab and as a CLI command, executed against real git with conflict-pause.
>
> **Amended 2026-07-20** (spec 008 · plan 007), two changes that supersede the text below:
> 1. **Branch roles resolve per-source → workspace default → fallback.** The WORKSPACE block gained a
>    `- Ramas por defecto:` entry (`principal` / `desarrollo` / `qa`, fallbacks `main` / `development` /
>    `qa`) editable from the [Config] tab. A role no longer has to be declared per source, so the
>    "No QA branch declared for this source" validation is gone — every role always resolves.
> 2. **`--all` is continue-on-failure, not fail-stop.** See § *Batch semantics*.
>
> A fourth action, **to-dev**, was added as a mirror of to-qa (destination = the workspace
> `desarrollo` default; there is deliberately no per-source dev branch). It no-ops when the resolved
> work branch already IS the dev branch.

## Context

Users routinely run a fixed git sequence per source (repo) before committing / promoting: sync the working branch from the base branch, promote to a QA branch, or promote to prod. Today this is manual (the AI was asked to enumerate the 8 steps ad-hoc). This feature makes those flows first-class, per source, optionally across all sources (hub).

Branch roles per source (terminology example in parens):
- **prod** / principal — the base + prod-merge target (`certificacion`). Already recorded as the Fuentes "Rama principal".
- **work** / trabajo — the feature branch (`feature/…`). Already recorded as "Ramas de trabajo actuales".
- **qa** — the QA branch (`desarrollo`). Recorded as "Ramas QA actuales".
- **dev** — the development branch (`development`). Workspace-level only, from `Ramas por defecto`.

## Decisions (locked)

1. **Branch model**: roles recorded per source + per-action **target override** (you can enter/indicate a different destination branch at action time). *(Amended: a workspace-level default now backs every role — see the header.)*
2. **Execution**: run real git via `GitPort`, **pausing on merge conflict** (report conflicted files; user resolves; re-run the same action continues from the in-progress state). User-initiated ⇒ executing (incl. push) is authorized.
3. **Push**: promotion actions (→ QA / → prod) **push automatically**.
4. **QA branch**: recorded per source (new `qa_branches` map), set via `workspace-init --qa-branch` + a new `set-qa-branch` command (mirrors `set-working-branch`).
5. **Shape**: a `git-flow` application service (uses `GitPort`) + CLI command + thin Project-tab actions (approach A). The CLI command means the AI/loops can also invoke the flows.

## Action menu (per source)

`Actualizar` and the old "prepare commit" collapse into one: the commit happens between sync and push, so the working-branch push is part of the user/AI commit step, not a git-flow action. Four actions:

| Action | Sequence | Push |
|---|---|---|
| **sync** (Alinear con PROD) | `pull work` → `checkout prod` + `pull` → `checkout work` + `merge prod→work` | — (local) |
| **to-dev** (Enviar a Desarrollo) | sync + `checkout dev` + `pull` + `merge prod→dev` + `merge work→dev` | push `dev` |
| **to-qa** (Enviar a QA / desarrollo) | sync + `checkout qa` + `pull` + `merge prod→qa` + `merge work→qa` | push `qa` |
| **to-prod** (Enviar a PROD / certificacion) | sync + `checkout prod` + `pull` + `merge work→prod` | push `prod` |

to-dev and to-qa share one plan builder; they differ only in which role names the destination.

Each action: `--source <alias>` (one) or `--all` (every source); `--target <branch>` overrides the destination; `--dry-run` previews the step list. Branches resolve from the WORKSPACE block, **per source first and then the workspace default**:
prod = `main_branch` → `principal`, work = `working_branches[alias]` → `desarrollo`,
qa = `qa_branches[alias]` → `qa`, dev = `desarrollo` (no per-source value).

## Components

### GitPort extension (ports/git.ts + adapters/git-cli.ts + a fake for tests)
Add: `checkout(repo, branch)`, `pull(repo)`, `merge(repo, fromBranch)`, `push(repo, branch)`, and conflict/merge-state detection: `isMerging(repo)` + `conflictedFiles(repo)`. Existing `isGitRepo/currentBranch/changedFiles` stay. Each op returns enough to detect conflict (e.g. merge returns `{ ok: boolean; conflicted: string[] }`).

### git-flow-service.ts (application/)
`runGitFlow(fs, git, paths, { action: "sync"|"to-dev"|"to-qa"|"to-prod", source?: string, all?: boolean, target?: string, dryRun?: boolean }): Promise<GitFlowResult>`.
- Reads the WORKSPACE block (parseProjectBlock) → per-source branches.
- Builds the ordered step list for the action; executes each via GitPort.
- On a merge conflict: stop **that source**, return `{ source, paused_at, conflicted_files }` with its repo left mid-merge. Remaining sources (when `--all`) are still processed — see § *Batch semantics*.
- **Resume (stateless, idempotent replay)**: re-running the same action replays the plan from the start; completed merges are git no-ops (`git merge X` → "Already up to date") and pull/checkout/push are idempotent, so the resolved merge + all prior steps are skipped automatically — no persisted position, no off-by-one. Preconditions guard correctness: refuse to run while the repo is mid-merge (an unresolved conflict — resolve + commit first) or the working tree is dirty (would break `checkout`). Non-conflict git failures (checkout/pull/push) are caught and reported as `error`, not crashed.
- `dryRun`: return the step list without executing.
- Result: per-step `{ step, status: ok|conflict|skipped, detail }` + overall status.

### CLI command (cli/commands/git-flow.ts)
`aw git-flow <sync|to-dev|to-qa|to-prod> [--source <alias>] [--all] [--target <branch>] [--dry-run]`. Registered in main.ts + help-groups (Sources/Branches group). Thin wrapper over the service.

### set-qa-branch command (cli/commands/set-qa-branch.ts + reuse project-md-upsert)
`aw set-qa-branch <alias> <branch>` — upserts `qa_branches[alias]` in the WORKSPACE block (mirror of `set-working-branch`). workspace-init gains `--qa-branch alias:rama` (repeatable) passthrough.

### Project block (parser + render + project-md-upsert)
Add `qa_branches: Record<alias, branch>` parallel to `working_branches`: a new Status section (e.g. "Ramas QA actuales"). Parser parses it; render emits it when non-empty; project-md-upsert accepts a `qaBranches` input + a `set-qa-branch`-style op (or extend the working-branch op path).

### TUI Project tab
Per source: an actions affordance (submenu / keys) → `Alinear con PROD` · `Enviar a Desarrollo` · `Enviar a QA` · `Enviar a PROD`, plus an "all sources" variant. Invokes the git-flow service; renders step-by-step progress; on conflict shows the paused state + conflicted files + "resolve and re-run". (Lower priority than the CLI/service; can land after.)

## Safety / invariants

- User-initiated ⇒ executing git (incl. push) is authorized (distinct from the AI's autonomous git-safe policy).
- Never `--force` / `--no-verify` / `--amend`. Push is plain `git push <remote> <branch>` (or `git push` on the checked-out branch).
- `--dry-run` previews.

## Batch semantics (`--all`) — amended 2026-07-20

Sources are independent repositories, so one failing must not strand the rest. Superseding the
original fail-stop decision:

- **Every declared source is attempted**, in Fuentes order, and the result carries **one entry per
  source** with its own status and reason. No flag: this is the single behaviour of `--all`.
- **Overall status = worst case** (`error` > `conflict` > `ok`), so a later `ok` never masks an
  earlier failure. Exit codes unchanged: 1 on any error · 2 when only conflicts · 0 otherwise.
- **Stateless resume still holds with N sources**: the mid-merge precondition only stops the source
  that is actually mid-merge; re-running the action replays the whole batch and the already-applied
  merges are git no-ops. Sources sharing no state, a conflict in one never leaks into another.

## Testing

- Fake GitPort recording calls + scripted conflict on a given merge → assert the step sequence per action, the conflict-pause (stops, reports files), and the resume (continues from mid-merge state).
- Service unit tests for sync / to-qa / to-prod sequences + `--all` + `--target` override + `--dry-run`.
- CLI command parse + dispatch test.
- Parser/render round-trip for `qa_branches`; set-qa-branch + workspace-init `--qa-branch`.

## Files

- ADD: `src/ports/git.ts` (extend), `src/adapters/git-cli.ts` (extend), `src/application/git-flow-service.ts`, `src/cli/commands/git-flow.ts`, `src/cli/commands/set-qa-branch.ts`, tests.
- EDIT: `src/application/parsers/project-block.ts` + `render/project-block.ts` + `project-md-upsert-service.ts` (qa_branches), `src/cli/commands/workspace-init.ts` + `workspace-init-service.ts` (`--qa-branch`), `src/cli/main.ts` + `help-groups.ts` (register), `src/cli/tui/tabs/project-tab.tsx` (actions), `src/cli/tui/data/project-tab-data.ts` (expose qa branches).
