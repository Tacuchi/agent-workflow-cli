# Sandbox read-only — reglas universales (agent-workflow)

> Canon universal de la familia agent-workflow. Cubre Claude Code "Plan mode", Codex sandbox read-only, Copilot read-only, y cualquier harness equivalente. Los flow plugins referencian esta versión y mantienen una copia local sólo si necesitan reglas adicionales propias.

Cuando el sistema indica que el AI está en sandbox read-only (Claude Code: system-reminder con `Plan mode is active` o `EnterPlanMode`; Codex: sandbox read-only; otros: harness con write disabled):

- **NO** crear, editar ni mover archivos del proyecto. Incluye explícitamente:
  - `.workflow/**` (sesiones, HISTORY, CHECKPOINT.md, OBJECTIVE.md, TASKS.md, etc.)
  - `docs/**` (decisiones, manuales, scripts, especificaciones, conclusiones, release)
  - `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` (cualquier AW-PROJECT block)
  - Cualquier archivo del repo de la fuente (código, configs, tests)
- **NO** ejecutar comandos que muten estado externo:
  - SQL no idempotente, scripts de migración, `git push`, `gh pr create`, `npm publish`
  - Servicios MCP que escriben (los `<mcp-cert>` y `<mcp-prod>` MCP son read-only por contrato; pero ojo con queries con efectos)
- **SÍ** leer artefactos existentes para obtener contexto (read-only):
  - `.workflow/HISTORY.md`, `OBJECTIVE.md`, `TASKS.md`, `DECISIONS.md`, `CHECKPOINT.md`
  - Source code via Read/Grep/Glob
  - Output de `agent-workflow` sub-comandos read-only (`project-md-upsert --read`, `sessions`, `checkpoint-read`, `resume-summary`, `auto-plan-decide`, `topic-change-check`, `specialty-choose`)
- **SÍ** escribir el output al plan file indicado por el runtime (es la única escritura permitida).
- Las acciones se **describen** como plan en lugar de ejecutarse.
- Aplica igual para Codex cuando opere en plan mode (sandbox read-only).

## Qué debe escribir cada skill/command en el plan file

Cada skill o command que aparece en este modo reduce su bloque inline a:

1. Una referencia a este archivo (una línea).
2. La lista **específica** de archivos/artefactos que crearía o modificaría al aceptar el plan, con rutas absolutas o relativas al cwd y contenido resumido (no completo).

Ejemplo de bloque inline mínimo dentro de la SKILL.md:

```markdown
## Sandbox read-only

Reglas en `references/sandbox-readonly-rules.md` (universal, agent-workflow).
Esta skill, al activarse en plan mode, describe en el plan file:

- `.workflow/sessions/<folder>/CHECKPOINT.md` — nuevo, ~80 líneas, formato §17 shared-contract.
- `.workflow/sessions/<folder>/TASKS.md` — agregar 2 items: "Verificar rama X", "Implementar Y".

NO ejecuta `agent-workflow checkpoint-write` ni Edit/Write tools.
```

## Anti-patrones

| Anti-patrón | Por qué falla | Reemplazo |
|---|---|---|
| Skill ejecuta `agent-workflow session-create --flow <flow>` en plan mode | Crea carpeta + escribe OBJECTIVE.md | Describir: "crearía `.workflow/sessions/sessionNNN-<flow>-<slug>/` con `OBJECTIVE.md` (~30 líneas)" |
| Skill llama `Edit` para tachar items de TASKS.md | Mutación de estado | Describir: "marcaría items 1-3 como completos" |
| Skill ejecuta `git checkout` para verificar rama | Mutación de estado del worktree | Describir: "verificaría rama `feature/sessionNNN` con `git branch --show-current` (read-only)" |
| Skill auto-invoca `frontend-design` cross-plugin | Auto-routing + ejecución implícita | Describir: "sugeriría invocar `agent-workflow:frontend-design` (post-Fase C; legacy `qtc-design:frontend-design`) para patrón X" |
| Skill escribe a STDOUT con `out({...})` que tiene side-effects (ej. flush en logs) | Escritura indirecta | Sólo si la skill ya estaba diseñada para read-only output JSON; si no, describir |

## Reglas para sub-comandos `agent-workflow` (CLI)

| Sub-comando | ¿Plan-mode safe? | Notas |
|---|---|---|
| `sessions` | SÍ | Sólo lee `.workflow/sessions/`. |
| `project-md-upsert --read` | SÍ | Read-only. |
| `project-md-upsert --add-session/--remove-session/--update-phase` | NO | Mutaciones a CLAUDE.md. |
| `next-number <dir>` | SÍ | Lee dir, no escribe. |
| `profiles` | SÍ | Lee user-config.md. |
| `history-data` | SÍ | Read-only. |
| `history-update` | NO | Escribe HISTORY.md. |
| `session-create` | NO | Crea carpeta + archivos. |
| `session-resume` | SÍ | Read-only (sólo agrega counters al output). |
| `session-close` | NO | Modifica AW-PROJECT + HISTORY. |
| `checkpoint-write` | NO | Escribe CHECKPOINT.md. (`--force` o no, igual escribe.) |
| `checkpoint-read` | SÍ | Read-only. |
| `resume-summary` | SÍ | Read-only. |
| `auto-compact-on-close` | NO | Escribe múltiples CHECKPOINTs. |
| `topic-change-check` | SÍ | Heurística pura, sin IO. |
| `specialty-choose` | SÍ | Heurística pura, sin IO. |
| `auto-plan-decide` | SÍ | Heurística pura, sin IO. |
| `plugin-doctor` | SÍ | Sólo lectura (en v4.x; si en futuro escribe diagnostics, revisar). |

Plugins flow agregan su propia matriz para sub-comandos dev-only (`stack`, `sources`, `check-branch`, `graduate`, `phase-next`, `phase-detect`).

## Referencias

- `shared-contract.md` §12 — `agent-workflow` CLI API estable (incluye qué sub-comandos son base vs override).
- Plan v2.x §A3 — endurecimiento de Plan mode en SKILL.md.
