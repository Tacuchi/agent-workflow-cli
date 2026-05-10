# Changelog

All notable changes to `@tacuchi/agent-workflow-cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.9.3] — 2026-05-09

**Patch — UX polish del wizard MCP + backups transitorios (session035).** Dos mejoras complementarias en el flujo de `agent-workflow self`:

### Changed

- **Tabla de conexiones con status icons**: `si`/`no`/`drift` se renderizan como `✓` / `–` / `!` (1 char visible). Headers acortados a `nombre` / `DSN var` / `Claude` / `Codex`.
- **Header contextual antes de la tabla**: `Conexiones MCP registradas (N):` + tabla + leyenda `✓ instalado · – no instalado · ! drift de configuración`. La leyenda ayuda al primer encuentro con los símbolos.
- **Choices del menú post-tabla con prefix + Separator**: agrupa `── Instalar / Actualizar ──` (Claude Code, Codex), `── Operar ──` (Diagnosticar, Eliminar), y bloque final separado para Cancelar. Símbolos `▸` / `·` / `✗` / `⏎` para jerarquía visual.
- **Menú raíz `agent-workflow self` con misma estructura**: separador `── Verificar / configurar ──` (Doctor, Skill, MCP) y `── Mantenimiento ──` (Update, Help) + Salir aislado.
- **Wizard `mcp` también separado por intención**: `── Conexiones existentes ──` y `── Registrar nueva conexión ──`.
- **Mensajes de prompt más específicos**: `Conexión a operar` (en vez de `Conexión`), `Nombre de la nueva conexión (slug-kebab)`, `Variable de entorno con la DSN (UPPER_SNAKE_CASE)`.
- **`SelfMcpPrompts.select` admite separadores** vía `{ type: "separator", separator?: string }`; `loadPrompts` los traduce a `Separator()` real de `@inquirer/prompts`.

### Fixed

- **Backups `<file>.bak.<ts>` ahora son transitorios**: tras `setup` o `remove` exitoso se eliminan automáticamente. Antes quedaban acumulados en `.claude/`, `.mcp.json`, `.claude.json` y `.codex/config.toml` después de cada operación.
- **Purge histórico al iniciar**: cada `setup`/`remove` purga `<file>.bak.<digits>` previos del archivo objetivo (limpieza de versiones anteriores).
- **Cleanup legacy también pasa por purge + discard**: el barrido de `mcpServers` en `.claude/settings.json` ya no deja `.bak` huérfanos.
- `result.backup` ahora es `null` en happy path. Si el `writeFileSync` lanza, el `.bak` queda como recovery (best-effort).

### Tests

- 368 tests pasando (+1 vs 5.9.2):
  - 4 reescritos en `format-connections-table.test.ts` para validar status icons (`✓`/`–`/`!`) y headers cortos.
  - 1 reescrito en `mcp-host-writer.test.ts`: `result.backup === null` tras write OK + 0 archivos `.bak.*` en disco.
  - 1 nuevo en `mcp-host-writer.test.ts`: pre-existing `.bak.<digits>` se purgan al iniciar el write.
  - 1 actualizado en `self-mcp-config.test.ts`: assertion contra fila con icons.

### Decisions

- **DEC-008**: status icons elegidos = `✓` / `–` / `!`. Evitamos emojis (dependientes de fuente/terminal); estos 3 están en BMP y se renderizan en cualquier terminal moderna.
- **DEC-009**: el `result.backup` retorna `null` en happy path. La promesa "no dejes residuos" prioriza limpieza visible sobre rastro de auditoría — quien quiera auditoría tiene git/snapshots externos.

## [5.9.2] — 2026-05-09

**Patch — render box-drawing del listado de conexiones MCP (session034).** El header del prompt en `agent-workflow self mcp` mostraba el pipe-table markdown (`| nombre | DSN var ... |`) literal porque `@inquirer/prompts` no renderiza markdown. Ahora la tabla usa caracteres Unicode de box-drawing (`┌─┬─┐ │ ├─┼─┤ └─┴─┘`) con anchos de columna calculados a partir de header + celdas. Headers acortados a `nombre`, `DSN var`, `Claude Code`, `Codex`. Sin nuevas dependencias.

### Changed

- `formatConnectionsTable` (ahora exportada en `src/application/self/mcp-config.ts`) emite tabla box-drawing con padding interno fijo y anchos auto-calculados.

### Tests

- 367 tests pasando (+5 vs 5.9.1):
  - 5 nuevos en `tests/unit/format-connections-table.test.ts` cubriendo: caso vacío, una conexión, anchos auto-ajustados, múltiples conexiones, snapshot exacto.
  - 1 actualizado en `self-mcp-config.test.ts` (assertion contra `│ ... │` en vez de `| ... |`).

## [5.9.1] — 2026-05-09

**Patch — Claude Code MCP target fix (session033).** Tras 5.9.0 los servidores MCP escritos por `agent-workflow self` y `agent-workflow mcp setup` quedaban en `.claude/settings.json`, archivo que Claude Code no consulta para `mcpServers`. Ahora se escribe en el archivo canónico según la doc oficial de Claude Code: `.mcp.json` para project scope (workspace) y `~/.claude.json` para user scope (global). Codex sigue intacto en `.codex/config.toml`.

### Changed

- `mcp-host-writer.ts` redirige el writer/remover de Claude: `<scopeDir>/.mcp.json` para `scope=workspace`, `<scopeDir>/.claude.json` para `scope=global`. `ScopeInput` admite ahora `kind?: "workspace" | "global"` (default `workspace`).
- `mcp-host-reader.ts` lee del mismo archivo según `kind`. La firma de `readMcpEntry` añade un parámetro opcional `kind` (default `workspace`).
- `mcp-setup-service.ts` y `mcp-remove-service.ts` propagan el scope al writer y actualizan el hint de refusal global a `~/.claude.json` / `~/.codex/config.toml`.
- `mcp-doctor-service.ts` consulta el snapshot pasando el scope al reader, alineado con el nuevo target.

### Fixed

- `/mcp` en Claude Code ahora detecta los MCP `cert` / `prod` registrados via wizard. Antes Claude Code los ignoraba porque `.claude/settings.json` no es fuente de `mcpServers` (solo hooks/permissions).

### Migrated

- Cleanup automático: cada `setup` o `remove` borra de paso la entrada `mcpServers[name]` en `.claude/settings.json` legacy si existe, dejando intactas `permissions` y demás claves. La operación crea backup `.claude/settings.json.bak.<ts>`.

### Tests

- 362 tests pasando (44 archivos). +5 vs 5.9.0:
  - 2 nuevos en `mcp-host-writer.test.ts` (cleanup legacy con/sin entradas remanentes).
  - 1 nuevo en `mcp-host-writer.test.ts` (global scope → `.claude.json`).
  - 1 nuevo en `mcp-host-reader.test.ts` (project scope ignora `.claude/settings.json` legacy).
  - 1 nuevo en `mcp-host-reader.test.ts` (global scope lee `.claude.json`).

### Decisions

- **DEC-005**: `.claude/settings.json` queda reservado para hooks / permissions / `additionalDirectories` (multiroot, hub-init). No se usa más para MCP. Razón: la doc oficial de Claude Code (`code.claude.com/docs/en/mcp`) no la lista entre los archivos de scope MCP.
- **DEC-006**: Mapeo de scopes CLI → scopes Claude Code: `workspace` → project (`.mcp.json` checkeable a git), `global` → user (`~/.claude.json`). El scope "local" de Claude Code (entries por proyecto en `~/.claude.json`) no se expone porque colisiona semánticamente con nuestro `workspace`.
- **DEC-007**: El cleanup legacy es one-shot por entrada (no purge masivo): se ejecuta en cada `setup`/`remove` que toque la misma entry. Razón: minimizar riesgo de borrar configuración de otros consumidores que hayan usado el mismo nombre.

## [5.9.0] — 2026-05-09

**Minor — manual MCP config flow desde `agent-workflow self` (session032).** Agrega un wizard interactivo para configurar conexiones MCP de BD sin pasar por `mcp setup` directo: nombres normalizados (no solo `cert|prod`), DSN persistido en `~/.workflow/dev/dsn.env` sin imprimirlo en claro, install/uninstall por host (Claude/Codex), y diagnóstico contra el MCP doctor existente. Acompaña la R3 de session031 (verificar instalación global del usuario).

### Added

- **Submenú MCP en `agent-workflow self`** — flujo interactivo con acciones `list`, `use-env`, `create-env`, `install-claude`, `install-codex`, `doctor`, `remove`, `cancel`. Soporta nombres custom además de `cert`/`prod`.
- **`mcp-connections-service`** — CRUD de conexiones registradas (read/upsert/delete) sobre el almacenamiento actual del CLI.
- **`mcp-remove-service`** — desinstalación por host preservando otras entradas del usuario en `.claude/settings.json` / `.codex/config.toml`.
- **`self/mcp-config`** — orquesta el wizard, captura DSN sin echo, deriva `mcpEntryNameFor` y compone con `runMcpSetup` / `runMcpDoctor` / `runMcpRemove`.
- **Tests nuevos** — `mcp-remove-service.test.ts` (3) + `self-mcp-config.test.ts` (cubre flujos principales y errores).
- **`mcp-host-writer`** — soporte de remove preservando entradas no-MCP.

### Changed

- **`mcp-entry`**: `validateMcpInstance` acepta nombres normalizados (`qtc-<nombre>`) además de `cert`/`prod`. `normalizeDsnVarName` y `validateDsnVarName` exportados para reuso (DEC-001).
- **`mcp-dbhub-launcher`**: `resolveDsn()` ahora resuelve `DB_<NORMALIZED>_DSN` derivado del nombre custom (DEC-002).
- **`mcp-doctor-service`**: errores con `ok:false` preservan `data` para que el wizard pueda mostrar `data.reports` y guiar la corrección de drift (DEC-003).
- **`agent-workflow self`**: el menú interactivo expone la nueva entrada MCP-config.
- Refactors menores en commands (`mcp.ts`, `self.ts`, `session-*`, `sources.ts`, `project-md-upsert.ts`) y descripción del paquete generalizada (no menciona `qtc-workflow-plugin` puntualmente).

### Decisions (session032)

- **DEC-001**: nombres MCP normalizados expuestos como `qtc-<nombre>` — compatibilidad con `cert`/`prod` + conexiones manuales.
- **DEC-002**: DSN custom en `~/.workflow/dev/dsn.env` con clave `DB_<NORMALIZED>_DSN` — reutiliza el almacén actual del CLI.
- **DEC-003**: preservar `data` cuando un comando devuelve `ok:false` — habilita diagnóstico accionable en `mcp doctor`.

### Tests

- 357 tests passing (vs 348 en 5.7.0; +9 netos). Build: `tsc` limpio.

## [5.7.0] — 2026-05-09

**Minor — clean install flow for fresh machines (session030).** Cierra el gap descubierto en T6 de session029: la skill legacy `agent-workflow-manager` persistía en `~/.agents/skills/` (registry de un installer multi-agent que sirve a Codex, Claude Code, Cursor y otros), fuera del scan de `self doctor`. La sesión agrega un tercer target `agents`, un subcomando para desinstalar y un wizard de bootstrap.

### Added

- **`self uninstall-skill`** (subcomando nuevo). Flags:
  - `--target <claude|codex|agents|all>` (default `all`).
  - `--legacy` (también borra `agent-workflow-manager` en el target).
  - `--dry-run` (preview sin tocar fs).
  - Cuando opera sobre `agents`, actualiza `~/.agents/.skill-lock.json` removiendo las entries `skills.<name>` (preserva `dismissed`, `lastSelectedAgents` y todo lo demás). Si el lock está malformado, emite `lock_warning` y lo deja intacto (failsafe).
  - Output JSON: `{ status, removed: [{target, path, kind, status}], lock_updated, lock_path?, lock_warning? }`.
- **`self bootstrap`** (subcomando nuevo). Wizard no-interactivo de instalación limpia:
  1. Llama a `self doctor` y captura leftovers.
  2. Si hay legacy → ejecuta `self uninstall-skill --legacy --target all` automáticamente.
  3. Ejecuta `self install-skill --force --target all` (claude+codex).
  4. Imprime `next_steps[]` con los comandos para instalar el plugin `qtc` en cada harness detectado.
  - Soporta `--dry-run` (cascadea a sub-pasos).
- **Target `agents`** en `InstallTarget`: `~/.agents/skills/agent-workflow/`. Disponible en `--target` de install/uninstall/doctor.
- Constantes públicas en `install-skill.ts`: `AGENTS_LOCK_REL`, `LEGACY_SKILL_NAME` para reuso por uninstall y doctor.
- **3 archivos nuevos de tests**: `self-uninstall-skill.test.ts` (7 tests), `self-bootstrap.test.ts` (3 tests), tests adicionales en `self-doctor.test.ts` (4 escenarios para target agents incluyendo lock parsing y malformed lock failsafe).

### Changed — `self doctor`

- **`skill.targets[]` ahora incluye `agents`** cuando `~/.agents/` existe. Cada entry de target `agents` agrega 4 campos opcionales: `lock_present`, `lock_canonical_entry`, `lock_legacy_entry`, `lock_warning`. Detecta legacy `agent-workflow-manager` tanto en filesystem (`legacy_leftover`) como en lock (`lock_legacy_entry`).
- `legacy_leftover_warning` actualizado para sugerir `agent-workflow self uninstall-skill --legacy` en lugar del manual `mv` viejo.
- Para targets `claude`/`codex` el comportamiento sigue idéntico — solo se agrega el target `agents` cuando el directorio existe.

### Changed — `self install-skill`

- `--target` choices acepta también `agents` (single-target opt-in).
- `--target=all` mantiene comportamiento de session029: instala en `claude` + `codex` (no en `agents` por default — el agents target es opt-in para quienes usan el skill-installer multi-agent). Sin breaking changes vs 5.6.0.

### Migration

Sin cambios de output JSON breaking. La nueva entry `agents` en `skill.targets[]` aparece sólo cuando existe `~/.agents/` (tooling que la consume nuevo o ausente sigue funcionando idéntico). El nuevo subcomando `bootstrap` reemplaza el flujo manual previo (instalar CLI → install-skill → instalar plugin); recomendado correrlo en máquinas nuevas.

**Fresh-machine flow recomendado:**
1. `npm install -g @tacuchi/agent-workflow-cli`.
2. `agent-workflow self bootstrap` (limpieza + dual-target install).
3. Instalar el plugin `qtc` en Claude Code/Codex con los comandos que imprime `next_steps[]`.

### Tests

- 348 tests passing (vs 335 en 5.6.0; +13 netos: 7 uninstall + 3 bootstrap + 4 doctor agents + 1 self-command actualizado para los 6 subcomandos). Lint: 0 errors, 1 warning pre-existente en `runSessionClose` (fuera de scope). Build limpio.

## [5.6.0] — 2026-05-09

**Minor — dual-target skill install + doctor (session029).** `self install-skill` y `self doctor` ahora operan en `~/.claude/skills/agent-workflow/` **y** `~/.codex/skills/agent-workflow/`. Cierra el gap detectado al verificar T6 de session028: el skill `agent-workflow` se publicaba sólo en Claude Code, dejando Codex sin la skill manager. Cambio de output JSON.

### Added

- **`self install-skill --target <claude|codex|all>`** — flag nuevo, default `all`. Instala en ambos targets en una sola invocación. `claude` o `codex` para opt-out single-target.
- **`InstallTarget`** y **`TARGET_ROOTS`** exports en `src/application/self/install-skill.ts` — usados también por `doctor-self.ts` para mantener un solo source-of-truth de los paths.
- **3 tests nuevos netos** en `tests/unit/self-install-skill.test.ts` (--target=claude, --target=codex, --target=invalid; los demás reformulan los originales para validar el nuevo shape `dests[]`) y **2 tests nuevos** en `tests/unit/self-doctor.test.ts` (ambos targets installed, leftover en codex independiente).

### Changed — `self install-skill`

- **Output shape**: el campo `dest` (string) se reemplaza por `dests[]` (array de `{ target, dest, status, overwrote_existing, files_copied }`). Cambio de shape — bump minor.
- **`DEST_EXISTS`**: ahora reporta los paths conflictivos de cada target en el mensaje de error y agrega la sugerencia `--target <claude|codex>` para instalar uno solo.
- **`--force`**: opera por target independiente. Si sólo `~/.claude/skills/agent-workflow` existe, se sobrescribe sólo ese — el reporte por target indica `overwrote_existing: true|false` correctamente.
- Refactor interno: `selfInstallSkill` extrae `resolveTargets`, `resolveSource`, `validateSourceContents`, `buildDestByTarget` para bajar la complejidad cognitiva.

### Changed — `self doctor`

- **Output shape `skill`**: se reemplaza `skill.path`/`skill.legacy_leftover*` por `skill.targets[]` (array de `{ target, path, installed, legacy_leftover?, legacy_leftover_path?, legacy_leftover_warning? }`). `skill.installed` queda como agregado (`true` si al menos uno de los targets tiene la skill).
- Detección de leftover `agent-workflow-manager` ahora corre por target: si Codex tenía leftover y Claude Code no (o viceversa), se reporta correctamente.

### Migration

Cambio de shape en JSON output — consumidores que dependían de `data.dest` (install-skill) o `data.skill.path` (doctor) tienen que migrar a la nueva shape `data.dests[].dest` y `data.skill.targets[].path`. Documentado arriba.

`self install-skill` sin flags ahora instala en ambos targets (cambio de default). Para preservar el comportamiento legacy single-target Claude Code, usar `--target claude`.

### Tests

- 335 tests passing (vs 330 en 5.5.1; +5 netos cubriendo dual-target). Lint: 0 errors, 1 warning pre-existente en `runSessionClose` (fuera de scope).

## [5.5.1] — 2026-05-09

**Patch — P2 cleanup final (session027).** Sweep de ruido y dead code post-audit de session023. Sin cambios de comportamiento.

### Removed

- **`parsers/project-block.ts`** — drop dead aliases `QTC_PROJECT_START` y `QTC_PROJECT_END` (sin importadores en src/ ni tests/).
- **`plugin-doctor-service.ts`** `DoctorOutput` — drop 4 fields siempre `null` heredados de la era Python: `qtc_core_installed`, `compat_ok`, `python_version`, `installed_marker`. Schema reducido en JSON output. Test obsoleto de "qtcContractVersion gate" removido.

### Changed

- **`cli/main.ts`** `resolveCoreConfigPath` — acepta `AGENT_WORKFLOW_CONFIG_PATH` además de la legacy `QTC_CORE_CONFIG_PATH` (preferencia: nuevo nombre, fallback: legacy).
- **`application/markdown.ts`** `normalizeKeyword` — reemplazada la regex con combining diacriticos ilegible por `String.prototype.normalize("NFD").replace(/\p{M}/gu, "")` (semántica idéntica, legible).
- **`tests/golden/{sessions,wave1-read,wave1b-write}.test.ts`** — descripciones "golden parity vs python qtc_core" → "golden parity (legacy ES fixture)" (el qtc_core Python ya no existe como referencia).

### Tests

- 330 tests passing (vs 331 en 5.5.0; -1 test obsoleto de qtcContractVersion gate). Lint: 0 errors.

## [5.5.0] — 2026-05-09

**Minor — R3 reader gaps + R2 atomic claim (sessions 024+025).** Cierra dos gaps post-publish detectados en validation runtime de session023:

1. **R3 Sprint 4 (reader-side completion)**: el canon EN ya se emitía en write paths (R3 Sprints 1-3) pero los readers core seguían ES-only. `aw sessions` reportaba sesiones cerradas como `active` y `phase: requirement` (legacy hardcoded). CHECKPOINT.md nuevos con headings EN no disparaban `findUnfilledPlaceholders`. `## Origen` (ES) era el único header reconocido para handoff origen.
2. **R2 atomic claim**: el `acquireLock` original hacía check-then-write no atómico. Bajo concurrencia 2 procesos podían pasar `fs.exists()` simultáneo y ambos overwritear el lock. Adicionalmente, `session-create`, `session-close` y `upgrade-hub-mode` escribían HISTORY.md / CLAUDE.md / AGENTS.md sin acquire del lock — bypass de R2 en los flows que más tocan esos archivos.

### Added — R2 atomic primitive (session025)

- **`FileSystemPort.writeTextExclusive(path, content): Promise<{ created: boolean }>`** (NUEVO): atomic create-or-fail vía `O_CREAT|O_EXCL`. Devuelve `{ created: false }` si el path ya existe. Cross-platform (POSIX + Windows) via Node `fs.open(path, 'wx')` con captura de EEXIST.
- **`FileSystemPort.remove(path): Promise<void>`** (NUEVO): unlink idempotente (silencia ENOENT).
- **`withCwdLock<T>(fs, paths, fn, options?): Promise<T | { error }>`** en `lock-service.ts`: helper que centraliza acquire/try/release. Devuelve shape `{error}` para que callers lo propaguen sin throw.
- **9 tests nuevos**: 5 en `tests/unit/node-file-system-exclusive.test.ts` (atomic primitive sobre FS real, incluye prueba de 5 calls paralelos → exactamente 1 success), 4 en `tests/unit/lock-service-atomic.test.ts` (race semantics: holder activo / stale / release marker).

### Changed — R2 acquireLock atómico (session025)

- **`acquireLock`** (`src/application/lock-service.ts`) reescrito con loop hasta 3 retries: `writeTextExclusive` → si holder activo, `LockBusyError`; si stale/release-marker, `remove` + retry. Elimina el patrón check-then-write previo.
- **`session-create-service.ts`**, **`session-close-service.ts`**, **`upgrade-hub-mode-service.ts`** ahora envuelven sus writes a HISTORY.md / CLAUDE.md / AGENTS.md en `withCwdLock`. Cierra los 3 sitios de bypass detectados en session023.

### Changed — R3 readers bilingual (session024)

- **`SessionsService.list`** (`src/application/sessions-service.ts`) ahora lee state desde HISTORY.md (source-of-truth post-R2) vía nuevo `readHistoryStateMap()` en `session-resolver.ts`. Cadena de prioridad: HISTORY.md > STATUS.md > legacy heuristic. STATUS.md preservado como fallback para sesiones pre-R2.
- **`buildSessionEntry`** ahora lee phase desde CHECKPOINT.md vía nuevo `readPhaseFromCheckpoint()` (matchea `## Current phase` EN o `## Fase actual` ES legacy). Cadena: CHECKPOINT.md > STATUS.md > "requirement" (legacy default).
- **`computeCheckpointStatus`** (`src/application/checkpoint-service.ts`) `sectionToField()` extendido con matchers EN canon (`last action`, `next step`, `files touched`, `critical context`). `parseMdValue("Actualizado")` con fallback a `"Updated"`.
- **`extractOrigen`** (`src/application/parsers/objetivo.ts`) usa `parseMdSectionBilingual("Origen")` que resuelve EN+ES vía KEYWORD_GROUPS.
- **`readOrigenSummary`** (`src/application/checkpoint/state-reader.ts`) regex bilingual `/^##\s+(Origen|Origin)\s*$/i`.
- **`renderOrigenBlock`** (`src/application/handoff.ts`) emite `## Origin` (EN canon) en sesiones nuevas; lectura ES legacy preservada.

### Added — R3 EN canon test fixture

- **`tests/fixtures/sample-workspace-en/`** (NUEVO, 7 archivos): fixture con HISTORY.md + sesiones EN canon (`OBJECTIVE.md`, `## Current phase`, `## Last action`). Complementa la fixture ES legacy `sample-workspace/` que se mantiene intocada.
- **8 tests nuevos**: 3 en `tests/golden/sessions-state-from-history.test.ts`, 2 en `tests/unit/checkpoint-placeholders-en.test.ts`, 3 en `tests/unit/origen-bilingual.test.ts`.

### Migration

Sin breaking changes. La API pública sumó 2 métodos a `FileSystemPort` (`writeTextExclusive`, `remove`) — implementaciones custom del port deben agregarlas. Los readers ahora son bilingual: sesiones legacy ES siguen funcionando idénticamente; sesiones canónicas EN ahora se leen correctamente. `aw sessions` reportará phases reales (`closure`, `execution`, etc.) en lugar de `requirement` para sesiones con CHECKPOINT.md.

### Tests

- 331 tests passing (vs 314 en 5.4.0). Lint: 0 errors. 40 test files.

## [5.4.0] — 2026-05-08

**Minor — R2 Phase 1: lock file mínimo (session022).** Cierra la primera fase del hardening file-based identificada en `agent-workflow-last/.workflow/sessions/session016-analyze-cli-bd-local-i18n/CONCLUSIONES.md` §R2. Serializa escrituras a archivos centralizados (HISTORY.md y bloque QTC-PROJECT en CLAUDE.md/AGENTS.md) en escenarios multi-host vía `.<ns>/.lock` con auto-expire 5min. Apoyado en el atomic-write port-level introducido en R1 (`5.3.0`).

### Added

- **`src/application/lock-service.ts`** (NUEVO):
  - `acquireLock(lockPath, fs, options): Promise<LockHandle>` — claim atómico vía atomic-write con detección de stale (TTL default 5min) y robo de lock corrupto.
  - `LockHandle` con `release()` idempotente que escribe marker vacío (próximo acquire lo trata como expirado).
  - `LockBusyError` con `holder` (pid + ts) para mensajes de error informativos.
  - Helpers exportados: `parseLock`, `isExpired`, `DEFAULT_LOCK_TTL_MS = 300_000`.
  - Inyección de `now()` y `pid` para testabilidad.
- **`PathsService.cwdLockFile()`** — resuelve `.<ns>/.lock` dentro del workspace.
- **20 tests** en `tests/unit/lock-service.test.ts` cubriendo: happy-path, concurrent acquire (LockBusy), stale lock steal, TTL boundary, corrupt JSON, empty release marker, structurally invalid JSON, release idempotente, parser y predicado de expiración.

### Changed

- **`runHistoryUpdate`** (`src/application/history-update-service.ts`) ahora envuelve el `upsertRow` en acquire/release. Si el lock está ocupado retorna `{error: "lock ocupado (pid X desde ts); reintenta o espera 5min"}` para que el caller lo proyecte al envelope JSON estándar.
- **`runProjectMdUpsertWrite`** (`src/application/project-md-upsert-service.ts`) idem — wrap del `writeAllFiles` (CLAUDE.md / AGENTS.md) en acquire/release.
- **`acquireLock`** asegura `fs.mkdirp(dirname(lockPath))` antes del write, para casos como `runHubInit` donde `.workspace/` no existe todavía.

### Migration

Sin breaking changes. Comandos que previamente escribían HISTORY.md / CLAUDE.md / AGENTS.md siguen funcionando idénticamente; ahora bajo lock cooperativo. En escenarios single-host (caso típico) el lock se acquire/release en milisegundos sin contención observable. En escenarios multi-host (p.ej. dos máquinas escribiendo el mismo HISTORY.md sobre un repo compartido) el segundo proceso recibe `LockBusy` con info del holder en vez de pisar la escritura.

### Tests

- 314 tests passing (vs 294 en 5.3.0). Lint: 0 errors. 35 test files.

## [5.3.0] — 2026-05-08

**Minor — R1 atomic-write port + R3 i18n Sprint 1+2 (sessions 017–019).** Cimiento bilingüe del runtime: lectura tolerante a artefactos en ES (legacy) o EN (canónico nuevo), escritura canónica en EN para sesiones nuevas. Sin breaking — sesiones legacy `OBJETIVO.md` siguen siendo legibles por los nuevos resolvers.

### Added — R1 atomic-write + bilingual resolvers (session017, `3e53e76`)

- **`NodeFileSystem.writeText` con atomic-write** (`src/adapters/node-file-system.ts`): write a `<path>.<pid>.<n>.tmp` + `rename` atómico. Cubre transparentemente los ~21 sitios de escritura vía el `FileSystemPort`. Habilita writes seguros del lock file (R2 Phase 1) y otros artefactos sin condición de carrera.
- **`src/application/session-artifacts.ts`** (NUEVO): `ArtifactKind` (14 kinds: `objective`, `findings`, `decisions`, `evidence`, `conclusions`, `recommendation`, `delivery`, `dependencies`, `discovery`, `problem`, `tasks`, `checkpoint`, `status`, `requirements`), `ARTIFACT_FILENAMES`, helpers `canonicalArtifactFilename`, `canonicalArtifactPath`, `findArtifact`, `listExistingArtifacts`. EN preferido + ES legacy fallback + case-insensitive + `fs.exists` fallback.
- **Parsers bilingües** (`src/application/markdown.ts`): `KEYWORD_GROUPS` con 17 grupos iniciales + `bilingualAliases`. Funciones `parseMdValueBilingual` / `parseMdSectionBilingual` con normalización NFD + accent strip + lowercase. Drop-in replacements de los originales.
- **20 tests** en `tests/unit/session-artifacts.test.ts` cubriendo los 14 kinds, fallback case-insensitive, fs.exists fallback, listado.
- **9 tests** en `tests/unit/markdown-bilingual.test.ts` cubriendo lookup bilingüe + accent normalization.

### Added — R3 Sprint 1 i18n templates (session018, `fa03324`)

- **`templates/objective.ts`** + **`checkpoint/markdown.ts`**: emisión EN canónica (`## Modality`, `## Current phase`, `## Last activity`, `## Type`, etc.). Sesiones nuevas reciben templates en EN; sesiones legacy ES siguen siendo legibles por los parsers bilingües.
- **`session-create-service.ts:173`**: write canónico de `OBJECTIVE.md` (en lugar del legacy `OBJETIVO.md`). Las sesiones legacy con `OBJETIVO.md` siguen siendo resueltas por `findArtifact`.
- **Flags `--modality` / `--type`** en `session-create` (legacy `--modalidad` / `--tipo` aceptados, normalizados a EN al persistir).

### Added — R3 Sprint 2 KEYWORD_GROUPS extendido (session019, `c231210`)

- **+27 grupos en `KEYWORD_GROUPS`** cubriendo headings emitidos por las 6 specialty skills (analyze-investigate, analyze-synthesize, analyze-conclude, design-deliver, design-discover, design-develop) y skills de orquestación.

### Changed

- **Política i18n del runtime qtc-*** (documentada en `qtc-workflow-plugin/docs/agent-rules.md`): runtime EN UPPERCASE, prosa libre en idioma del usuario, AI↔usuario en idioma del usuario, legacy via aliases ES+EN permanentes.

### Migration

Sesiones legacy `OBJETIVO.md` siguen funcionando sin tocar nada. Sesiones nuevas escriben `OBJECTIVE.md` y discriminators EN. No requiere migración manual.

### Tests

- 294 tests passing (vs 268 en 5.0.0). Lint: 0 errors. 34 test files.

## [5.2.0] — 2026-05-08

**Minor — refactor 5 services CLI >400 líneas (session012).** Cuatro splits modulares (plugin-doctor 794, multiroot 557, checkpoint-write 304, dev-graduate, etc.) preservando comportamiento.

### Changed

- **`src/application/multiroot-service.ts`** + **`src/application/plugin-doctor/exported-skills.ts`**: biome auto-format imports + line wrap.
- **`src/application/checkpoint-write-service.ts`** (304 líneas) refactor a 8 helpers, complejidad ciclomática 206 → ≤15.
- **`src/application/multiroot-service.ts`** (557 líneas) refactor.
- **`src/application/plugin-doctor/`** (794 líneas) split en 8 helpers.

## [5.0.2] — 2026-05-08

**Patch — refactor multi-command files + extract shared parsers (session010).** Split de archivos multi-comando del CLI (wave2-extras 5 cmds, wave2-final 6 cmds, wave4d-simple 4 cmds) extrayendo parsers compartidos.

### Changed

- Split de archivos multi-comando del CLI por bounded context.
- Extracción de parsers compartidos a módulo común.

## [5.0.1] — 2026-05-08

**Patch — `--graduated-conclusions` flag en session-close (session005).** Permite documentar slugs de conclusiones graduadas en `HISTORY.md` al cerrar la sesión.

### Added

- **`--graduated-conclusions <slug>`** flag en `agent-workflow session-close`. Mapeado a la columna `Refs` de `HISTORY.md` con link relativo a `docs/conclusiones/<num>-<slug>.md`.

## [5.0.0] — 2026-05-08

**Major BREAKING — modelo de artefactos simplificado (session006).** Refactor del comando `graduate` para soportar un set canónico de 6 kinds y resolver el destino siempre al workspace root (hub o project), eliminando el prompt M12 de routing por sesión. Sesiones cerradas con el modelo anterior (`docs/planes/`, `docs/refactors/`, `docs/design/`, `docs/design-system/`, `docs/rfcs/`, `docs/post-mortems/`, `docs/analisis/`) quedan tal cual; las nuevas siguen el set reducido.

### BREAKING

- **Set de kinds reducido a 6**: `decision`, `manual`, `script`, `especificacion`, `conclusion`, `release`. Eliminados `plan`, `refactor`, `design`, `design-system`, `rfc`, `postmortem`, `analysis`. Llamadas con kinds antiguos retornan error con la lista actual.
- **`--kind plan` eliminado sin reemplazo**: TASKS.md vive en la sesión y no se gradúa (era ruido).
- **`--kind refactor` eliminado sin reemplazo**: REFACTOR.md vive en la sesión; si requiere graduarse, curarlo como `--kind manual` o `--kind especificacion`.
- **`--kind rfc` / `--kind postmortem` / `--kind analysis` → `--kind conclusion`**: el documento fuente único pasa a ser `CONCLUSIONES.md` (modalidad embebida `tecnica`/`incidente`/`datos` en `## Modalidad`).
- **`--kind design` / `--kind design-system` → `--kind especificacion`**: la distinción proyecto/sistema queda como metadato del documento.
- **`--kind release` rechazado desde `graduate`**: usar el comando/skill `release` (es el único disparador de `--kind release` y `--kind script`).
- **M12 (graduacion-destino) eliminado**: la regla "hub mode → hub root, project mode → cwd" es absoluta. Ya no se pregunta por sesión. Reemplaza la regla anterior "manual/refactor/script gradúan a fuente, rfc/postmortem/analisis gradúan a hub" canonizada en session005.

### Added

- **`graduateManual`** — copia `<sesión>/MANUAL.md` (o `--source <path>`) a `docs/manuales/NNN-<slug>.md`.
- **`graduateScript`** — copia `<sesión>/scripts/` y `<sesión>/queries/` (si existen) como bundle a `docs/scripts/NNN-sessionXXX-<slug>/`. Pensado para invocación desde el comando `release`; soporta llamada directa.
- **`graduateEspecificacion`** — copia `<sesión>/ENTREGA.md` (o `--source <path>`) a `docs/especificaciones/NNN-<slug>/<filename>`.
- **`graduateConclusion`** — copia `<sesión>/CONCLUSIONES.md` a `docs/conclusiones/NNN-<slug>.md`.
- **`resolveWorkspaceRoot(fs, env, paths)`** (`src/application/paths-service.ts`): walk-up desde `env.cwd()` buscando el directorio que contiene `.<ns>/`. Fix para el caso "user hizo `cd <fuente>` antes de `graduate`" — el destino sigue siendo el hub-root, nunca la fuente. Se aplica también a la resolución de sesión (`runGraduate` reconstruye `PathsService` con el workspace root cuando difiere del cwd).
- **`--source <path>`** (input opcional) en `graduate` para `--kind manual` / `--kind especificacion`: especifica el archivo fuente dentro de la sesión cuando difiere del default.
- **Tests dedicados a `graduate`**: `tests/unit/dev-graduate-service.test.ts` con 25 tests cubriendo input validation, los 6 kinds (happy paths + errores), auto-numbering separado para archivos vs directorios, modo `project` (cwd) y modo `hub` (workspace root distinto), y walk-up desde una fuente subdirectory (DEC-002).

### Changed

- `runGraduate` (`src/application/dev-graduate-service.ts`) refactorizado completo. La numeración de archivos vs directorios ahora se separa (`nextNumberInDir` para `.md`, `nextNumberInDirsByPrefix` para bundles), evitando colisiones cuando ambos formatos coexisten.
- `graduateCommand` (`src/cli/commands/wave4d-simple.ts`): `describe` actualizado a la lista canónica de kinds invocables; lectura de `--source`; `--id` (alias `--dec-id`) capturado solo cuando `kind === "decision"`.

### Removed

- `GraduatePlanOutput`, `graduatePlan`: el kind `plan` ya no existe.

### Migration

Mapeo viejo → nuevo:

| Antes | Ahora |
|---|---|
| `graduate --kind rfc --session CODE --slug X` | `graduate --kind conclusion --session CODE --slug X` |
| `graduate --kind postmortem --session CODE --slug X` | `graduate --kind conclusion --session CODE --slug X` |
| `graduate --kind analysis --session CODE --slug X` | `graduate --kind conclusion --session CODE --slug X` |
| `graduate --kind design --session CODE --slug X` | `graduate --kind especificacion --session CODE --slug X` |
| `graduate --kind design-system --session CODE --slug X` | `graduate --kind especificacion --session CODE --slug X` |
| `graduate --kind plan --session CODE --slug X` | (sin reemplazo — TASKS.md queda en sesión) |
| `graduate --kind refactor --session CODE --slug X` | (sin reemplazo — REFACTOR.md queda en sesión; curar como `--kind manual` o `--kind especificacion` si se necesita graduar) |

Sesiones que ya graduaron a `docs/planes/`, `docs/refactors/`, `docs/design/`, `docs/design-system/`, `docs/rfcs/`, `docs/post-mortems/`, `docs/analisis/` no requieren migración — las carpetas siguen existiendo y son legibles. Las nuevas graduaciones usan el set reducido.

### Documentation context

- Modelo nuevo definido en `agent-workflow-refactor/.workflow/sessions/session006-dev-simplificar-modelo-artefactos/DECISIONES.md` (DEC-001..DEC-004).
- Manual del lifecycle reescrito: `agent-workflow-refactor/docs/manuales/000-mapa-artefactos-workflow.md`.
- Plugin `qtc-workflow-plugin` v2.0.0 — consolidación de `analyze-rfc`/`analyze-data`/`analyze-postmortem` en `analyze-conclude`, M12 removido del catálogo, regla canónica `references/graduacion-routing.md` reescrita.

## [4.7.0] — 2026-05-07

**Minor — `graduation-check` command + soporte para regla canónica de routing hub-vs-fuente (session005).** Nuevo chequeo orientado a hub workspaces que detecta artefactos graduados a `<fuente>/docs/<categoria>/` sin breadcrumb correspondiente en `<hub>/docs/<categoria>/000-INDEX.md`. Apoya el cumplimiento de la regla documentada en `qtc-workflow-plugin/skills/session/references/graduacion-routing.md`.

### Added

- **`agent-workflow graduation-check`** (`src/application/graduation-check-service.ts` + `src/cli/commands/graduation-check.ts`): walks `docs/{manuales,rfcs,post-mortems,analisis,refactors}` en cada fuente declarada en CLAUDE.md/AGENTS.md del cwd y reporta orphans (archivo en fuente sin mención en `<hub>/docs/<categoria>/000-INDEX.md`). Retorna `status: ok|warn|skipped`. Skip silencioso fuera de hub mode (CLAUDE.md no encontrado, no `Mode: hub`, o sin fuentes declaradas). Exit code 1 si hay warnings.

### Documentation context

- La regla canónica + tabla de defaults (rfc/post-mortem/analisis → hub; manual/refactor/script → fuente) vive en el plugin `qtc-workflow-plugin`. El comando del CLI valida cumplimiento, no impone decisiones.
- Prompt M12 `graduacion-destino` agregado al catálogo (en `qtc-workflow-plugin/skills/session/references/prompts-catalog.md`) — disparado al closure en hub mode.

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
