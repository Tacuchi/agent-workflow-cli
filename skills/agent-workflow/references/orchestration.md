# Orchestration

Decision-support commands the lifecycle skill uses during planning and execution: when to plan, when the topic changed, which specialty to compose, what phase you are in, what the workspace stack looks like.

## auto-plan-decide

Decide whether an OBJETIVO needs full planning, lite planning, or skip-to-execution. Returns a recommendation plus an estimated effort in hours.

```bash
agent-workflow auto-plan-decide --objetivo "Bug: login redirect loop"
agent-workflow auto-plan-decide --objetivo-file .qtc/sessions/sessionNNN-.../OBJETIVO.md
```

Output:

```json
{ "scope": "lite", "rationale": "...", "eta_hours": 2.0 }
```

`scope` is one of `skip` | `lite` | `full`.

## topic-change-check

Detect whether a fresh user request diverges from the active session's OBJETIVO. Used to suggest opening a new session instead of polluting the current one.

```bash
agent-workflow topic-change-check \
  --objetivo-file .qtc/sessions/sessionNNN/OBJETIVO.md \
  --request "Quiero refactorizar el módulo de pagos"
```

Both `--objetivo` (or `--objetivo-file`) and `--request` are required.

## specialty-choose

Recommend specialty skills (and whether to invoke them explicitly) for a given phase + OBJETIVO. The host plugin can register specialty workflows; this command surfaces the matches.

```bash
agent-workflow specialty-choose --phase execution --objetivo "Construir CRUD de productos"
agent-workflow specialty-choose --phase planning --objetivo-file path/to/OBJETIVO.md
```

`--phase` is required. `--objetivo` (or `--objetivo-file`) is optional but recommended.

## phase-detect

Suggest the current session phase from the artifacts on disk (no mutation). Inspects which of `OBJETIVO.md`, `TASKS.md`, `DECISIONES.md`, `CHECKPOINT.md`, etc. are present and how complete they are.

```bash
agent-workflow phase-detect --code session035
```

## phase-next

Advance the session phase to the next slot in the lifecycle (planning → execution → validation → closure). Mutates the project block. May emit two JSON objects: project-md upsert + phase-next result.

```bash
agent-workflow phase-next --code session035
```

## stack

Detect the project stack — language, framework, database, build tool — by scanning the project root.

```bash
agent-workflow stack
agent-workflow stack --project-dir /Users/me/Git/some-repo
```

## workflows

Dump registered specialty workflows. Empty when no flow plugin is loaded; useful for diagnostics.

```bash
agent-workflow workflows
```

## skill-index

Lazy-load the skill index of the host plugin (frontmatter only — does not load skill bodies).

```bash
agent-workflow skill-index --plugin-root /Users/me/Git/core-workflow-plugin
agent-workflow skill-index --plugin-root /path --flow dev
agent-workflow skill-index --plugin-root /path --exported-only
```
