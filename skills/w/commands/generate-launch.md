---
description: "(Re)generates the per-source launch scripts (.workflow/launch/<alias>/ — launch.json + run.sh + run.ps1) by detecting each source's stack and launch mode (interactive TUI vs server). Idempotent: pristine files regenerate, hand-edited ones are preserved (--force overwrites). Confirms the mode/command via structured-choice when it matters. Backed by `aw generate-launch`. Transversal command (not a flow); no session, never touches docs/."
argument-hint: "[--source <alias>] [--mode interactive|server] [--command <cmd>] [--force] [--dry-run]"
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# generate-launch — (re)generate source launch scripts (transversal)

Single-pass, **no loop, no session**, **never writes `docs/`**. **Transversal** command (belongs to no SPEC / PLAN / QUICK flow). Everything user-facing (questions, summary) goes in the **user's language**.

Rebuilds the launch artifacts the local-run flow uses (`.workflow/launch/<alias>/`). They are normally born on demand at the first launch; this command lets you build or refresh them explicitly — after adding a start script, changing `.env` profiles, or to fix a launch that runs the wrong way.

## Run

1. **Detect** — run `aw generate-launch --dry-run [--source <alias>]` to get, per source: `stack`, `launchable`, the detected `run` command, and the launch `mode` (`interactive` | `server`).
2. **Confirm the launch (structured-choice)** — for each **launchable** source, confirm how it should run via *structured-choice* (recommended = the detected mode). Options:
   - **Interactive** — the app owns the terminal (foreground, real TTY). Required by TUIs / REPLs / interactive CLIs.
   - **Server** — background + log window (monitor live, close-to-stop). For dev servers and long-running services.
   - **Custom command** — the user provides the exact run command (optional).

   Batch the questions; skip when the answer is unambiguous. Never silently pick a mode the user might not want — the bug this guards: a **TUI launched as `server` shows no UI**, because its stdout is a pipe, not a TTY, so it falls back to help/CLI output.
3. **Generate** — write with the confirmed choice: `aw generate-launch --source <alias> [--mode interactive|server] [--command "<cmd>"] [--force]`. Without `--mode`/`--command`, the heuristic default is used.
4. **Report** — render a readable summary from the JSON (per source: `stack`, `launchable`, `mode`, `run`, per-file outcome `created` / `regenerated` / `preserved` / `overwritten`). Do **not** dump raw JSON. Report `unknown_aliases` / `missing_sources` when present. A non-launchable source is a genuine non-app (e.g. a docs/plugins repo); a real app that lands there is a detection gap worth reporting.

## Detection (how "run the project locally" is derived)

- **npm** — a run script first (`dev` > `start` > `serve`, → `server`); else a CLI/app entry (`bin` > `main`) run with `node`, **building first** (`npm run build`) when a `build` script exists — a TypeScript CLI runs from its compiled output (→ `interactive`).
- **gradle** / **maven** — `./gradlew bootRun` / `./mvnw spring-boot:run` (`server`). **angular** — `npm start` (`server`).
- **Launch mode** governs how the TUI "Lanzar" (and the wrapper) run the app: `interactive` = foreground, owns the TTY (the UI appears); `server` = backgrounded, output tee'd to the log. The heuristic guesses it; `--mode` overrides. A `build` step, when present, runs before the launch in both modes.

## Behavior

- **Idempotent** — a pristine generated file is refreshed; a hand-edited one (its hash marker no longer matches) is **preserved**. `--force` overwrites hand-edited files too (reported as `overwritten`).
- **`--source <alias>`** (repeatable) restricts to the given sources; default = every declared source.
- **`--mode interactive|server`** overrides the detected mode for the selected source(s).
- **`--command "<cmd>"`** overrides the run command for a **single** selected source (self-contained: drops the auto build).
- **`--dry-run`** classifies every file and writes nothing.

## Plan mode

Run `aw generate-launch --dry-run` and report, per source, the detected `run` + `mode` and what it would create / regenerate / preserve — without writing any file or asking.

## Resources

- CLI: `aw generate-launch` (service `generate-launch-service`; engine `source-launch-scripts-service`)
- Related: the launch flow generates these on demand at the first launch; `/w:workspace-init` scaffolds nothing here.
