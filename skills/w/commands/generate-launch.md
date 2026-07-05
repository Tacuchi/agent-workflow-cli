---
description: "(Re)generates the per-source launch scripts (.workflow/launch/<alias>/ — launch.json + run.sh + run.ps1) by detecting each source's stack. Idempotent: pristine files regenerate, hand-edited ones are preserved (--force overwrites). Backed by `aw generate-launch`. Transversal command (not a flow); no session, never touches docs/."
argument-hint: "[--source <alias>] [--force] [--dry-run]"
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# generate-launch — (re)generate source launch scripts (transversal)

Single-pass, **no loop, no session**, **never writes `docs/`**. **Transversal** command (belongs to no SPEC / PLAN / QUICK flow). Everything user-facing (the summary) goes in the **user's language**.

Rebuilds the launch artifacts the local-run flow uses (`.workflow/launch/<alias>/`). They are normally born on demand at the first launch; this command lets you build or refresh them explicitly — after adding a `dev`/`start` script, changing `.env` profiles, or to update a source that was not launchable at init time.

## Run

1. Run `aw generate-launch [--source <alias>] [--force] [--dry-run]` (backed by `generate-launch-service`; reads the sources from the WORKSPACE block).
2. Render a readable summary from the JSON — per source: `stack`, whether it is `launchable`, the detected `run` command (e.g. `npm run build && node dist/cli/main.js`), and the per-file outcome (`created` / `regenerated` / `preserved` / `overwritten`). Do **not** dump raw JSON.
3. Call out the non-launchable sources: `launchable: false` (descriptor `command: null`) means nothing runnable was detected. The generated `run.sh` is then a stub the user completes. A source is a genuine non-app (e.g. a docs/plugins repo with no run target); a real app that lands here is a detection gap worth reporting.
4. Report `unknown_aliases` (a `--source` that matches no declared source) and `missing_sources` (a declared path absent on disk — skipped) when present.

Detection (how "run the project locally" is derived):

- **npm** — a run script first (`dev` > `start` > `serve`); else a CLI/app entry (`bin` > `main`) run with `node`, **building first** (`npm run build`) when a `build` script exists — a TypeScript CLI runs from its compiled output.
- **gradle** / **maven** — `./gradlew bootRun` / `./mvnw spring-boot:run`. **angular** — `npm start`.
- When a `build` step is detected, `run.sh`/`run.ps1` run it before the launch (and the TUI "Lanzar" does too).

Behavior:

- **Idempotent** — a pristine generated file is refreshed; a hand-edited one (its hash marker no longer matches) is **preserved**. `--force` overwrites hand-edited files too (reported as `overwritten`).
- **`--source <alias>`** (repeatable) restricts to the given sources; default = every declared source.
- **`--dry-run`** classifies every file and writes nothing.

## Plan mode

Run `aw generate-launch --dry-run` and report, per source, what it would create / regenerate / preserve — without writing any file.

## Resources

- CLI: `aw generate-launch` (service `generate-launch-service`; engine `source-launch-scripts-service`)
- Related: the launch flow generates these on demand at the first launch; `/w:workspace-init` scaffolds nothing here.
