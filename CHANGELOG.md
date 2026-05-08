# Changelog

All notable changes to `@tacuchi/agent-workflow-cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.6.0] — 2026-05-07

**Minor — RFC 002 G4 UX polish + cleanup legacy + 0 lint complexity warnings (session013).** Cierra los 5 friction points (H-04..H-08) declarados en RFC 002 y reduce las 8 lint complexity warnings residuales del codebase a **0** (RFC 002 metric promise honrada).

### Added — UX

- **H-05 `--dry-run` en `aw self update`** (`src/application/self/update-self.ts`): cuando se pasa `--dry-run`, retorna `{command, would_run:true, exit_code:0, stdout:"", stderr:""}` sin invocar `npm install`. Permite scripts/CI verificar el comando sin efectos.
- **H-06 help grouping** (`src/cli/help-groups.ts` nuevo + `src/cli/main.ts`): el output de `aw --help` agrupa los 43 comandos en 10 familias con headers (Session lifecycle, Objetivo / Tasks, Checkpoint, Sources / Branches, Orchestration, Doctor / Data, Hooks, MCP, Dev-only, Self). Comandos no clasificados caen a "Other" automáticamente. Si agregás un comando, declaralo en `GROUPS` o aparece bajo "Other".
- **H-07 `aw self` sin sub** (`src/cli/commands/self.ts`): retorna `{ok:true, data:{subcommands:[...], help_hint:"..."}}` exit 0 (antes era error envelope). El usuario que invoca el comando padre obtiene un listado en lugar de un mensaje de error.

### Changed

- **H-04 fallback name** (`src/application/plugin-doctor-service.ts`): `aw plugin-doctor` ahora deriva `plugin` de `basename(pluginRoot)` cuando el manifest no tiene `name` explícito, en lugar del literal `${ns}-${flow}`. El fallback `${ns}-${flow}` se preserva para el caso degenerate `pluginRoot="/"` (basename vacío).
- **H-08 cleanup checks legacy** (`src/application/plugin-doctor-service.ts`): eliminadas todas las branches gateadas por `qtcContractVersion < 6.3` (per D4 RFC 002). Removidos los helpers `checkLegacyMarkers`, `readPluginVersionMarker`, `readMarkerText`, `checkPythonVersion`, `evaluateCompat`, `semverSatisfies`, `parseSemver`, `tupleGte`, `tupleLt`, `detectPythonVersion`, `isContractVersionAtLeast` (~150 LOC dead code). Los campos `installed_marker`, `qtc_core_installed`, `compat_ok`, `python_version` permanecen en `DoctorOutput` por back-compat de shape pero ahora siempre son `null`.

### Refactor — 6 funciones >cx 15 reducidas a ≤15 (bonus)

Honra la métrica del RFC 002 ("Lint complexity warnings: 8 → 0 post-G4"). Mecánica de extracción idéntica a G2:

- `code-scan-service.ts:scanFiles` (cx 31 → ≤15): extracción de `compilePatterns`, `scanSingleFile`, `scanLine`, `tallyBySeverity`.
- `code-scan-service.ts:walkFiles` (cx 21 → ≤15): split de la iteración nested via `visitDir` (delegate generator).
- `release-data-service.ts:readSessionArtifacts` (cx 29 → ≤15): extracción de `findSessionFolder`, `detectLegacyFormat`, `readScriptsArtifacts`, `readArtifactKind`.
- `release-data-service.ts:runReleaseData` (cx 26 → ≤15): extracción de `enrichSessionsWithLegacyMeta`.
- `upgrade-hub-mode-service.ts:runUpgradeHubMode` (cx 20 → ≤15): extracción de `findProjectBlock`, `applyBlockToCandidates`.
- `cli/commands/project-md-upsert.ts:execute` (cx 17 → ≤15): extracción de `buildUpsertInput`.

### Tests — 13 nuevos

- `tests/unit/help-groups.test.ts` (8 tests): grouping correcto, ordering preservado, "Other" fallback para comandos no clasificados, sin duplicación entre grupos.
- `tests/unit/self-update.test.ts` (3 tests): `--dry-run` retorna `would_run:true` y NO invoca `process.run` (ProcessPort que throw si se llama); modo normal sí invoca npm.
- `tests/unit/self-command.test.ts` (2 tests): `aw self` sin sub retorna `ok:true` con subcommands; subcomando inválido sigue retornando `INVALID_INPUT` (back-compat).
- 1 test agregado en `plugin-doctor-service.test.ts` para cubrir el caso `pluginRoot="/"` → fallback a `${ns}-${flow}`.

### Métricas

| | 4.5.0 | 4.6.0 |
|---|---|---|
| Tests | 156 | 169 |
| Lint complexity warnings | 6 | **0** |
| LOC `plugin-doctor-service.ts` | ~860 | ~700 (–150 dead code) |

## [4.5.0] — 2026-05-07

**Minor (con cambio de contrato visible) — RFC 002 G3 error format unificado (session012).** Todos los error paths del CLI ahora emiten un JSON envelope a stdout en lugar de plain-text a stderr. Misma exit code (≠0), mismo significado, formato distinto.

### Changed (contract)

- **Error envelope unificado**: errores del propio CLI (parseo de argv, comando desconocido, fallas de subcomandos) escriben `{ok:false, error:{code, message, details?}}` a **stdout** + exit ≠ 0. Antes algunos sitios escribían a stderr (`writeStderr`) y otros emitían el envelope vía `emit(CommandResult)`.
- **stderr ya NO es canal de errores formatados del CLI**. Sigue siendo canal válido para `aw hook` que relay-ea stderr de scripts/plugins child-process (single excepción documentada en `render.ts`).
- Códigos de error introducidos:
  - `ARGS_INVALID` — fallo en `parseArgv` (ej. `--flow` con valor fuera del whitelist).
  - `UNKNOWN_COMMAND` — comando no registrado; `details.help_hint` + `details.available_commands` para discoverability.
  - `DBHUB_LAUNCHER_FAILED` — `aw mcp dbhub` no pudo arrancar el launcher (antes retornaba `ok:true` con `exitCode:1` + stderr, contradictorio).

### Added

- `src/cli/render.ts`: `ErrorEnvelope`, `renderError`, `emitError`, `formatUnknownCommand`, `formatArgvError` — helpers reutilizables, importables desde cualquier módulo del CLI.
- `tests/unit/main.test.ts` (11 tests, +1 file) — verifica forma del envelope, round-trip JSON.parse, y que `emitError` escribe a stdout (NO stderr).

### Notas para clientes downstream

- **Migración para parsers existentes**: si un script/hook detectaba errores leyendo stderr, debe migrar a parsear stdout JSON (`JSON.parse(stdout)` y chequear `.ok === false`).
- Comportamiento al usuario humano via TTY no cambia significativamente: la línea de error sigue saliendo en consola, ahora como JSON estructurado en lugar de texto plano. `aw <bogus-cmd>` ya no imprime el menú de help completo (solo el envelope con `available_commands`); para help completo correr `aw --help`.

## [4.4.0] — 2026-05-07

**Minor — RFC 002 G2 refactor plugin-doctor (session011).** Descomposición de `runPluginDoctor` (cognitive complexity 206) y `loadExportedSkills` (44) en helpers ≤ 15 sin cambio de comportamiento.

### Changed

- **Refactor plugin-doctor por extracción** (D2 de RFC 002 — extracción, no rewrite): `runPluginDoctor` (1 monolito de ~460 LOC, cx=206) descompuesto en 8 helpers self-contained, cada uno mapeando a una sección lógica del original:
  1. `checkSkillsFrontmatter(skillsDir, fs)` — sección 1 (frontmatter validation), apoyado por `collectSkillDirs`, `parseSkillFile`, `validateSkillFrontmatter`.
  2. `checkReadmeSync(readmePath, skillsCount, fs)` — sección 2.
  3. `checkFrontendDesignGeneralization(skillsDir, pluginRoot, fs)` — sección 3 + `scanForSessionMarkers`.
  4. `parseManifests(pluginRoot, fs, inputVersion)` — sección 4, apoyado por `parseManifestFile`.
  5. `checkLegacyMarkers(paths, flow, pluginVersion, compatRange, isSinglePathContract, fs)` — secciones 5/5b/9 consolidadas; consume `readPluginVersionMarker`, `readMarkerText`, `checkPythonVersion`.
  6. `parseHooks(pluginRoot, fs)` — sección 7 + `parseHookFile`.
  7. `validateMcp(pluginRoot, runtime, env, fs)` — sección 8 + `validateMcpServer`.
  8. `validateExportedSkills(...)` — sección 10 + `validateSingleExportedSkill`.
- **`loadExportedSkills` (cx=44 → ≤15)**: split en `readExportsFromCustomFile` + `readExportsFromClaudeManifest` + `parseExportedSkillEntries` + `parseExportedSkillItem`.
- **Sin cambios de comportamiento observable**: 144/144 tests existentes pasan sin modificaciones (incluidos los 16 tests de plugin-doctor agregados en G1). El JSON output de `aw plugin-doctor` mantiene shape y semántica idénticos.

### Notas

- 2 lint warnings de complexity eliminados (los del plugin-doctor). Quedan 6 en otros servicios (code-scan, release-data, upgrade-hub-mode, project-md-upsert) que serán abordados en G3/G4 según RFC 002.
- Refactor mecánico habilitado por la red de seguridad de G1 (95 → 144 tests). Test-before-refactor confirmado como regla, no opcional (D1 de RFC 002).

## [4.3.0] — 2026-05-07

**Minor — RFC 002 G1 foundation (session010).** Test coverage para los 4 servicios críticos sin tests + fix de regresión silenciosa post-flag-day en hooks (B-20).

### Fixed

- **B-20 (regresión silenciosa post-flag-day)**: `findActiveSessions` ahora acepta y usa los markers del namespace activo. Antes hardcodeaba `LEGACY_QTC_MARKERS` y devolvía `[]` para cualquier workspace `.workflow/` con markers `<!-- WORKFLOW-PROJECT-START -->`. Consecuencia: el PreCompact hook (`checkpoint-write` sin `--code`), el SessionEnd hook (`auto-compact-on-close`) y `resume-summary` retornaban "no hay sesiones activas" en producción aunque hubiera sesiones declaradas. Bug introducido en F4 (4.0.0) y no detectado hasta TDD en G1.
- 5 callsites actualizados en `checkpoint-service.ts` y `checkpoint-write-service.ts` para pasar `paths.blockMarkers()` a `findActiveSessions`.

### Added — Test coverage (49 nuevos tests)

- `tests/unit/plugin-doctor-service.test.ts` (16 tests) — manifest name extraction (B-17 regression), skills frontmatter validation, manifest version drift, qtcContractVersion gate, hooks JSON parsing, output status field. Cubre el servicio más complejo del codebase (700+ LOC, complexity 206).
- `tests/unit/release-data-service.test.ts` (15 tests) — `listSessionsForRelease` (empty workspace, since filter, legacy detection, includeOpen) + `readSessionArtifacts` (session_not_found, legacy_format error, OBJETIVO content, scripts dir, code normalization).
- `tests/unit/code-scan-service.test.ts` (11 tests) — root_not_found, hardcoded secret/TODO/localhost/console.log detection, default excludes (node_modules, dist, .workflow), maxPerPattern cap, inlinePatterns override, extension filtering.
- `tests/unit/checkpoint-write-service.test.ts` (7 tests) — incluye **regression test** para B-20 con markers WORKFLOW-PROJECT post-flag-day + back-compat con QTC-PROJECT legacy + multi-session ambiguity + idempotency.

### Tests

- 95 → 144 tests (+49). 18 archivos de test (+4).

### Notas

- Los 8 lint warnings de complexity siguen presentes (no parte de G1; el plan G2 aborda el refactor de `runPluginDoctor` con esta nueva red de seguridad).

## [4.2.0] — 2026-05-07

**Minor — fix bundle de la auditoría post-F5 (session008).** Cierra los 5 bugs estructurales detectados al ejecutar el TEST-PLAN.md sobre la 4.1.0.

### Added

- **Back-compat read de markers legacy** (B-19): `parseProjectBlock` ahora intenta primero los markers del namespace activo; si no matchean, fallback a `LEGACY_QTC_MARKERS` (`<!-- QTC-PROJECT-(START|END) -->`). Esto cumple la promesa del CHANGELOG 4.0.0. Write sigue usando los markers del namespace actual (no se introduce deuda nueva). (`src/application/parsers/project-block.ts`)
- **`plugin-doctor` deriva `plugin` de manifest.name** (B-17): el campo `plugin` del output reporta el nombre real del manifest leído (ej. `"qtc"`) en lugar del literal `${namespace}-${flow}` (ej. `"workflow-core"`). Fallback a la lógica anterior si el manifest no expone `name`. (`src/application/plugin-doctor-service.ts`)

### Fixed

- **Autodetect ignora `.qtc/sessions/` legacy** (B-15): nuevo `LEGACY_NAMESPACE_DENYLIST = {"qtc"}` en `namespace-resolver.ts`. Workspaces con `.qtc/sessions/` no se autodetectan; el CLI cae a default `agent-workflow` salvo que el usuario fuerce `qtc` vía `--namespace`, `AW_NAMESPACE` o user-config (override absoluto). Esto respeta el flag-day del RFC 001 D2. (`src/runtime/namespace-resolver.ts`)
- **`aw sessions` no lista sesiones legacy** (B-16): cierra como consecuencia de B-15 — sin namespace=`qtc` autodetectado, los comandos del lifecycle (`sessions`, `workspace-mode`) ya no operan sobre `.qtc/sessions/`.

### Tests

- 8 nuevos casos: 5 en `namespace-resolver.test.ts` (denylist + overrides + coexistencia con `.workflow/`), 3 en `project-block-markers.test.ts` (back-compat read positivo, ambiguo, prioridad current). 95/95 verdes.

## [4.1.0] — 2026-05-07

**Minor — F5 del RFC 001 (cleanup post-migración).** Cierra deuda técnica residual: nombre paquete actualizado en docs del skill bundled + nuevo check de leftover en `self doctor`.

### Added

- `self doctor` ahora detecta el directorio legacy `~/.claude/skills/agent-workflow-manager/` y agrega 3 campos opcionales al output (`skill.legacy_leftover`, `skill.legacy_leftover_path`, `skill.legacy_leftover_warning`) cuando existe. Recomienda `mv` al usuario sin ejecutar destructivo. (`src/application/self/doctor-self.ts`)

### Changed

- `skills/agent-workflow/SKILL.md` (bundled) — namespace resolution actualizada al modelo plugin-driven post-flag-day (ya no menciona `~/.qtc/`, `.qtc/sessions/`, `AW_NAMESPACE=qtc`). Bump del frontmatter `version: 1.1.0 → 1.2.0`.
- `skills/agent-workflow/MANUAL-FUNCIONAL.md`, `MANUAL-TECNICO.md`, `docs/TEST-PLAN.md` — refs a `npm install -g @tacuchi/agent-workflow` actualizadas a `…-cli`.

### Tests

- 2 nuevos casos en `tests/unit/self-doctor.test.ts` (leftover detected + new skill only). 87/87 verdes.

## [4.0.0] — 2026-05-07

**Major breaking — F4 del RFC 001 (flag-day namespace).** El CLI deja de tratar `.qtc/` como dirname canónico para los workspaces. La convención nueva es `.workflow/` (plugin-driven via SessionStart hook), pero la lógica de autodetect del CLI sigue siendo namespace-agnóstica: detecta cualquier `.<ns>/sessions/` en el CWD.

### BREAKING CHANGES

- **Default `historicoPath`** en `renderProjectBlock`: era `.qtc/HISTORY.md`, ahora es `.workflow/HISTORY.md`. Consumidores que llamen `renderProjectBlock` sin pasar `historicoPath` explícito reciben el path nuevo.
- **Workspaces existentes con `.qtc/sessions/`** quedan invisibles si se intenta autodetect tras instalar `qtc-workflow-plugin@^1.0.0`, porque el plugin reclama namespace `workflow` (autodetect busca `.workflow/sessions/` o el plugin escribe `workflow` al `~/.config/agent-workflow/namespace`). Migración manual: `mv .qtc .workflow` por workspace + edit del bloque QTC-PROJECT en `CLAUDE.md`/`AGENTS.md` (cambiar `Histórico: \`.qtc/HISTORY.md\`` por `\`.workflow/HISTORY.md\``).
- **Mensajes de error de `handoff.ts`** y help del CLI ya no mencionan `.qtc/sessions/`; usan el path resuelto por `PathsService.cwdSessionsDir()` (depende del namespace activo).

### Changed

- `src/application/handoff.ts:43,47` — error messages parametrizados via `paths.cwdSessionsDir()` (antes literal `.qtc/sessions/`).
- `src/cli/main.ts:240-242` — help text reescrito: menciona el mecanismo plugin-driven (SessionStart hook escribe namespace) en vez de hardcodear `qtc`/`.qtc/sessions/`.
- `src/application/render/project-block.ts:19,27` — JSDoc + default `historicoPath` actualizados a `.workflow/HISTORY.md`.
- Tests + fixtures (50+ refs): paths-service, namespace-resolver, runtime-config-service, self-doctor, self-namespace, project-block-markers, wave1-read, wave1b-write, sessions, golden JSON fixtures, sample-workspace, golden-write CLAUDE.md fixtures — todos migrados al namespace `workflow` con dirname `.workflow/` y markers `<!-- WORKFLOW-PROJECT-... -->`.
- Helper `makeQtcPaths` → `makeWorkflowPaths` (tests/golden/lib/before-after-fixture.ts).
- Fixture dirs renombradas via `git mv .qtc .workflow` (sample-workspace + 3 golden-write subdirs).

### Migration

Para cada workspace que el usuario quiera preservar tras este upgrade:

```bash
cd <workspace>
mv .qtc .workflow
# editar CLAUDE.md y AGENTS.md:
#   `Histórico: `.qtc/HISTORY.md`` → ``.workflow/HISTORY.md``
#   `<!-- QTC-PROJECT-START -->` → `<!-- WORKFLOW-PROJECT-START -->` (opcional; el CLI sigue parseando los markers legacy en el path de back-compat read)
```

Las sesiones activas en `.qtc/sessions/` que no se migren quedan invisibles al CLI tras el upgrade del plugin a `^1.0.0`.

## [3.0.2] — 2026-05-07

Patch — F3 del RFC 001. Skill bundled-only: rename de la skill `agent-workflow-manager` a `agent-workflow`, eliminación de toda referencia al repo standalone y simplificación del flow `self install-skill` (sin fallback URL).

### Changed

- **Skill rename**: `skills/agent-workflow-manager/` → `skills/agent-workflow/`. La skill se instala ahora en `~/.claude/skills/agent-workflow/`. Frontmatter `name: agent-workflow`. Bump del skill a v1.1.0.
- **`self install-skill` simplificado**: el flow queda con 2 ramas — `--from <path>` (override desde checkout local) o, sin flag, instala desde la ubicación bundled en el tarball. La rama de `git clone` desde URL fue removida.
- **`self doctor`**: reporta `skill.path = ~/.claude/skills/agent-workflow` (era `agent-workflow-manager`).

### Removed

- Constante exportada `DEFAULT_SOURCE` (URL al repo standalone `Tacuchi/agent-workflow-manager`).
- Helper `isRemoteUrl` y la rama de clone.
- Tests de URL clone (`clones when source is a URL`, `fails gracefully when git clone exits non-zero`, `default source is the canonical GitHub URL`).

### Added

- Validación al inicio de `self install-skill` que rechaza `--from <url>` con error claro `INVALID_SOURCE` (apuntando a usar `--from <local-path>` o eliminar el flag para usar el bundled).
- Tests nuevos cubriendo el rechazo de URLs (`https://`, `git@...`).

### Migration

Usuarios con la skill vieja instalada localmente:

```bash
rm -rf ~/.claude/skills/agent-workflow-manager
npm install -g @tacuchi/agent-workflow-cli@latest
agent-workflow self install-skill
```

El leftover `~/.claude/skills/agent-workflow-manager/` queda invisible al CLI nuevo. F5 del RFC 001 agrega un detector en `aw self doctor` que avisa al usuario sobre esto.

## [3.0.1] — 2026-05-07

Patch — cierra los gaps de tooling detectados durante el hub-init del upgrade (F1 del RFC 001). Bug fix de larga data en `project-md-upsert --init` + cleanup post-rename.

### Fixed

- **`project-md-upsert --init` ignoraba `--fuente` y `--main-branch`**: el bloque QTC-PROJECT inicial siempre quedaba con `## Fuentes` vacío al inicializar workspaces hub. Ahora `--fuente "alias:path[:rama-principal]"` es repetible y `--main-branch <rama>` aplica como fallback para fuentes que no declaran rama. Memoria del usuario `project_agent_workflow_cli_gaps.md` queda cerrada.
- **`--working-branch` sobrescribía en lugar de acumular**: `Map.set` reemplazado por array. Ahora pasar `--working-branch a:r1 --working-branch b:r2` resulta en ambos aliases mergeados en `## Status`.
- **Refs leftover al nombre viejo del paquete**: `src/runtime/types.ts` y `src/cli/interactive-menu.ts` aún apuntaban a `@tacuchi/agent-workflow` (pre-rename). Ajustados a `@tacuchi/agent-workflow-cli` para alinear con `package.json:name` (D1 del RFC).

### Added

- Multi-value flag support en `parseArgv`: nueva `valuesMulti: Map<string, string[]>` para flags repetibles. Conjunto inicial: `--fuente`, `--working-branch`. Flags single-value (`--main-branch`, etc.) mantienen semántica last-wins en `values`.
- `ProjectMdUpsertInput.fuentes?` y `ProjectMdUpsertInput.mainBranch?` permiten declarar fuentes desde la API del service (no sólo desde CLI).
- Tests unit nuevos: `tests/unit/parser-multi-value.test.ts` (4 casos) y `tests/unit/project-md-upsert-fuentes.test.ts` (6 casos cubriendo init de 1/2/3 fuentes, fallback de rama, hub mode con working-branches, re-init con override por alias).

## [3.0.0] — 2026-05-07

Breaking — paquete renombrado de `@tacuchi/agent-workflow` a `@tacuchi/agent-workflow-cli`. Repo upstream renombrado de `Tacuchi/agent-workflow` a `Tacuchi/agent-workflow-cli`. Bin (`agent-workflow`) y alias (`aw`) sin cambios. Roadmap del upgrade en hub `qtc-plugin-upgrade` (RFC 001 v2).

### Changed

- `package.json:name` → `@tacuchi/agent-workflow-cli`.
- `package.json:repository`, `bugs`, `homepage` → URLs del repo nuevo.

### Migration

Consumidores de `@tacuchi/agent-workflow@^2`:

```bash
npm uninstall -g @tacuchi/agent-workflow
npm install -g @tacuchi/agent-workflow-cli
```

Las rutas instaladas (`agent-workflow`, `aw`) y la API pública del CLI no cambian — sólo el nombre del paquete y la URL del repo.

## [2.0.2] — 2026-05-06

Patch UX fix for the interactive TUI menu. RFC 002 follow-up (session010 in the qtc-plugin-v2 hub).

### Fixed

- **Menu `Install/Update skill` failing with `DEST_EXISTS`**: when the bundled skill was already installed, selecting the menu option failed because the dispatcher invoked `self install-skill` without `--force`. Since the menu label literally reads "Install/**Update**", the user's intent on selection is overwrite. The dispatcher now passes `--force` automatically. The CLI directly (`agent-workflow self install-skill`) is unchanged and still requires explicit `--force` to overwrite — preserving the safety net for scripts and CI.

## [2.0.1] — 2026-05-06

Patch fix for the interactive TUI menu. RFC 002 follow-up (session009 in the qtc-plugin-v2 hub).

### Fixed

- **Interactive menu missing `install-skill` option**: when running `aw` or `agent-workflow` without arguments in a TTY, the menu only exposed `Doctor / Update / Help / Exit`. The bundled `self install-skill` command introduced in v2.0.0 was reachable only from the command line. The menu now lists 5 options: `Doctor / Install/Update skill (manager bundled) / Update CLI / Help / Exit`. The `Update CLI` label was clarified (previously just "Update").

### Internal

- `MenuAction` union extended with `"install-skill"`. `dispatchMenuAction` switch wires it to `["self", "install-skill"]`.

## [2.0.0] — 2026-05-06

Bundle the `agent-workflow-manager` skill in the published tarball. **Breaking change** in the default behavior of `agent-workflow self install-skill`: it now copies from the bundled skill shipped alongside the CLI instead of git-cloning the upstream repo. RFC 002 Fase D (session007 in the qtc-plugin-v2 hub).

### Breaking changes

- **`self install-skill` default source**: previously `git clone https://github.com/Tacuchi/agent-workflow-manager.git`; now copies from `<package_root>/skills/agent-workflow-manager/` (bundled in the tarball). Users who relied on the default to fetch bleeding-edge from git must now pass `--from <url>` explicitly.
- **`SelfInstallSkillData.source_kind`** gains a new variant `"bundled"` (alongside `"path"` and `"url"`). Consumers that exhaustively pattern-match must add the new variant.
- **New error code** `BUNDLED_NOT_FOUND` returned when `--from` is omitted and the resolver cannot locate `skills/agent-workflow-manager/SKILL.md` relative to the install (e.g., dev checkouts without a build, or tarballs missing `skills/`).

### Added

- **Bundled skill manager**: the npm tarball now ships `skills/agent-workflow-manager/` (5 files + `docs/` + `references/`). `package.json` `files` array extended to `["dist", "skills", "LICENSE", "README.md"]`.
- **`resolveBundledSkillPath()`** helper exported from `application/self/install-skill.js` — walks up from the current module's directory until it finds `skills/agent-workflow-manager/SKILL.md`. Works in both dist (post-build) and dev (vitest) layouts.
- **`BUNDLED_SKILL_REL_PATH`** constant exported (default `"skills/agent-workflow-manager"`).
- 2 new unit tests in `tests/unit/self-install-skill.test.ts` covering bundled-default and `BUNDLED_NOT_FOUND`. `selfInstallSkill` accepts an optional `resolveBundled` injector for testability.

### Changed

- `selfInstallSkill` flow: (1) `--from <X>` provided → use as path or url (unchanged behavior); (2) `--from` omitted → call bundled resolver; bundled found → use as `source_kind: "bundled"`; bundled missing → `BUNDLED_NOT_FOUND`.
- Package `description` updated to highlight the bundled skill manager.

### Migration guide (v1.2.0 → v2.0.0)

| Use case | v1.x | v2.x |
|---|---|---|
| Install bundled skill | `agent-workflow self install-skill` (clones git) | `agent-workflow self install-skill` (copies bundled, faster, offline-capable) |
| Install bleeding-edge | (default, implicit) | `agent-workflow self install-skill --from https://github.com/Tacuchi/agent-workflow-manager.git` |
| Install from local checkout | `agent-workflow self install-skill --from /path/to/repo` | unchanged |
| `--force` / `--dry-run` flags | unchanged | unchanged |

If your tooling pinned `^1.0.0`, bumping to `^2.0.0` is a single major bump. The CLI surface (commands, flags, output schema) stays compatible aside from the new `source_kind: "bundled"` enum value.

### Internal

- `agent-workflow-manager` repo (origin) is preserved unmodified. Strangler Fig: the standalone repo will be archived in Fase E (≥2 weeks post-v2.0.0).

## [1.2.0] — 2026-05-05

Workspace-aware namespace resolution. The CLI now infers `namespace` from the cwd when no flag/env/config is set, so qtc-* (and other) workspaces work out-of-the-box without per-invocation configuration.

### Added

- **Workspace auto-detect** as a 3rd resolution step (between env and user config). When no `--namespace` flag and no `AW_NAMESPACE` env are present, the resolver scans the current directory for hidden folders matching `^\.[a-z][a-z0-9-]{1,30}$/` that contain a `sessions/` subdirectory. If exactly one match is found, that namespace is used (source = `workspace`). This makes `agent-workflow sessions` "just work" inside qtc-* (or any other) workspace without per-invocation config.
- New `NamespaceSource` value `workspace` reported by `self namespace` and `self doctor`.
- 5 new unit tests in `tests/unit/namespace-resolver.test.ts` covering: detection of `.qtc/sessions/`, ignoring `.git/` (no sessions/ subdir), ambiguity fallback (multiple candidates → default), config-file precedence over auto-detect, and unreadable cwd graceful handling.

### Changed

- **Resolution order**: workspace auto-detect now wins over `~/.config/agent-workflow/namespace` (locality > preference). A user with `qtc` in their user config but cwd inside a `.foo/sessions/` workspace gets `foo`, not `qtc`. New full order: flag > env > workspace > user-config > default.
- `NAMESPACE_REGEX` exported from `runtime/namespace.ts` so the resolver can reuse the same validation pattern for workspace candidates.
- Help text updated to document the new resolution order.
- Package description: highlights the workspace auto-detect.

## [1.1.0] — 2026-05-05

Sub-proyecto 2 del spec `agent-workflow-agnostic-design`: poblar el repo `agent-workflow-manager` y entregar la implementación real de `self install-skill` que lo consume.

### Added

- `self install-skill` real implementation:
  - Default source: `https://github.com/Tacuchi/agent-workflow-manager.git` (cloneable via `git`).
  - `--from <url|path>` flag accepts an alternate git URL or a local filesystem path.
  - `--force` overwrites an existing `~/.claude/skills/agent-workflow-manager/` directory.
  - `--dry-run` previews source/destination without copying.
  - Validates `SKILL.md` frontmatter (`name`, `description`) before installing.
  - Skips `.git/` when copying so the installed skill folder is clean.
- 10 new unit tests in `tests/unit/self-install-skill.test.ts` covering local-path install, URL clone via fake `ProcessPort`, force overwrite, dry-run, missing source, missing/invalid SKILL.md, and clone failure.

### Changed

- `self doctor` now reports the skill at `~/.claude/skills/agent-workflow-manager/` (was `~/.claude/skills/agent-workflow/`). Skill folder name now matches the canonical skill repo name.

## [1.0.0] — 2026-05-DD

First stable release. The CLI is now namespace-agnostic and reusable beyond the `qtc-*` plugin family.

### ⚠ BREAKING CHANGES

- **Default namespace changed.** Previous default behavior wrote to `~/.qtc/...` and `.qtc/sessions/`. The new default namespace is `agent-workflow`, so paths become `~/.agent-workflow/...` and `.agent-workflow/sessions/`. To preserve previous behavior, set `AW_NAMESPACE=qtc` (recommended for qtc-* plugin users) or pass `--namespace qtc` per invocation.
- **Env var renamed:** `QTC_AGENT_WORKFLOW_BIN` → `AW_AGENT_WORKFLOW_BIN`.
- **Env vars renamed:** `QTC_SQL_GUARD` / `QTC_SQL_GUARD_ALLOW` → `AW_SQL_GUARD` / `AW_SQL_GUARD_ALLOW`.
- **MCP guard patterns no longer hardcoded.** The `hook sql-mutation-guard` PreToolUse hook now reads patterns from `runtime.mcpGuards.sqlMutation` in the runtime config JSON. Guard is disabled when no config is provided. qtc-* plugins must ship a runtime config with the qtc-cert/qtc-prod patterns.
- **Plugin-doctor expectations changed.**
  - `expectedScripts` input field removed (Python era ended).
  - `scripts` output field removed.
  - Expected MCP servers now read from `runtime.expectedMcpServers` (was hardcoded to `["qtc-cert", "qtc-prod"]`).
- **Block markers parametric.** `parseProjectBlock` and `renderProjectBlock` now accept optional `markers: ProjectBlockMarkers` and `historicoPath` parameters. Defaults still produce `<!-- QTC-PROJECT-START -->` and `.qtc/HISTORY.md` for legacy callers, but services that pass `paths.blockMarkers()` will get namespace-aware markers.
- **CLI exit code change:** Invoking `agent-workflow` with no arguments now exits 0 (was 1). This avoids "red" rendering in terminals that interpret non-zero exit as an error.

### Added

- `--namespace <name>` flag (or env `AW_NAMESPACE`) for runtime namespace selection. Resolution order: flag > env > `~/.config/agent-workflow/namespace` file > default `agent-workflow`.
- `Namespace` branded type with kebab-case validation (`^[a-z][a-z0-9-]{1,30}$`).
- `PathsService` central path resolver with namespace-aware paths.
- Runtime config schema extended with optional fields: `schemaVersion`, `displayName`, `mcpGuards.sqlMutation`, `expectedMcpServers`, `slashCommands.{migrate,projectInit,hubInit,resume,session}`.
- Interactive TTY menu when `agent-workflow` is invoked without arguments. Choices: Doctor / Update / Help / Exit.
- `self` subcommand family:
  - `self namespace` — print resolved namespace and source.
  - `self doctor` — report CLI version, namespace, paths, runtime config, skill install status.
  - `self update` — run `npm install -g @tacuchi/agent-workflow@latest` with optional TTY confirm.
  - `self install-skill` — STUB; full implementation deferred to sub-project 2 (the agent-workflow skill repo).

### Changed

- All hardcoded `.qtc/` and `~/.qtc/` paths in services replaced with `PathsService` calls.
- All `[qtc-core]` / `[qtc-dev]` message prefixes replaced with `runtime.displayName ?? "agent-workflow"`.
- Help text and `package.json` description genericized.
- Log filename `qtc-utils.log` renamed to `agent-workflow.log`.

### Removed

- Obsolete `// Mirror de qtc_core/...` comments referencing deleted Python sources.
- `DEFAULT_EXPECTED_SCRIPTS_BY_FLOW` table (Python script existence check).

### Migration for `qtc-*` plugin users

Install or upgrade your qtc-* plugins; they will set `AW_NAMESPACE=qtc` in their `SessionStart` hook (sub-project 3). Until then, manually set `export AW_NAMESPACE=qtc` in your shell, or pass `--namespace qtc` per invocation. Existing data under `~/.qtc/...` is unchanged and the CLI continues to read/write there with namespace=qtc.

## [0.9.1] — 2026-05-02

Last release before the agnostic refactor. See git history for details.
