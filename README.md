# @tacuchi/agent-workflow-cli

Agnostic runtime CLI for **Workline** — the **stages + loops + artifacts** system for agent work. Bundles the universal **`w`** skill set (`w` = *workline*); host-provided help is optional and never bypasses a flow's approvals or validation.

The CLI exposes two binaries: `agent-workflow` (canonical) and `aw` (short alias).

## Install

```bash
npm install -g @tacuchi/agent-workflow-cli
```

## The model — stages + loops + artifacts

Workline has three layers plus a permanent `docs/` zone:

- **Layer 1 · Commands** (`/w:*`) — the only thing the user invokes:
  - **SPEC** — `/w:spec-new` (single-pass draft after a bounded reconnaissance of the sources; may split into sibling specs) → `/w:spec-refine` (gap-driven loop; converges at `status: ready-for-plan` — the blocking functional decisions closed, the technical ones declared for PLAN) → `docs/specs/`.
  - **PLAN** — `/w:plan-new` → (`/w:plan-refine` — aux, optional) → `/w:plan-exec` → `docs/plans/` (the plan loops may split into sibling plans). A plan is a sequence of **functional states**: every phase names a verifiable state, carries its own primary proof, and — **only when the change carries temporary behavior** — declares where a simulation lives and when it retires. Ticking every checkbox is not validation, and validating every phase is not closing the plan.
  - **QUICK** — `/w:quick` — lightweight shortcut; escalates live to SPEC when the goal outgrows a quick.
  - **EXPORTS** — `/w:export-scripts` · `export-manuals` · `export-diagrams` · `export-reports` (the only path that promotes artifacts to `docs/`).
  - **Hub** — every invoked directory is usable immediately. `/w:hub-init` only materializes the runtime early, or configures sources when they are supplied.
  - **Transversal** — `/w:status` · `/w:doctor` (read-only diagnosis across every detected host, with the verdict in the exit code; repairs only what Workline owns, over a batch approved by digest) · `/w:resume` (read-only: composes `/w:status` and proposes how to continue, routed to the target command) · `/w:recall` (what the other hosts' curated memory learned about Workline, contrasted and applied; saving goes to the current host's own memory only after confirmation) · `/w:persist` (persists in-conversation work into `docs/` — classify → `docs/research` · spec draft · plan adoption; the host→`docs/` counterpart of `export-*`).
- **Layer 2 · Loops** — the AI runs them whole: `spec-refine-loop` · `plan-new-loop` · `plan-refine-loop` · `plan-exec-loop` · `quick-loop` — all heirs of the shared engine `skills/w/loops/CHASSIS.md` (+ `CODE-POLICIES.md` for the code-editing loops). Each loop is a **persistent goal** that runs until its success criteria are green (verification-first); gap-driven, with **structured-choice** lifecycle control (compact/close — the host's own question surface where one is reachable, **labeled markdown** where none is; the binding per host is stamped into what gets installed) and resumable `CHECKPOINT`.
- **Layer 3 · Sessions + artifacts** — internal, ephemeral process state under `.workflow/sessions/` (`SESSION` · `CHECKPOINT` · `BACKLOG` · `SCRIPTS.sql` · `ANALYSIS-FILE` · `CONCLUSIONS` · `DECISION` · …). Sessions are slug-named folders, created by loops, never by the user.

**Capacidad propia.** `overview` orienta sobre Workline mediante la skill `w`. Su binding se resuelve por `skills.toml` (default → global → hub); `off` conserva el opt-out y los bindings históricos ajenos se avisan sin reescribirlos. `aw skills --detail` informa sólo sobre capacidades y wrappers propios. SPEC resuelve las decisiones UI como decisiones funcionales ordinarias; PLAN y QUICK aceptan ayuda del host sin exigir una skill externa. Los exports conservan destinos y guardas independientemente de cómo se produzca el contenido. Los lanzadores y registros de procesos anteriores son artefactos inertes y permanecen gitignorados.

**Invariants.** No auto-export (only `export-*` writes `docs/`); the spec and plan are documents, not artifacts; DB scripts-only (never executes DML/DDL); git-safe (verifies the per-source working branch before edits; proposes commits).

### PLAN — a plan is a sequence of functional states

A `### Fn` phase is a **verifiable state of the system**, not a batch of technical tasks. It answers one question: *what can the system do or demonstrate at the end that it could not at the start?* The contract is defined **once** in `skills/w/loops/plan-new-loop/LOOP.md` (§ *Phase contract*); the other two plan loops reference it and never redefine it.

- **Phase shape** — required always: `Resultado` · `Trabajo` · `Validación de fase` · `Condición de salida` and `> Fuentes:`. The plan also declares `> Límite de ejecución: checkout`; every task names a non-empty subset of its phase sources with `_(fuentes: …)_`. Conditional, each only when its condition holds: `Estado inicial`, `Recorrido afectado`, `Dependencias`, `Límite de simulación` and `Diferido`. A conditional block is **never written empty** — no `no aplica` placeholders. Granularity is semantic: a task is a unit of purpose that may touch several files, never an edit operation ("create class X").
- **Phase state** — one `> Estado:` line per phase (`pendiente` | `en ejecución` | `bloqueada` | `validada`), machine state that `aw status` parses. A phase reaches `validada` only with its proof green, its exit condition true and the closing review gate passed — **never** because its checkboxes are ticked. A `bloqueada` phase states what it waits on in its own `> Bloqueo:` line.
- **Plan state** — one `> Estado:` line under the title (`open` | `done`), plus a `> Cierre: YYYY-MM-DD · sesión NNN` line on close. It is the third axis, not a summary of the other two: every phase validated with no closure is a plan still `open`, awaiting its **final validation**.
- **Temporary simulation** — **only when the change carries one**, and then planned with a lifecycle: where it is born, how it moves (`antes → después`), which phase retires it, and what prevents it from being selected in a production runtime. A change with no temporary behavior declares no boundary and no gate asks for one. A stub still live on the main path with no declared removal is a review finding.
- **Evidence** — one primary proof per phase; focused tests only where a layer owns rules, transformation, persistence or integration; risk tests on top of those. Tests that only mirror structure are flagged `overtest` at the closing review gate.

The authoring side and the execution side share one gate, seen from both ends:

```
  plan-new ──┐
             ├──▶ executability gate ──▶ plan-exec ──▶ phase cycle ──▶ validada
  plan-refine ┘                              │
                                             ├─ structural deviation ─▶ plan-refine
                                             └─ functional change ────▶ spec-refine
```

`plan-refine` converges when the plan is executable; `plan-exec` re-checks that same shape on entry, normalizes only minor gaps with consent, and returns the work instead of redesigning it silently.

Progress is reported on **three** independent axes, and none stands in for another:

| Axis | Question | Field |
|---|---|---|
| task completed | what work was done | `progress_pct` (checkbox-derived, unchanged) |
| phase validated | what functional state was demonstrated | `phases_validated` / `phases_total` |
| plan closed | whether the whole solution was validated | `plan_state` |

A plan at 100% of checkboxes with zero validated phases is work implemented, not validated. A plan with every phase validated and no closure is `open` with `final_validation_pending: true` — the **final validation** never ran. A plan declaring `done` over open tasks or unvalidated phases is `inconsistent`, reported as a contradiction rather than a closure. Both `/w:status` and `/w:resume` say so, and a `bloqueada` phase is shown with the `> Bloqueo:` reason that says what unblocks it.

## Bundled SKILL

The published tarball bundles the universal skill set under `skills/w/`. Install it into your host with `--target` (required):

```bash
agent-workflow self install --target claude     # or: codex · warp · oz · gemini · opencode · crush · kimi · agents
agent-workflow self install --target all --confirm-all
agent-workflow self detect-hosts                # which hosts are present + already have it
agent-workflow self install --target claude --dry-run
```

La instalación actualiza sólo artefactos propios: el bundle `w`, wrappers y hooks administrados. Al actualizar, retira un wrapper `design` anterior únicamente si sus bytes prueban propiedad de Workline; conserva e informa copias intervenidas o ajenas. `--keep-legacy` conserva también el legado propio identificado. Para ayudas externas, usa el mecanismo nativo del host.

### Per-target install matrix

`self install --target <host>` installs **SKILL + user-level slash commands + hooks** in one shot, scaled to what the host supports:

| Host | Level | SKILL | User-level commands | Hooks |
|---|---|---|---|---|
| `claude` | official | `~/.claude/skills/w/` | `~/.claude/commands/w/<n>.md` → `/w:<n>` | `~/.claude/settings.json` (JSON merge + backup) |
| `codex` | official | `~/.codex/skills/w/` | synthesized skills `~/.codex/skills/w-<n>/` → `$w-<n>` (Codex reads no commands dir) | **not armed, and not for lack of wiring**: they would go in `~/.codex/hooks.json` (Claude-shaped, every template event fits), but Codex requires an *interactive human review per hook* — writing the file does not arm it, and forging its `trusted_hash` would forge your approval |
| `warp` | official | `~/.warp/skills/w/` | synthesized skills `~/.warp/skills/w-<n>/` → `/w-<n>` | none (no hook system) |
| `gemini` | official | `~/.gemini/skills/w/` | synthesized skills `~/.gemini/skills/w-<n>/` (Antigravity `agy`) + `~/.gemini/commands/w/<n>.toml` → `/w:<n>` (legacy Gemini CLI) | not armed (extension-bundled) |
| `kimi` | official · pre-1.0 | `~/.kimi-code/skills/w/` (also reads `~/.agents/skills`) | synthesized skills `~/.kimi-code/skills/w-<n>/` → `/skill:w-<n>` | `~/.kimi-code/config.toml` → managed `[[hooks]]` block (marked + backup) |
| `oz` | best-effort · pre-1.0 | `~/.agents/skills/w/` | synthesized skills `~/.agents/skills/w-<n>/` | none |
| `opencode` | best-effort | `~/.opencode/skills/w/` | `~/.opencode/command/w/<n>.md` → `/w/<n>` | not armed (JS plugins) |
| `crush` | best-effort · pre-1.0 | `~/.config/crush/skills/w/` (XDG — the only global root Crush reads; `~/.crush` holds commands only) | `~/.crush/commands/w/<n>.md` → palette `user:w:<n>` | not armed (preliminary) |
| `agents` | *shared destination, not a host* | `~/.agents/skills/w/` | skipped (shared dir) | skipped |

The bundle's internal manuals (`loops/*/LOOP.md`, `roles/*/ROLE.md`, `exports/*/EXPORT.md`, `harness/HARNESS.md`) are deliberately **not** `SKILL.md` files, so hosts that scan skill roots recursively (Codex, OpenCode, Crush) never list them as invocable skills — only the commands and the `w` orientation skill surface. Where a layer is skipped, the SKILL is sufficient — the AI reads it and invokes `agent-workflow <subcommand>` directly.

Opt-out flags: `--skill-only`, `--no-commands`, `--no-hooks`. Override the source with `--from /path/to/skills/w`. Other flags: `--confirm-all` (required with `--target all`), `--keep-legacy`, `--force`, `--dry-run`.

Los flujos verifican la rama declarada por fuente antes de editar (`aw check-branch`), sin hooks generales de rama o commit. La integración conserva una unidad con conflicto y exige resolución externa antes del reintento.

**What `--target all` means.** Every **host** — never the shared skills dirs, which are install destinations rather than hosts and are reached explicitly (`--target agents`). `install` and `uninstall` use the same set, so the round trip matches: what `all` installs is what `all` removes. (`oz` installs into `~/.agents/skills`, so that directory is still covered under `all` through its host.)

### Support levels and how long a verification is worth

**official** — Claude Code, Codex, Warp, Gemini/Antigravity, Kimi Code. **best-effort** — Oz, OpenCode, Crush. `agents` is a shared destination, not a host, and never counts as one.

The difference is what gets *checked*, not what gets installed: local fixtures verify the artifacts this checkout generates. `npm run smoke:hosts` remains an optional operator observation of installed runtimes; it never closes a Workline phase or substitutes checkout proof. Any host state recorded by an operator is informational, and a host without that observation remains `unverified`.

**Host run.** The smoke only proves what gets installed. What a host really does with each surface (`commands`, `structured-choice`, `hooks`, `mcp`, `host-memory`, `compaction`) is observed by the maintainer's host run, which drives the same scenario inside the four covered hosts (Claude Code, Codex, Gemini/Antigravity, OpenCode) in [Herdr](https://herdr.dev) panes. Not covered, each with its reason in every matrix: Warp and Oz (no local interactive session a pane can drive), Kimi Code (excluded by you: subscription cancelled) and Crush (excluded by you on 2026-09-30: its provider timed out in the auth probe three times, left out to limit cost). Their profiles stay in `scripts/host-run/profiles/`, out of every run.

Your steps, from a plain terminal outside Herdr and outside any agent host:

1. Start Herdr first, in another terminal (`herdr`; `herdr status server` shows it running), before any token or key is in your shell, so its server's environment never holds one.
2. Put each secret in a file only you can read, and pass the file: no shell environment or history holds the value then.
   - Claude: `claude setup-token`, save what it prints to a file, `chmod 600` it, pass `--claude-token-file <file>`. Without it the auth check says `token absent …` and spends no probe on Claude.
   - crush is not covered now (see above); if it is brought back, it takes a Gemini API key, free from Google AI Studio, in a `chmod 600` file: `--crush-gemini-key-file <file>`. crush then runs `gemini/gemini-3-flash-preview` from its own catalog, not your crush data. The paid alternative is `--crush-openai-key-file <file>` (`openai/gpt-5.6-luna`); with both, Gemini is used and the run says so.
   - opencode: it runs `openai/gpt-6-astra` from its own catalog (models.dev, provider `openai`) unless you pass `--model opencode=<provider/model>`, and its auth check is one turn with that model. It uses your copied sign-in (`auth.json`); to use an API key instead, pass `--opencode-openai-key-file <file>` (or `OPENAI_API_KEY`), which reaches only opencode's wrapper.
   - agy (Antigravity) takes no key: you sign in with your own login inside its pane when the run starts. No agy probe runs beforehand (without a login a probe opens the OAuth flow); while the sign-in is on screen the run notifies you once and sends nothing, and its code and URL are redacted from the transcript and the evidence. A `GEMINI_API_KEY` in your shell never reaches agy. agy stores its login in your macOS login keychain (per user, not per HOME): the pane may reuse your existing agy login, and signing in or a token refresh may overwrite it; `/logout` in the pane would remove it (the run never sends it). The digest you type seals that consent.
   - Prefer one file per host. A variable in your shell is used only for a host whose flag file is not given, and one variable feeding two hosts is warned about in the dry-run and the auth check.
   - Instead of files, `read -rs VAR; export VAR` works too (`CLAUDE_CODE_OAUTH_TOKEN`, or `OPENAI_API_KEY` for opencode), in the same terminal as the run.
   - A value never reaches the dry-run, the digest (only present/absent per host), the evidence, the ledger, a notification or the local transcript. It is written to a 0600 file in that host's disposable root just before its auth probe and its pane start; the host's wrapper reads it and deletes it before exec'ing the host. The run waits up to 120 s for a pane to start its wrapper; after that it removes the file and tells you the host may start unauthenticated.
   - Every setup step and probe runs with no stdin, its output captured and no controlling terminal, so a host can neither print to your terminal nor start an interactive sign-in there. A failed probe prints one sanitized reason (`probe needs interactive sign-in`, `credentials rejected`, `model API error: RESOURCE_EXHAUSTED, …`, `timeout`, `probe exited <n>` …) and the path of its output, redacted, in a 0600 file of the 0700 transcripts dir.
   - Limits: Claude's pane sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. Per the [env-vars reference](https://code.claude.com/docs/en/env-vars) this strips Anthropic and other recognized credentials from Claude's Bash tool, hooks and stdio MCP servers, while Claude keeps them for its own API calls. Their own children inherit the scrubbed environment. No live run has yet confirmed that 2.1.284 strips `CLAUDE_CODE_OAUTH_TOKEN`. If crush is brought back: its provider key is in its env, so its own children (the bash tool, hooks, stdio MCP servers) inherit it; the run keeps crush in-process (`CRUSH_CLIENT_SERVER=0`, no detached server) and on its embedded catalog (`CRUSH_DISABLE_PROVIDER_AUTO_UPDATE=1`), and cleanup ends every process whose command line or working directory lies in a disposable root. Every `aw` a host runs goes through the root's own shim, which refuses (exit 2, one line) any `--root`/`--hub` whose realpath lies outside that host's disposable root; the hosts' permission rules are only defense in depth. Codex's sandbox may write the disposable home's Workline registry (`.workflow/dev`, `lib`, `agent-workflow`, `skills.toml`, `user-config.md`) but never `.workflow/logs`, where the hook and MCP evidence is read. Claude and Codex deny the other hosts' disposable roots. OpenCode and Antigravity (and Crush, if brought back) cannot path-scope reads, so they could read another root's copied credentials unasked while the run lasts.
3. `node scripts/host-run/run.mjs --dry-run --claude-token-file <file> [--opencode-openai-key-file <file>]` — revisá el escenario de los cuatro hosts cubiertos. Muestra sólo la presencia de credenciales y avisa que agy inicia sesión en su panel.
4. `node scripts/host-run/run.mjs --auth-check` con los mismos flags — tecleá `check`. Prepara las raíces y prueba la autenticación; opencode consume un turno. Agy espera el inicio de sesión en su panel. Conserva las credenciales rotadas y limpia las raíces, sin abrir paneles de Herdr.
5. `node scripts/host-run/run.mjs` with the same flags — type the digest it shows.

`--hosts h1,h2` narrows any of them.

- `node scripts/host-run/run.mjs --dry-run` prints the scenario and its fixed answers, each host's permission profile, the credentials it would copy (existence only), the disposable home and workspace, the full `env -i` pane command and the Herdr panes. It prepares nothing.
- `node scripts/host-run/run.mjs [--model <host>=<m>] [--effort <host>=<e>] [--hosts …] [--steps …]` runs it. It needs a real terminal outside any agent host and your typed approval of the digest it shows. Each host gets a `mkdtemp` root (0700) with its own copy of this checkout's CLI (`dist`, `skills`, `package.json`, hashed equal to the checkout and recorded in the evidence) so nothing it reads or runs lies under your real HOME, a home with that Workline installed, a workspace with no remote and only its own credentials; everything is removed on exit. If a host does not authenticate from that home, the run stops before opening any pane.
- It answers only the scenario's Workline boundaries, by their literal labels. Every permission stays with you, in that host's pane; the other hosts keep going. The profiles deny the release-type operations and pre-approve only what is provably confined to the disposable root, so expect to approve most commands yourself. By decision this narrows AC-03/AC-04: Claude Code pre-approves its edits in the workspace, the Workline MCP tools and the scenario's own `aw` calls (its prefix rules know shell operators); Codex runs unprompted only inside a `hostrun` permission profile (extends `:workspace`, keeps network off with `[permissions.hostrun.network] enabled = false`, denies your real HOME and `/tmp` — each root carries its own copy of the CLI and its production dependencies, so sandboxed `aw` calls never need the denied HOME; the config shape loads in codex 0.157.1, the enforcement is not yet observed in a live run, so until then treat codex as able to read any file your user can); OpenCode, Crush and Antigravity pre-approve nothing, and you approve everything else in their pane. In the disposable home the run also strips the installed wrappers' `allowed-tools` grants (`/w:quick` and others grant Bash/Read/Write/Edit for their turn) and denies reading your real HOME.
- Copied OAuth credentials may rotate during the run. The rotated copy would die with the disposable home, so the run keeps any changed credential file in the transcripts directory (0700) and tells you; it never overwrites your real file.
- Evidence lands in `tests/fixtures/host-runs/<id>/`: `matrix.json` (8 hosts × 6 surfaces, each cell with the catalog state it was compared with, what was observed, the host and CLI versions and the mode) and one allowlisted extract per cell. Full transcripts stay on your machine, in `$TMPDIR/aw-host-transcripts-<id>-*`: that directory is kept on purpose after the run (the disposable homes are not) and is never committed. The run also writes each host's `run` block in `HOST_VERIFICATIONS`, which the smoke keeps.
- A degradation counts as declared (`declared_by_doctor`, AC-05) only when the host itself ran `/w:doctor` and relayed it on screen (`declared_source: "relay"`). When a host folds that report, the run also reads the same CLI's doctor in the disposable home and records it as `declared_source: "cli"`: supporting evidence only. Such a cell is `degraded-undeclared`, and it never closes.
- `node scripts/host-run/compare.mjs` marks what got worse since the previous run; `--assert-closed <id>…` fails while a covered cell is broken, not reached, catalog-outdated or undeclared by `/w:doctor`, taking the last observation of each cell across the runs given and judging it against the current catalog in `dist` (it notes where the catalog moved since the run).

**Cierre acotado de la corrida `2026-09-30T09-49-27Z`.** Por decisión de la persona, `unverified.json`, junto a `matrix.json`, declara las 18 celdas cubiertas que quedaron sin verificar: 3 rotas, 12 no alcanzadas y 3 degradadas sin relevo del doctor dentro del host. Cada entrada conserva la observación, el estado de la matriz, el motivo y el seguimiento en el BACKLOG de la sesión 280. La matriz y `HOST_VERIFICATIONS` conservan la evidencia original. Esta declaración permite cerrar el alcance acordado del plan 085; no acredita funcionamiento ni hace pasar `--assert-closed`. No se repite la corrida para este cierre.

**Skills compartidas de Oz.** `self install --target oz` escribe en `~/.agents/skills`, que también leen otros hosts. Sus wrappers conservan las invocaciones sin `--host oz` y usan la indicación neutral de selección de esa carpeta. Las instalaciones en carpetas exclusivas mantienen el host explícito.

Re-verify when a release touches a host, and repeat the host run then — as a suggestion, never a gate: no test depends on the latest run. A host marked **pre-1.0** (Kimi Code, Crush, Oz) can change its surface between its own releases faster than we re-check — Kimi Code ships roughly twice a week — so the table states the version a run actually proved and the date it proved it. It is a claim about that version, not a promise about the next one.

Validation platform: **macOS** is where all eight runtimes live and where the suite is expected to pass. **Windows** remains best-effort; **Linux** is documented without a guarantee.

### Retiring a host

Removing a host's key from `InstallTarget` makes TypeScript demand you delete its `TARGET_ROOTS` entry too — and the moment that path is gone, nothing can clean what previous releases installed there. The pattern, modeled on the `crush` root migration:

1. **Keep** the target alive in `InstallTarget` / `TARGET_ROOTS` for at least one release, and drop its `HarnessSpec` from `HARNESSES` — it stops being offered as a host while staying reachable for cleanup.
2. **Move** its old roots into `LEGACY_SKILL_ROOTS_BY_TARGET` so `install`/`uninstall`/`clean-legacy` sweep them, ownership-verified (those roots can be shared namespaces — never delete by dir name alone).
3. **Then** remove the key, once telemetry or a major version says nobody can still have it installed.

Skipping step 2 strands files in a directory no code path can name any more.

## TUI

Running `agent-workflow` (or `aw`) with no arguments opens the tab-based TUI:

| Tab | What it does |
|---|---|
| **Status** | Doctor dashboard: CLI / hosts / hooks / MCP tiles + daily operational logs. The hosts tile jumps to [Workline]. |
| **Workline** | Per-host administration of the bundled `w` SKILL (install / reinstall / uninstall, `hooks armed` state) plus a compact flows overview. |
| **Hub** | Hub sources, branches and git-flow actions. |
| **MCP** | Tools PostgreSQL de solo lectura. `mcp-connections.json` v2 es la única autoridad de alias, provider y variable DSN: registrá con `aw self mcp use-env --name alpha --dsn-var ALPHA_DATABASE_URL`. La TUI instala descriptores absolutos en user scope; `aw mcp setup` conserva además el modo hub portable dependiente de `PATH`. Cada host muestra configuración, launchability, recarga pendiente y carga observada; Codex queda opcional porque existe el fallback local `aw tool call`. |
| **Config** | Namespace, host-targeting preferences, and the hub branch defaults (written to the hub block). |

### PostgreSQL MCP y fallback local

V1 publica sólo `execute_sql` y `search_objects` para PostgreSQL. Ambas rutas usan el
mismo catálogo y el mismo JSON canónico: el servidor MCP devuelve ese JSON en
`content[0].text`, y el CLI lo imprime directamente, sin el envelope general.

```sh
aw tool list --connection qtc-cert
aw tool call execute_sql --connection qtc-cert --input-json '{"sql":"SELECT 1"}'
printf '%s' '{"object_type":"table","pattern":"user%"}' \
  | aw tool call search_objects --connection qtc-cert --input-json -
```

`execute_sql` acepta una sola sentencia de lectura y ejecuta cada llamada en una conexión
nueva, transacción `READ ONLY`, timeout de 30 s y rollback final. El resultado se limita a
1.000 filas y 4 MiB; la entrada JSON se limita a 1 MiB. Nunca pongas un DSN, SQL ni resultados
en los archivos de host, recibos u logs operativos.

`search_objects` conserva el envelope de DBHub 1.2.1: `object_type`, `pattern`, filtros
opcionales, `detail_level`, `count`, `results` y `truncated`. Sus siete tipos y tres niveles
mantienen los campos de descubrimiento de DBHub; `truncated` sólo vale `true` cuando se observó
una fila adicional que quedó fuera del límite.

`READ ONLY` no reemplaza una cuenta PostgreSQL de mínimo privilegio: no uses superuser, permisos
de escritura/creación, ni membresía o vía `SET ROLE` hacia `pg_signal_backend`,
`pg_signal_autovacuum_worker`, `pg_read_server_files`, `pg_write_server_files` o
`pg_execute_server_program`. El ejecutor rechaza superuser y esos roles de servidor; con
`aw mcp doctor --probe data`, los demás privilegios de escritura se informan como advertencia y la
conexión no queda marcada como segura. Tampoco concedas `EXECUTE` sobre extensiones o funciones con
efectos externos.

`aw mcp serve-db --instance <nombre>` es el servidor stdio; `aw mcp dbhub` sigue durante una
versión como alias deprecado. `aw mcp doctor --probe launch` comprueba `initialize → initialized
→ tools/list`; `--probe data` añade `SELECT 1 AS ok`. `aw mcp migrate` sólo muestra preview;
escribir requiere `--apply --force` y no se ejecuta automáticamente.

## Namespace resolution

Hub artifacts live under `.<namespace>/`. Resolution order (first match wins):

1. `--namespace <name>` flag
2. `AW_NAMESPACE` env var
3. **Hub auto-detect** — a single hidden `^\.[a-z][a-z0-9-]{1,30}$` folder in cwd containing `sessions/`
4. `~/.config/agent-workflow/namespace` user config
5. Default: `workflow` (→ `.workflow/`)

## Commands (selected)

- `hub-init` — materialize the runtime early; with sources, configure/reconcile hub metadata.
- `skills` — show resolved capability → skill bindings.
- `sessions` / `session-create --type <research|refine|exec|quick>` / `session-close` / `session-load` / `session-artifacts` — internal session lifecycle (used by the loops).
- `checkpoint-read` / `checkpoint-write --code` — `CHECKPOINT.md` handling.
- `hook pre-compact|post-compact|session-end|sql-mutation-guard` — the targets the host's hooks run (`aw --help --all` lists them).
- `flow <advance|submit>` — the direction engine: `advance` applies every consecutive `cli`-owned transition of a flow run and returns the directive of the first non-deterministic frontier; `submit` takes the response as JSON via stdin (`--approval <digest>` for effects) and keeps advancing.
- `sources` / `check-branch` / `set-working-branch` / `set-qa-branch` / `set-exception-branch` — multi-source git-safety (per-source base / working / QA / exception branches).
- `set-edit-mode in-place|unit` — declares checkout editing or isolated units in the hub block; plans can require `> Aislamiento: unidad`.
- `doc-branch show|set` — propone y asocia una rama de trabajo por documento y fuente, heredada por sus planes; `show` no modifica nada.
- `git-flow <sync|to-dev|to-qa|to-prod> [--source|--all] [--target] [--dry-run]` — run the per-source branch flows (sync working ← base, promote to dev/QA/prod) with conflict-pause; `--all` processes every source and reports each one. Also surfaced as Hub-tab actions.
- `release-data` — corpus reader backing the `export-*` skills.
- `self install-skill` / `self doctor` / `self update` / `mcp` — CLI maintenance.
- `amend <apply|revert|list>` — correct the WORDING of an already closed spec or plan in one act, under the hub lock and with the document's own digest as the compare-and-swap base; it demands an explicit declaration that no scope, criteria or rules move, records the exact pre-image in an append-only ledger, and refuses structurally whatever touches the contract (naming the refinement instead). CLI-only: there is no `/w:amend`.
- `settle <list|prepare|apply>` — settle or acknowledge the live obligations a decision note left on a plan whose execution run is already closed. `list` shows each one with its note, position, class, whether that class was declared and the plan's CURRENT resume point; `prepare` derives the same settlement note the closure derives, writes nothing and returns the digest that authorizes it; `apply` re-derives from the live hub, demands that digest and publishes under the lock. It refuses while an execution run holds the plan, naming that run — its closure settles its own obligations. CLI-only: there is no `/w:settle`.
- `cut-intent <declare|show>` — the intention with which a spec cut into several plans was meant to be executed: which plans travel together in one pass, in what order, and which are deferred with their cause. Correcting means declaring again — the previous record stays legible underneath, so a reordering is something a person can review instead of simply inherit. It restricts nothing: executing out of the declared order stays valid and is only warned. CLI-only: there is no `/w:cut-intent`.
- `release-pass <list|declare|arrived|applied|revert|link>` — the pass to production as its own object, because closed is not released. `declare` opens one over the sources it covers; `arrived` registers one source's arrival, and while another is still missing the pass reads partially released, naming both; `applied` registers that the SQL the pass carries RAN against a named environment — its own axis, never a fourth arrival kind, so a pass with no such record reads NO RECORD rather than nothing-applied; `revert` adds a reversion that never erases the arrivals it follows; `link` attaches a document by hub-relative path, checking only that it exists. Nothing here checks the world: registering is DECLARING a fact somebody already knows. It feeds the `production` axis of `status`/`resume` and the `--environment` filter of `export-scripts`. CLI-only: there is no `/w:release-pass`.

Run `agent-workflow --help` (or `aw --help`) for the full list, or `agent-workflow <command> --help` for per-command flags.

## Versioning

Semantic Versioning. Major bumps are reserved for breaking changes to commands, flags, or output schemas. See `CHANGELOG.md`.

## License

Copyright © 2026 Jesús Loayza (Tacuchi)

Licensed under the **GNU Affero General Public License v3.0 or later** (`AGPL-3.0-or-later`) — see [`LICENSE`](LICENSE).

In plain terms: anyone — including companies — may use, study, modify, and share this software for free, even commercially. But any copy you distribute, and any modified version you run as a network service, must stay open under this same license. It can never be turned into a closed-source/proprietary product.
