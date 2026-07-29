# LAUNCH-DETECTION — how the run command and the launch mode are derived

Loaded when the CLI's detection is wrong, ambiguous or must be overridden (signal `detection`).

## Detection (how "run the project locally" is derived)

- **npm** — a run script first (`dev` > `start` > `serve`, → `server`); else a CLI/app entry
  (`bin` > `main`) run with `node`, **building first** (`npm run build`) when a `build` script
  exists — a TypeScript CLI runs from its compiled output (→ `interactive`).
- **gradle** / **maven** — `./gradlew bootRun` / `./mvnw spring-boot:run` (`server`).
- **angular** — `npm start` (`server`).
- **Launch mode** governs how the TUI "Lanzar" (and the wrapper) run the app: `interactive` =
  foreground, owns the TTY (the UI appears); `server` = backgrounded, output tee'd to the log.
  The heuristic guesses it; `--mode` overrides. A `build` step, when present, runs before the
  launch in both modes.

## Behavior

- **Idempotent** — a pristine generated file is refreshed; a hand-edited one (its hash marker no
  longer matches) is **preserved**. `--force` overwrites hand-edited files too (reported as
  `overwritten`).
- **`--source <alias>`** (repeatable) restricts to the given sources; default = every declared source.
- **`--mode interactive|server`** overrides the detected mode for the selected source(s).
- **`--command "<cmd>"`** overrides the run command for a **single** selected source
  (self-contained: it drops the auto build).
- **`--dry-run`** classifies every file and writes nothing.
