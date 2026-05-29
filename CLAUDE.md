# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@tacuchi/agent-workflow-cli` — an agnostic CLI (bins `agent-workflow` and `aw`) plus a bundled universal `agent-workflow` SKILL that drives AI session-lifecycle workflows. Published to npm; the tarball ships `dist/` + `skills/`. `self install-skill` / `self install-hooks` copy the SKILL, slash commands, and hooks into host agent dirs (Claude/Codex/Warp/OZ).

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
- The `@` → `src` alias exists ONLY in `vitest.config.ts`. Do NOT use `@/...` imports in `src/` — `tsconfig.json` has no `paths` and `tsc` will fail. Use relative paths in source.
- `exactOptionalPropertyTypes` is on — set optional properties with the spread idiom: `{ ...(x !== undefined ? { x } : {}) }`.

## Architecture

- Hexagonal: `domain/` (pure types, no I/O) → `ports/` (interfaces) → `adapters/` (Node implementations). Business logic lives in `application/*-service.ts` and must be I/O-free — all fs/env/git/process access goes through ports injected via `CliContext`.
- CLI: every subcommand is a `QtcCommand` in `src/cli/commands/`, registered in `src/cli/main.ts` and slotted into a family in `src/cli/help-groups.ts`. Adding a command means doing both.
- Namespace abstraction: all workspace artifacts live under `.<namespace>/` (default `agent-workflow` → `.agent-workflow/`; fixtures use `.workflow/`). Resolved via `--namespace` flag → `AW_NAMESPACE` → user config → workspace auto-detect → default.
- `skills/agent-workflow/` is pure markdown + JSON — NOT compiled by `tsc` (which builds `src/` only). It ships in the npm tarball.

## Conventions / decisions

- Manual schema validation — NO Zod (DEC-001). Throw `Error` with a `code` string + `message`; the CLI layer catches and emits `{ ok: false, error: { code, message } }`.
- Commits: Conventional Commits `type(scope): subject`. Subject prose in **Spanish**; `type`/`scope` tokens in English. Append a trailing ` sessionNNN` tag (e.g. `fix(cli): corrige parser session104`). Releases: `chore: release vX.Y.Z sessionNNN`.
- Branches: `feature/<name>`, integrated into `main`. Code/comments in English; commit messages and `CHANGELOG.md` in Spanish (Keep a Changelog + SemVer).

## Tooling note

The `AW-PROJECT` block (sections Proyecto/Fuentes/Stack/Status) is a managed block written into CLAUDE.md/AGENTS.md by `/agent-workflow:project-init`. If it appears, treat it as tool-owned — keep hand-authored guidance outside it.

<!-- WORKFLOW-PROJECT-START -->
## Proyecto

`@tacuchi/agent-workflow-cli` (bins agent-workflow/aw) — CLI agnóstico + SKILL universal que conduce workflows de ciclo de vida de sesiones de IA (planning → execution → validation → closure). Publicado en npm; instala SKILL/comandos/hooks en agentes host (Claude/Codex/Warp/OZ).

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| agent-workflow-cli | /Users/tacuchi/Git/agent-workflow-cli | main |

## Stack

- Lenguaje: TypeScript
- Framework: React
- Build: npm

## Status

- Sesiones activas: _ninguna_
- Última actividad: 2026-05-28 22:21
- Histórico: `.workflow/HISTORY.md`
<!-- WORKFLOW-PROJECT-END -->
