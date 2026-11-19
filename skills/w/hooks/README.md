# hooks — host hook template

`hooks.template.json` wires the host (Claude Code) to the `agent-workflow` runtime hooks. Merge it into your host's user-level hook config (e.g. `~/.claude/settings.json`); the installer does this automatically for Claude.

> **Agnostic binding.** Hooks are **inherently host-specific**: they bind the namespace to the host. aw keeps no state between turns, so no hook writes or restores anything around a compaction.

| Event | Hook | Purpose |
|---|---|---|
| `SessionStart` | namespace pin | Pins the hub namespace to `workflow` (so `.workflow/` resolves). |

> **Reinstalling cleans every event.** `aw self install-hooks` removes the entries aw owns from **every** event of the host config — not only the ones the template emits — before writing the current ones; the person's own entries stay. `aw doctor` reports an agent-workflow hook that still calls a retired command and names `aw self install-hooks` as the fix.
