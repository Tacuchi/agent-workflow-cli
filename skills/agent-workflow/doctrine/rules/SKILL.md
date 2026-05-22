---
name: rules
description: "Bundle invokable de reglas transversales qtc-* — carga los 7 anchors canónicos (commits, sandbox plan-mode, MCP read-only, redacción, coding-standards, graduación, branch verification) en un solo lugar. Invocar antes de un commit ad-hoc fuera de `/agent-workflow:session`, antes de editar código sin sesión activa, durante onboarding de usuario nuevo a qtc-*, o cuando se quiera refrescar el contrato qtc-* en una conversación larga. No requiere sesión activa. v0.2.0: el anchor `agent-workflow:commits-policy` ahora documenta el propose-then-execute universal con AskUserQuestion M1 (cualquier solicitud o mención de commit, en/fuera de sesión, hub/project) + el bypass por mensaje literal."
version: 0.2.0
---

> **Profile parametrization**: lee `custom_anchors[]` de `profile.json` (resuelto vía cascade 5 capas). Ver [`references/profile-parametrization.md`](../../references/profile-parametrization.md) para el contrato completo y comportamiento por defecto cuando el profile está vacío.

# Rules — Bundle invokable de reglas transversales qtc-*

Skill agregadora que **carga las reglas transversales del runtime qtc-*** en un solo entry point. No reemplaza al AGENTS.md/CLAUDE.md por fuente (anchor passive de system-prompt); complementa con activación on-demand cuando se necesita refrescar el contrato.

Cada sección abajo cita el canon de su anchor — el AI lee el archivo completo cuando la regla requiere precisión (parámetros, casos edge). Acá quedan los headers, las reglas operativas y "cómo aplicar fuera de sesión".

## Cuándo invocar

- **Antes de un commit ad-hoc fuera de `/agent-workflow:session close`** — para refrescar la política de commits (formato, tag, prohibiciones) si el usuario te pide commitear.
- **Antes de editar código en una fuente qtc-* sin sesión activa** — para cargar coding-standards y la sandbox plan-mode.
- **Antes de ejecutar una query vía MCP `<mcp-cert>`/`<mcp-prod>`** — para refrescar el contrato read-only y reconocer cuándo proponer script SQL en lugar de mutación.
- **Durante onboarding** de un usuario nuevo a qtc-* — bundle único que reemplaza leer 7 archivos sueltos.
- **En conversaciones largas** donde el contexto qtc se diluyó — refresh rápido.
- Explícitamente con `Skill(agent-workflow:rules)` o por NL ("qué reglas qtc tengo", "antes de commitear", "refrescá el contrato qtc").

## Anchors canónicos

### 1. Commits — `agent-workflow:commits-policy`

**Canon**: `agent-workflow/skills/session/references/commits-policy.md` (5 reglas, anchor `agent-workflow:commits-policy`).

Resumen:
- El AI **nunca commitea por iniciativa propia**. Lista cerrada de operaciones git prohibidas sin solicitud explícita: `commit`, `commit --amend`, `push/--force`, `merge`, `rebase`, `cherry-pick`, `tag`, `reset --hard`, `restore .`, `checkout -- .`, `clean`.
- Cuando el usuario pide commit en sesión activa: 1 línea ≤72 chars, descriptiva, **incluye tag `session<NNN>`**, sin `Co-Authored-By`, sin firmas de modelo, sin `--no-verify`.
- **Propose-then-execute universal** (Regla 3): ante cualquier solicitud o mención de commit como acción a ejecutar, el AI invoca el prompt M1 (`prompts-catalog.md#M1`) con N questions tab-por-fuente. Aplica en closure (auto), en planning/execution con sesión activa, y sin sesión activa. Hub mode = N tabs; project mode = 1 question.
- **Bypass por mensaje literal** (Regla 5): si el usuario aporta el mensaje exacto del commit en la solicitud (`"commit con mensaje 'X'"`, `"-m 'X'"`), el AI ejecuta directo sin invocar M1.
- `release`, `release-scripts`, `graduate` nunca commitean.

Reglas operativas:
- Conventional Commits opcional (`feat:`, `fix:`, `chore:`, etc.), no obligatorio.
- Si la fuente tiene `match=false` (rama inesperada): no commitear; alinear primero vía branch-verification.

**Cómo aplicar fuera de sesión**:
- El tag `session<NNN>` **no aplica** (no hay sesión); el mensaje sugerido lo omite.
- Mensaje sigue siendo 1 línea, descriptivo, sin co-author/firma/`--no-verify`.
- **Sí hay propose-then-execute automático**: el AI llama `agent-workflow sources` (sin `--session`) y dispara M1 igual que en closure. Es el mismo prompt, con tag omitido del mensaje sugerido.
- Workspace no qtc-* (sin `AW-PROJECT`): no hay `sources` disponible. El AI sugiere 1-line msg en chat, espera confirmación, ejecuta. M1 no se invoca en ese contexto.

---

### 2. Sandbox plan-mode — `agent-workflow:sandbox-readonly`

**Canon**: `agent-workflow/skills/session/references/sandbox-readonly-rules.md`.

Resumen:
- Canon universal qtc-*. Cubre Claude Code (plan mode), Codex (sandbox read-only), Copilot (read-only), Warp y cualquier harness equivalente.
- Se activa por system-reminder del host (`Plan mode is active`, `EnterPlanMode`, sandbox read-only flag, etc.).
- En plan mode: el AI **describe en el plan file** qué haría en lugar de ejecutarlo. No crea/edita archivos, no ejecuta git/npm/SQL mutante.

Reglas operativas:
- Bloquea: `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, `Bash` con efectos colaterales, `git push`, `gh pr create`, `npm publish`, SQL no idempotente.
- Permite: `Read`, `Grep`, queries CLI read-only (`sessions`, `*-data`, `checkpoint-read`).
- Matriz por subcomando CLI: ver §"Plan-mode-safe vs NO seguros" en el canon.

**Cómo aplicar fuera de sesión**:
- Aplica igual — el disparador es el system-reminder del host, no el lifecycle qtc-*.
- Si la skill se carga fuera de sesión y el host está en plan mode, **describir el output en el plan file** sin ejecutar.

---

### 3. MCP `<mcp-cert>` / `<mcp-prod>` read-only — `agent-workflow:mcp-readonly`

**Canon**: `agent-workflow/docs/shared-contract/plugins.md` §30 (Política BD universal v5.5+).

Resumen:
- MCPs `<mcp-cert>` y `<mcp-prod>` son **read-only por contrato**. Permitido: `SELECT`, `EXPLAIN`, `\d`, `\df`, `\dt`. Prohibido: `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/`MERGE`/`CREATE`/`ALTER`/`DROP`/`GRANT`/`REVOKE`/`COPY`.
- Mutaciones se materializan como script SQL versionado en `docs/scripts/<bundle>/` o staging de sesión. El usuario ejecuta el script manualmente; el AI nunca lo aplica.
- Excepción única: usuario explícitamente delega ejecución por bloque ("ejecutalo vos contra cert"). Confirmación por cada bloque, limitar al destino mencionado, re-aplicar regla por default en la siguiente tarea.

Reglas operativas (defensa en profundidad):
- **Capa 1 (server-side)**: el CLI inyecta `READONLY=true` en `.mcp.json` (`agent-workflow-cli/src/domain/mcp-entry.ts:99`). El servidor `dbhub` rechaza DML/DDL a nivel TCP.
- **Capa 2 (PreToolUse hook)**: `agent-workflow hook sql-mutation-guard` registrado en `hooks/hooks.json` con matcher `mcp__.*__execute_sql` — bloquea con exit 2 + mensaje si detecta keywords mutantes.
- **Capa 3 (convención)**: 22 skills repiten la regla en lenguaje natural; memoria del usuario refuerza.
- Bypass: `AW_SQL_GUARD=off` (desactiva guard), `AW_SQL_GUARD_ALLOW=cert` (permite sólo cert, no prod).

**Cómo aplicar fuera de sesión**:
- Capas 1 y 2 siguen activas (server READONLY + hook PreToolUse wired) aunque no haya sesión.
- Si el AI necesita mutar BD: producir script en `docs/scripts/` (o staging temporal) y pedir al usuario que lo aplique — nunca ejecutar mutación vía MCP.

---

### 4. Redacción simple — `agent-workflow:redaccion-simple`

**Canon**: `agent-workflow/skills/redaccion-simple/SKILL.md`.

Resumen:
- Guía universal de estilo para toda prosa que produzca el AI en contexto qtc-*: artefactos `.md` de sesión, commit messages, descripciones de PR, READMEs ad-hoc, respuestas en chat sobre runtime/skills qtc-*.
- 6 reglas: frases cortas (≤15 palabras), listas sobre prosa, una idea por línea, "qué + por qué" en una línea, sin jerga inventada, sin relleno ("es importante notar…", "cabe destacar…").

Reglas operativas por artefacto:
- **OBJECTIVE**: `## Context` arranca con "Lo que NO está en la pregunta".
- **TASKS**: prohibido código inline.
- **DECISIONS**: si una DEC es obvia, no se registra.
- **EVIDENCE**: cada hallazgo 4-8 líneas.
- **CONCLUSIONS**: cada `**CN**` con link a evidencia; cada `**RN**` con responsable + cuándo.

**Cómo aplicar fuera de sesión**:
- Aplica igual a commit messages, descripciones de PR, READMEs, respuestas en chat. No requiere sesión activa.

---

### 5. Coding standards — `agent-workflow:coding-standards`

**Canon**: `agent-workflow/skills/coding-standards/SKILL.md`.

Resumen:
- Estándares de código por stack (Java/Spring, Angular/TypeScript, Node). Principios: SOLID, fail-fast, naming descriptivo, DRY contra `shared/`/`common/`.
- Seguridad: sin secrets en código, sin logear datos sensibles, SQL parametrizado, MCP `<mcp-cert>`/`<mcp-prod>` READONLY.
- FE-BE R1-R6: Sparse DTO unificado, PATCH semantics para edit, FE envía sólo cambios, sin fallbacks ocultos, Bean Validation con groups, DB stub-first.

Reglas operativas:
- Java/Spring: Constructor Injection, `@Transactional(readOnly=true)` por default, records + Jakarta Validation.
- Angular: Constructor injection, NgModules, async pipe, sin `any`.
- HTTP: prohibido `catchError(() => of([]))` — propagar el error.
- Logging por nivel: ERROR (rompe flujo) / WARN (degrada) / INFO (transacción) / DEBUG (interno).
- Ramas: `feature/` `fix/` `hotfix/` + kebab.

**Cómo aplicar fuera de sesión**:
- Aplican igual a cualquier edit de código qtc-* o consumer. Sin sesión, la composición desde `dev-workflow`/`implement` no ocurre — depende de que el harness host enganche `coding-standards` por description engaging o de que `agent-workflow:rules` se invoque.

---

### 6. Graduación 6-kinds — `agent-workflow:graduacion-routing`

**Canon**: `agent-workflow/skills/session/references/graduacion-routing.md` (DEC-002, DEC-003).

Resumen:
- Sólo **6 kinds** graduan al cerrar sesión: `decision`, `manual`, `script`, `especificacion`, `conclusion`, `release`. El resto vive en la sesión.
- Routing absoluto sin prompt por sesión:
  - `workspace_mode=hub` → `<hub>/docs/<categoria>/`.
  - `workspace_mode=project` → `<project>/docs/<categoria>/`.
- Comando CLI: `agent-workflow graduate --kind <K> --session <CODE> --slug <kebab>`. `script` y `release` se manejan vía `/agent-workflow:release` exclusivamente.

Reglas operativas:
- `decision` → `docs/decisiones/NNN-<slug>.md`.
- `manual` → `docs/manuales/NNN-<slug>.md`.
- `especificacion` → `docs/especificaciones/NNN-<slug>/`.
- `conclusion` → `docs/conclusiones/NNN-<slug>.md` (opt-in; default = no graduar).
- `release` → `docs/release/NNN-informe-release.md` (vía `/agent-workflow:release`).
- `script` → `docs/scripts/NNN-sessionXXX-<slug>/` (vía `/agent-workflow:release`).

**Cómo aplicar fuera de sesión**:
- El CLI **rechaza** la invocación sin `--session` y `--slug`. Un artefacto graduable producido fuera de sesión queda huérfano.
- Workaround: crear sesión retroactiva o mover archivos manualmente — no documentado como flujo canónico.

---

### 7. Branch verification — `agent-workflow:branch-verification`

**Canon**: `agent-workflow/skills/session/references/branch-verification.md`.

Resumen:
- Gate de avance del lifecycle: en crear sesión, retomar y entrada a execution se valida `current_branch == expected_work_branch` por fuente.
- 3 casos:
  - **Caso A** (`match=false`, `dirty=false`): `AskUserQuestion` → checkout esperado / mantener current y actualizar sesión / cancelar.
  - **Caso B** (`match=false`, `dirty=true`): pausar y esperar resolución manual. Listar archivos modificados. **NO ofrecer checkout**.
  - **Caso C** (analyze session editando código): preguntar nombre de rama, ofrecer `checkout` o `checkout -b` desde `main_branch`, registrar vía `project-md-upsert --update-phase`.
- Hard gate cross-fuente: si `cross_source_consistent=false` (hub mode con divergencia), bloquear hasta alinear o declarar divergencia explícita.

Reglas operativas:
- Hook PreToolUse `agent-workflow hook branch-check` registrado en `hooks/hooks.json` con matcher `Edit|Write|MultiEdit|NotebookEdit`.
- Sin sesión activa pero con `working_branches` en AW-PROJECT.Status: el hook resuelve `expected_work_branch` desde working_branches y sí dispara.
- Sin sesión y sin `working_branches`: degrada a no-op silencioso.

**Cómo aplicar fuera de sesión**:
- En hubs con `working_branches` declaradas (como `agent-workflow-last`): hook activo, gate funciona.
- En workspaces project sin sesión: gate inactivo. El AI debe verificar rama manualmente con `agent-workflow sources` si el contexto lo amerita.
- Nunca ejecutar `git stash`, `git reset --hard`, `git restore .`, `git clean` sin confirmación explícita del usuario para esa fuente.

---

## Relación con AGENTS.md/CLAUDE.md por fuente

Esta skill es la capa **active (on-demand)** del modelo de aplicación de reglas. Coexiste con la capa **passive (system-prompt)**:

| Capa | Mecanismo | Cuándo carga | Cubre |
|---|---|---|---|
| Passive | `AGENTS.md`/`CLAUDE.md` por fuente + bloque transversal en hub | system-prompt automático en cada conversación sobre el repo | "el AI ve los anchors siempre que abre el repo" |
| Active | `Skill(agent-workflow:rules)` invokable + description engaging | on-demand vía invocación explícita o NL match | "el AI carga los anchors completos cuando los necesita" |

Las 2 capas no se solapan:
- El AGENTS.md tiene punteros breves a anchors (1 línea por anchor) — load automático.
- `agent-workflow:rules` expande los anchors completos (5-7 líneas + reglas operativas + cómo aplicar fuera de sesión) — carga on-demand.

Si el AGENTS.md ya está cargado, `agent-workflow:rules` actúa como **refresh verbose** del contrato.

## Cómo aplicar fuera de sesión (resumen cross-anchor)

Tabla rápida para situaciones comunes sin sesión activa:

| Situación | Regla aplicable | Acción |
|---|---|---|
| Pedís un commit ad-hoc | commits-policy regla 2 + regla 3 universal | M1 propose-then-execute con `agent-workflow sources` (sin `--session`). Mensaje sugerido sin tag `session<NNN>`, sin co-author, sin `--no-verify`. |
| Pedís commit con mensaje literal en la solicitud | commits-policy regla 5 | Bypass de M1; el AI ejecuta `git commit -m "<literal>"` directo (validando rama, hooks, Regla 2). |
| Editás código de fuente qtc-* | coding-standards + branch-verification | Verificar rama (`agent-workflow sources`); aplicar reglas de stack. |
| Ejecutás query MCP cert/prod | mcp-readonly | Sólo SELECT/EXPLAIN. Mutación → script en `docs/scripts/`. |
| Escribís prosa qtc-* (PR description, README) | redaccion-simple | 6 reglas (frases cortas, listas, sin jerga). |
| Producís artefacto curable (decisión, manual) | graduacion-routing | Crear sesión retroactiva o documentar como fuera de scope graduable. |
| Host en plan mode | sandbox-readonly | Describir en plan file, no ejecutar mutaciones. |

## Sandbox read-only

Canon universal en `../session/references/sandbox-readonly-rules.md`. Esta skill es read-only por diseño — carga reglas, no ejecuta ni edita nada.

En plan mode: describir en el plan file qué anchors se cargarían y para qué se invoca la skill (situación concreta). NO ejecuta `Write`, `Edit`, `MultiEdit`, `Bash` con efectos colaterales ni queries MCP mutantes.

Compatible con plan mode sin restricciones adicionales.

## Referencias

- **session SKILL** (`../session/SKILL.md`) — lifecycle universal donde estas reglas se invocan por composición durante las 4 fases.
- **shared-contract** (`../../docs/shared-contract.md`) — contrato cross-plugin de la familia qtc-*.
- **Recomendación de uso conjunto con AGENTS.md/CLAUDE.md**:
  - El AGENTS.md/CLAUDE.md por fuente (o el bloque transversal en hub) lista 1 línea por anchor con su path canon. Sirve como "tabla de contenidos" siempre cargada.
  - Esta skill `agent-workflow:rules` carga los 7 anchors expandidos. Sirve cuando se necesita refrescar el contrato o cuando el AGENTS.md no está disponible.
- **Origen**: session051-analyze-reglas-transversales-fuera-sesion → CONCLUSIONS C7/R7/QW6. Graduado a `docs/conclusiones/006-reglas-transversales-fuera-sesion.md`.
