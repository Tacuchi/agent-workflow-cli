# Auto-plan rules

> Anchor `agent-workflow:auto-plan-rules`. Disparadores que decide `auto-plan` antes de empezar execution: `skip` (no plan), `lite` (plan inline en TASKS.md sin TodoWrite), `full` (TASKS.md detallado + TodoWrite).

## CLI runtime

```
agent-workflow auto-plan-decide --code <NNN>
```

Devuelve `{ decision: skip|lite|full, reason: <text> }`.

## Heurísticas

### `skip` — sin plan

Aplica cuando:

- Bugfix de 1 línea / cambio trivial de configuración / typo.
- OBJECTIVE.md `## Type: chore` o `## Type: docs` (alias legacy `## Tipo` legible vía parser bilingüe). Estos tipos NO producen `DESIGN.md` ni disparan S7 (skip silencioso).
- Sesión flow=analyze (los analyze tienen su propio shape de plan en EVIDENCE/FINDINGS).
- El usuario declara explícito "vamos directo, sin plan".

### `lite` — plan inline en TASKS.md

Aplica cuando:

- 1-3 archivos a tocar, scope acotado.
- OBJECTIVE.md tiene 1-2 acceptance criteria.
- Bugfix con 1 fase (write test → fix → verify).
- Refactor pequeño que no merece tracking via TodoWrite.

### `full` — TASKS.md detallado + TodoWrite tracking

Aplica cuando:

- ≥4 archivos involucrados.
- OBJECTIVE.md ≥3 acceptance criteria.
- `## Type: feature` o `## Type: refactor` en OBJECTIVE.md (canónico v2.8+; alias legacy `## Tipo` aceptado por parser bilingüe). El modelo phased Phase 0-5 implica plan completo + DESIGN.md + S7 gate antes de Phase 0.
- Multi-phase work (analyze → implement → integrate).
- Cross-source (toca ≥2 fuentes en hub workspace).

## Decisión por flow

| Flow | Default | Override |
|---|---|---|
| dev | `lite` | `full` si `## Type: feature\|refactor` (alias legacy `## Tipo`) o ≥4 archivos |
| design | `lite` | `full` si flow=design Type=system (toca design-system completo) |
| analyze | `skip` | `lite` si modalidad=incident (post-mortem requiere ordering) |

## Override manual

Usuario puede declarar `--plan-mode skip|lite|full` en `aw session-create` o `aw auto-plan-decide`.

## Composición con superpowers

`auto-plan-decide` returning `full` → la skill `agent-workflow:session` invoca también `superpowers:writing-plans` para que el plan de execution tenga la estructura recomendada (review checkpoints, success criteria explícitos).

## Refs

- `references/lifecycle-deep.md` §Composición dinámica de especialidades.
- CLI: `agent-workflow auto-plan-decide --help`.
- `superpowers:writing-plans` — composición al disparar `full`.
