---
description: "Use when the launch artifacts under `.workflow/launch/<alias>/` must be built or refreshed — a new start script, or a launch that runs the wrong way. Backed by `aw generate-launch`. Transversal, never writes `docs/`."
argument-hint: "[--source <alias>] [--mode interactive|server] [--command <cmd>] [--force] [--dry-run]"
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# generate-launch — (re)generate source launch scripts (transversal)

Single-pass, no loop, no session, **never writes `docs/`**. **Transversal** (no flow). User-facing text in the **user's language**. Rebuilds `.workflow/launch/<alias>/` (launch.json + run.sh + run.ps1), otherwise born on demand at first launch.

## Run

1. **Detect** — `aw generate-launch --dry-run [--source <alias>]`. Per source: `stack`, `launchable`, the detected `run` and `mode` (`interactive` | `server`).
2. **Confirm (structured-choice)** — per **launchable** source; recommended = the detected mode. Use the canonical [option shape](../loops/CHASSIS.md#structured-choice-design--batching) and [per-host binding](../harness/HARNESS.md#harness-binding-matrix).
   - **Interactive** — foreground, owns a real TTY. TUIs / REPLs / interactive CLIs.
   - **Server** — background + log window (close-to-stop). Dev servers, services.
   - **Custom command** — the user gives the exact run command (optional).

   Batch questions; skip when unambiguous. Never silently pick a mode. The bug this guards: a **TUI launched as `server` shows no UI** — its stdout is a pipe, not a TTY, so it falls back to help output.
3. **Generate** — `aw generate-launch --source <alias> [--mode interactive|server] [--command "<cmd>"] [--force]`.
4. **Report** — from the JSON, per source: `stack`, `launchable`, `mode`, `run` and each file's outcome (`created` / `regenerated` / `preserved` / `overwritten`). Never dump raw JSON. Report `unknown_aliases` / `missing_sources`. A real app reported non-launchable is a detection gap worth naming.

## More context

`aw context-plan --command generate-launch --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists:

- `detection` — the CLI's automatic detection of how to run the project was wrong or ambiguous → [`../modules/LAUNCH-DETECTION.md`](../modules/LAUNCH-DETECTION.md)
