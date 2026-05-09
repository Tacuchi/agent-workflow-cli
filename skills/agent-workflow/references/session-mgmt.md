# Session management

Commands that create, list, resume, and close sessions, plus the consolidated artifact dump.

A session lives at `<workspace>/.<namespace>/sessions/sessionNNN-<flow>-<slug>/` and is registered as a row in `<workspace>/.<namespace>/HISTORY.md` plus an entry in the `<NS>-PROJECT` block of `CLAUDE.md` / `AGENTS.md`.

## sessions

List sessions with state counts and the next correlative number.

```bash
agent-workflow sessions
agent-workflow sessions --state active
agent-workflow sessions --state closed
agent-workflow sessions --all                # alias of --state all
agent-workflow sessions --include-legacy     # also walk .claude/.codex legacy folders
agent-workflow sessions --verbose            # include extra metadata per session
```

Output (truncated):

```json
{
  "namespace": "agent-workflow",
  "next_number": 36,
  "active": [{ "code": "session035", "folder": "...", "flow": "dev" }],
  "closed_count": 34,
  "total": 35
}
```

## session-create

Create a new session: scaffolds the folder, writes a stub `OBJETIVO.md`, adds a row to `HISTORY.md`, and registers the session in the project block. Returns the upserted project block JSON.

```bash
agent-workflow session-create \
  --flow dev \
  --name fix-login-loop \
  --objetivo "Resolver redirect loop tras login en producción"

# With phased / refactor metadata:
agent-workflow session-create --flow dev --name normalize-codusuario \
  --tipo refactor \
  --branches "core:feature/normalize,solicitud:feature/normalize"

# Origen handoff (this session continues from a previous one):
agent-workflow session-create --flow dev --name aw-skill-repo \
  --from "design:034"
```

Flags:

| Flag | Required | Notes |
|---|---|---|
| `--flow <core\|dev\|design\|analyze>` | yes | Determines slug prefix and downstream specialty composition. |
| `--name <slug>` | yes | Kebab-case; becomes the session slug suffix. |
| `--objetivo <text>` | yes | Free-form requirement description that lands in `OBJETIVO.md`. |
| `--branches <alias:branch[,alias:branch]>` | no | Pre-fills the work branch table. |
| `--from <flow:NNN>` | no | Records origin handoff. |
| `--tipo <feature\|refactor\|bugfix>` | no | Persisted in `OBJETIVO.md` for dev sessions. |
| `--modalidad <tecnica\|datos\|incidente>` | no | Persisted for analyze sessions. |

## session-resume

Load the resume payload (objetivo + phase) for a session.

```bash
agent-workflow session-resume                      # active session in workspace
agent-workflow session-resume --code session035    # explicit code
```

Use this for the cold-start flow when you do not have a CHECKPOINT.md yet (newer sessions: prefer `checkpoint-read` + `resume-summary`).

## session-close

Close a session: marks the HISTORY row as closed and removes the entry from `<NS>-PROJECT`. Emits two JSON objects on stdout (project-md upsert first, then close result), mirroring the legacy Python contract.

```bash
agent-workflow session-close --code session035
agent-workflow session-close --code session035 \
  --graduated-decisions "DEC-007,DEC-009" \
  --graduated-plan "TASKS" \
  --graduated-scripts "019" \
  --refs "[CHECKPOINT](.workflow/sessions/session035-dev-aw-skill-repo/CHECKPOINT.md)"
```

Flags:

| Flag | Notes |
|---|---|
| `--code <sessionNNN>` | Required if multiple active sessions. |
| `--graduated-decisions <list>` | Comma-separated DEC-NNN ids that were promoted to `docs/decisiones/`. |
| `--graduated-plan <slug>` | Marks plan graduation (typically `TASKS`). |
| `--graduated-scripts <NNN>` | SQL release bundle correlative if applicable. |
| `--graduated-design <slug>` | Design entrega graduation. |
| `--graduated-rfc <slug>` | RFC graduation. |
| `--refs <markdown>` | Replace the auto-generated Refs cell in HISTORY.md. |

## session-artifacts

Consolidated dump of a session's artifacts (OBJETIVO + TASKS + flags). Useful for prompt context or for debugging when you want everything at once.

```bash
agent-workflow session-artifacts --code session035
agent-workflow session-artifacts --code session035 --verbose
```

Flags: `--code <sessionNNN>`, `--verbose`.
