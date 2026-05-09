# Dev-only utilities

Operational helpers for plugin authors and harness diagnostics. Not part of the everyday session flow.

## harness

Detect which host harness is running the CLI: `claude-code`, `codex`, or `unknown`.

```bash
agent-workflow harness
```

Output:

```json
{ "harness": "claude-code", "evidence": ["env:CLAUDE_PROJECT_DIR"] }
```

## profiles

Resolve user preferences from the namespace's `user-config.md`.

```bash
agent-workflow profiles
```

Returns the parsed key-value preferences (e.g. `delegate_to_subagent`, `compact_threshold`).

## logs

View or clear the CLI log file.

```bash
agent-workflow logs                # dump full log
agent-workflow logs --tail 50      # last 50 lines
agent-workflow logs --clear        # truncate
```

The log file lives at `~/.<namespace>/lib/logs/agent-workflow.log` (or equivalent for the resolved namespace).

## next-number

Compute the next NNN correlative for a directory. Used by `session-create` and the SQL release tooling, but available standalone for plugin authors building their own correlatives.

```bash
agent-workflow next-number /path/to/sessions
agent-workflow next-number .workflow/sessions
```

The directory argument is positional (not a flag).
