# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository (Claude Code loads it via `CLAUDE.md`'s `@AGENTS.md` import).

## What this is

`@tacuchi/agent-workflow-cli` — an agnostic CLI (bins `agent-workflow` and `aw`) plus the bundled universal `w` SKILL (`skills/w/`) that drives AI development workflows (stages + loops). Published to npm; the tarball ships `dist/` + `skills/`. `self install --target <claude|codex|warp|oz|agents|gemini|opencode|crush>` copies the SKILL, command wrappers, and hooks into the host agent dirs.

## Commands

- `npm run build` — `tsc` → `dist/` (compiles `src/` only; tests and `skills/` are not compiled).
- `npm test` — `vitest run` (full suite). Single test by name: `npx vitest run -t "name"`; one file: `npx vitest run tests/x.test.ts`.
- `npm run test:golden` — snapshot tests under `tests/golden/` only.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — `biome check .` (lint **and** format check — this is Biome, not ESLint/Prettier). Apply fixes: `npm run lint:fix`. Format only: `npm run format`.
- `prepublishOnly` runs lint → typecheck → test → build. Never bypass it.

## Code style (Biome-enforced — see `biome.json`)

- 2-space indent, line width 100, LF endings, double quotes, semicolons always, trailing commas everywhere, always-parenthesized arrow params.
- Use `import type` / `export type` for type-only imports/exports — required (`verbatimModuleSyntax` is on); plain `import` for them is an error.
- Non-null assertions (`!`) are forbidden. Keep cognitive complexity per function ≤ 15 — extract helpers when over.
- No unused imports or variables (errors). Imports are auto-organized.

## TypeScript / ESM gotchas

- `module: NodeNext` — relative imports must include the explicit `.js` extension (e.g. `import { x } from "./foo.js"`), even from `.ts` source.
- `exactOptionalPropertyTypes` is on — set optional properties with the spread idiom: `{ ...(x !== undefined ? { x } : {}) }`.

## Architecture

- Hexagonal: `domain/` (pure types, no I/O) → `ports/` (interfaces) → `adapters/` (Node implementations). Business logic lives in `application/*-service.ts` and must be I/O-free — all fs/env/git/process access goes through ports injected via `CliContext`.
- CLI: every subcommand is a `QtcCommand` in `src/cli/commands/`, declared in `ALL_COMMANDS` (`src/cli/commands/index.ts`, which `main.ts` registers) and slotted into a family in `src/cli/help-groups.ts`. Adding a command means doing both.
- Namespace abstraction: all workspace artifacts live under `.<namespace>/` (default `workflow` → `.workflow/`). Resolved via `--namespace` flag → `AW_NAMESPACE` → workspace auto-detect → user config → default.
- `skills/w/` is pure markdown + JSON — NOT compiled by `tsc` (which builds `src/` only). It ships in the npm tarball.

## Conventions / decisions

- Manual schema validation — NO Zod (DEC-001). Throw `Error` with a `code` string + `message`; the CLI layer catches and emits `{ ok: false, error: { code, message } }`.
- Commits: Conventional Commits `type(scope): subject`. Subject prose in **Spanish**; `type`/`scope` tokens in English. Append a trailing ` sessionNNN` tag (e.g. `fix(cli): corrige parser session104`). Releases: `chore: release vX.Y.Z sessionNNN`.
- Branches: `feature/<name>`, integrated into `main`. Code/comments in English; commit messages and `CHANGELOG.md` in Spanish (Keep a Changelog + SemVer).

## Tooling note

The `WORKSPACE` block (sections Proyecto/Fuentes/Stack/Status) is a managed block written into CLAUDE.md/AGENTS.md by `/w:workspace-init`. If it appears, treat it as tool-owned — keep hand-authored guidance outside it.

## dev-conventions (universal — aplica también en subagentes/teams)

Las convenciones del plugin `dev-conventions` aplican en toda sesión Y en subagentes/teams (heredan este archivo). Donde esta guía sea más específica (formato de commit `type(scope): subject sessionNNN`, estilo Biome, gotchas ESM), **esa manda**. Lo de abajo es la base de seguridad/comportamiento que el repo no detallaba:

- **Git seguro:** proponer antes de commitear; nunca `push`/`--force`/`--amend`/`--no-verify` ni trailers `Co-Authored-By`/firmas de modelo sin pedido explícito.
- **Tests:** preguntar antes de correr el runner.
- **Prosa técnica:** frases cortas, listas sobre prosa, qué+por qué, sin relleno.
- **Código:** SOLID, fail-fast, DRY, sin secrets en código/logs, SQL parametrizado.

Detalle: skills `dev-conventions:*`.
