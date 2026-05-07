# Manual técnico — agent-workflow

Manual de implementación y mantenimiento del workflow universal.

Audiencia: developers que mantienen, extienden o integran el CLI `@tacuchi/agent-workflow-cli` y el skill `agent-workflow` que viaja bundled adentro.

Esta es documentación del **workflow universal**, no de los plugins downstream (qtc-* o cualquier otro).

## 1. Arquitectura

```
┌────────────────────────────────────────────────────────────┐
│ Host harness (Claude Code, Codex, Gemini CLI, etc.)        │
└──────────────────┬─────────────────────────────────────────┘
                   │ tool calls / hooks
                   ▼
┌────────────────────────────────────────────────────────────┐
│ Skill: agent-workflow (universal, AI-facing, bundled)      │
│   SKILL.md + 11 references/                                │
│   Enseña al modelo cuándo y cómo invocar el CLI.           │
└──────────────────┬─────────────────────────────────────────┘
                   │ shell exec
                   ▼
┌────────────────────────────────────────────────────────────┐
│ CLI: @tacuchi/agent-workflow-cli (Node 20+, ESM, npm)      │
│   bin: agent-workflow / aw                                 │
│   43 subcomandos en 11 familias.                           │
└──────────────────┬─────────────────────────────────────────┘
                   │ filesystem + git
                   ▼
┌────────────────────────────────────────────────────────────┐
│ Workspace                                                  │
│   .<ns>/sessions/sessionNNN-<flow>-<slug>/                 │
│   .<ns>/HISTORY.md                                         │
│   CLAUDE.md / AGENTS.md (con bloque <NS>-PROJECT)          │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│ Plugin downstream (opcional, ej. qtc-core/dev/design/...)  │
│   Solo skills de negocio + hooks que invocan al CLI.       │
│   NO duplica lógica del workflow universal.                │
└────────────────────────────────────────────────────────────┘
```

Componentes:

| Componente | Propósito | Lenguaje | Repo |
|---|---|---|---|
| CLI `agent-workflow` (paquete `@tacuchi/agent-workflow-cli`) | runtime ejecutable del workflow | TypeScript (ESM, Node 20+) | github.com/Tacuchi/agent-workflow-cli |
| Skill `agent-workflow` | manual AI-facing del CLI (bundled en el tarball) | Markdown (frontmatter Anthropic Skill) | bundled en `skills/agent-workflow/` del CLI |
| Plugin downstream | superficie específica de dominio | Markdown + JSON manifests | (cada empresa / dominio) |

## 2. Contratos

### 2.1 Lifecycle (4 fases)

```
planning → execution → validation → closure
   ↑           ↓
   └───────────┘  (topic-change puede reiniciar)
```

| Fase | Driver del CLI | Artefactos esperados |
|---|---|---|
| planning | `auto-plan-decide`, `specialty-choose`, `objetivo-data`, `tasks-data` | `OBJETIVO.md`, `TASKS.md` |
| execution | el modelo + skills downstream | `DECISIONES.md`, scripts/, `EVIDENCIA.md`, `HALLAZGOS.md` (si aplica) |
| validation | `tasks-data --only-open`, criterios releídos | logs, marcado en TASKS |
| closure | `graduate`, `session-close`, `auto-compact-on-close` | `CHECKPOINT.md`, fila cerrada en `HISTORY.md`, artefactos graduados a `docs/` |

`phase-detect` y `phase-next` permiten al modelo y al harness consultar/avanzar fase.

### 2.2 Artefactos

**Principales (universales, garantizados por el CLI)**:

- `OBJETIVO.md`: brief + criterios de aceptación. Reader: `objetivo-data`.
- `TASKS.md`: descomposición accionable. Reader: `tasks-data`.
- `DECISIONES.md`: registro de decisiones no obvias. Reader: `decisiones-list`.
- `CHECKPOINT.md`: estado pre-compact. Reader: `checkpoint-read`. Writer: `checkpoint-write`.
- `HISTORY.md`: índice de sesiones. Reader: `history-data`. Writer: `history-update`.

**Convencionales (del plugin downstream)**:

- `EVIDENCIA.md`, `HALLAZGOS.md`, `RECOMENDACION.md` — convención del flow `analyze` (qtc-analyze).
- `DISCOVERY.md`, `PROBLEMA.md`, `IDEAS.md`, `ENTREGA.md` — convención del flow `design` (qtc-design).
- `DEPENDENCIAS.md` — convención cross-flow. Reader: `dependencias-list`.

El CLI los trata como markdown free-form (no parsea estructura). El plugin downstream define el shape.

### 2.3 Output JSON contractual

Todo subcomando devuelve JSON en stdout, exit 0 success / no-cero error con envelope:

```json
{ "error": { "code": "NOT_IN_WORKSPACE", "message": "...", "details": {} } }
```

Hooks (`hook branch-check`, `hook sql-mutation-guard`) usan exit 0 (allow) / 2 (block) además del JSON.

## 3. Surface del CLI (43 subcomandos en 11 familias)

| Familia | Comandos |
|---|---|
| session-mgmt | `sessions`, `session-create`, `session-resume`, `session-close`, `session-artifacts` |
| objetivo-tasks | `objetivo-data`, `tasks-data`, `decisiones-list`, `dependencias-list` |
| history | `history-data`, `history-update` |
| checkpoint | `checkpoint-read`, `checkpoint-write`, `compress-checkpoint`, `resume-summary`, `auto-compact-on-close` |
| sources | `sources`, `check-branch`, `workspace-mode`, `project-md-upsert`, `upgrade-hub-mode`, `attach-multiroot`, `detach-multiroot` |
| orchestration | `auto-plan-decide`, `topic-change-check`, `specialty-choose`, `phase-detect`, `phase-next`, `stack`, `workflows`, `skill-index` |
| doctor | `plugin-doctor`, `code-scan`, `release-data`, `graduate` |
| hooks | `hook branch-check`, `hook sql-mutation-guard` |
| mcp | `mcp dbhub`, `bootstrap-dsn` |
| dev-only | `harness`, `profiles`, `logs`, `next-number` |
| self | `self namespace`, `self doctor`, `self update`, `self install-skill` |

Detalle por familia: ver `references/<familia>.md` en este mismo skill.

## 4. Hooks

Eventos del host harness que disparan al CLI:

| Evento | Subcomando | Propósito |
|---|---|---|
| SessionStart | (cualquiera, ej. `printf "<ns>" > ~/.config/agent-workflow/namespace`) | Setear namespace activo. |
| PreToolUse (Edit/Write/MultiEdit/NotebookEdit) | `hook branch-check` | Bloquear edits si la rama no coincide con la sesión. |
| PreToolUse (MCP execute_sql) | `hook sql-mutation-guard` | Bloquear DML/DDL en MCPs read-only. |
| PreCompact | `checkpoint-write` | Persistir estado antes de liberar contexto. |
| PostCompact | `resume-summary` o `project-md-upsert --read` | Recuperar bloque project tras compact. |
| SessionEnd | `auto-compact-on-close` | Cierre proactivo. |

Stdin/stdout siguen el contrato del harness (Anthropic Claude Code, Codex CLI, etc.). Cada hook es una invocación independiente del proceso `agent-workflow`.

## 5. Namespace resolver (4 niveles)

Precedencia de mayor a menor:

1. Flag `--namespace <name>` (per-call).
2. Env vars `AW_NAMESPACE` o `AGENT_WORKFLOW_NAMESPACE`.
3. (v1.2.0+) Workspace local: bloque `<NS>-PROJECT` detectado en `CLAUDE.md` / `AGENTS.md` del directorio actual.
4. User config: `~/.config/agent-workflow/namespace`.
5. Default literal: `agent-workflow`.

El namespace controla:

- Carpeta de sesiones: `.<ns>/sessions/`.
- Bloque project: `<NS>-PROJECT` en CLAUDE.md / AGENTS.md.
- User root: `~/.<ns>/`.

Comandos relacionados:

```bash
agent-workflow self namespace               # ver el resuelto y su fuente
agent-workflow self doctor                  # ver el árbol completo
```

## 6. MCP integration

El CLI puede actuar como wrapper de MCP servers:

```bash
agent-workflow mcp dbhub <instance>         # spawn @bytebase/dbhub vía npx
agent-workflow bootstrap-dsn --dsn-cert ... # persistir DSN sin exponer
```

El plugin downstream registra el wrapper en su `.mcp.json`:

```json
{
  "<server-name>": {
    "command": "agent-workflow",
    "args": ["mcp", "dbhub", "cert"]
  }
}
```

Razón: el CLI consolida resolución de namespace + DSN persistido + envoltorio del binario externo.

## 7. Extensibilidad

### 7.1 Nuevo plugin downstream

1. Crear repo del plugin con manifests `.claude-plugin/plugin.json` y/o `.codex-plugin/plugin.json`.
2. Hook `SessionStart` que setea el namespace deseado:
   ```sh
   printf "%s\n" "miempresa" > "${HOME}/.config/agent-workflow/namespace"
   ```
3. Skills propias en `skills/<nombre>/SKILL.md` — solo lógica de negocio. NO re-implementar lifecycle, parsing de artefactos, gestión de sesiones (eso lo hace el CLI).
4. Hooks adicionales (`PreToolUse`, etc.) que invocan `agent-workflow ...` con el namespace ya en `~/.config/...`.
5. Documentar en CLAUDE.md/AGENTS.md del workspace cliente cómo se compone con el skill universal `agent-workflow`.

### 7.2 Nuevo subcomando del CLI

Pipeline en `/Users/tacuchi/Git/agent-workflow-cli`:

1. Definir contrato JSON en `src/application/<command>/Service.ts`.
2. Adapter Node en `src/adapters/<command>/`.
3. CLI binding en `src/cli/<command>Command.ts` con `commander`.
4. Tests unit en `tests/unit/<command>.test.ts` (vitest).
5. Si tiene side-effects de filesystem: golden fixture en `tests/fixtures/golden-write/<command>-XX/` + golden test en `tests/golden/`.
6. Bump en `package.json` + entry en `CHANGELOG.md`.
7. Update del skill: agregar entry en la reference correspondiente o crear nueva.
8. Bump del skill `agent-workflow` (frontmatter `version`) si la reference cambió. La skill viaja bundled en `skills/agent-workflow/` del repo del CLI.

### 7.3 Nuevo flow del workflow

Concepto: un flow define la composición de skills durante el lifecycle de una sesión (ej. `dev`, `design`, `analyze`).

1. Crear plugin downstream con `skills/<flow>-workflow/SKILL.md`.
2. Registrar el workflow vía CLI ya cubre la búsqueda con `workflows` (lectura de los plugins instalados).
3. La forma del payload registrado se expone vía `agent-workflow workflows --flow <name>`: `session_args`, `artifacts_by_phase`, `skills_by_phase`, `refs_format`, `resume_counters`.
4. El skill `agent-workflow` no necesita cambios — el flow es dato runtime que el modelo descubre vía `workflows`.

## 8. Versioning + release

CLI:
- semver estricto en `package.json`.
- `CHANGELOG.md` con cada release.
- `agent-workflow self update` reporta delta vs. npm registry.
- `agent-workflow self doctor` reporta versión instalada + skill instalado.

Skill:
- `version` en frontmatter de `SKILL.md`.
- Bump cuando una reference cambia o cuando el CLI agrega/cambia comandos.
- Política: el skill es "alineable" con la mayor versión del CLI que documenta. No es necesario que matchee 1:1.

Plugins downstream:
- Cada uno tiene su propia cadencia. Pueden declarar dependencia de versión mínima del CLI o del skill (vía CLAUDE.md, README o manifest custom).

## 9. Decisiones registradas

Las decisiones técnicas que dieron forma a la arquitectura están en los repos respectivos:

- Migración Python → TypeScript: RFC 004 en core-workflow-plugin (sesiones 022..032).
- CLI agnóstico: spec `agent-workflow-agnostic-design` (session034).
- Skill repo separado: spec sub-proyecto 2 (session035).
- Plugins namespace propagation: sub-proyecto 3 (session036).
- Conformance final: sesión 037 — este manual.

## 10. Operación

### 10.1 Diagnóstico básico

```bash
agent-workflow self doctor
agent-workflow self namespace
agent-workflow workspace-mode
agent-workflow sources
```

### 10.2 Update operativo

```bash
agent-workflow self update                      # check
npm i -g @tacuchi/agent-workflow-cli@latest         # actualizar binario
agent-workflow self install-skill --force       # actualizar skill
```

### 10.3 Errores frecuentes

| Error | Causa probable | Acción |
|---|---|---|
| `NOT_IN_WORKSPACE` | Namespace apunta a tree no existente | `self namespace` para ver el resuelto; setear `--namespace` o env. |
| Mismatch entre `self doctor.cli_version` y `package.json` | Binario global desactualizado | `npm i -g @tacuchi/agent-workflow-cli@latest` |
| Hook `branch-check` bloquea edits inesperadamente | Sesión declara una rama distinta a la actual | `agent-workflow check-branch --source <alias>` para ver expected vs current; checkout o re-declarar. |

## 11. Referencias

- Workflow universal API: `references/<familia>.md` (este skill).
- Quick start funcional: `MANUAL-FUNCIONAL.md` (este skill).
- Test plan de aceptación: `docs/TEST-PLAN.md` (graduado de session037).
- CLI repo: github.com/Tacuchi/agent-workflow-cli (la skill vive bundled adentro del tarball; ya no hay repo standalone).
