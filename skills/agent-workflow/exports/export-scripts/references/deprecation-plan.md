# Plan de deprecación — `release` + `release-scripts` → `export-scripts`

Plan canónico definido en Propuesta 007 R2 y materializado en session061.

## Estado (plugin v2.8.0 — Fase 1)

### `release` v2.0.0 → v2.0.1

- **SKILL.md**: banner deprecation en la primera línea del body.
- **commands/release.md**: banner equivalente.
- Comportamiento: **idéntico al v2.0.0**. Output sigue siendo `docs/release/NNN-informe-release.md` + `docs/scripts/NNN-sessionXXX-<slug>/`.
- Invocaciones automatizadas (CI, makefiles, scripts internos) NO se rompen.

### `release-scripts` v2.0.0 → v2.0.1

- Mismo tratamiento: banner pasivo, comportamiento sin cambios.
- Output sigue siendo `docs/release/NNN-release-*/scripts-por-tema/`.

### Banner canónico (texto literal)

```markdown
> ⚠️ **DEPRECATED desde plugin v2.8.0**: usar `/agent-workflow:export-scripts` (refactor que consolida release + release-scripts en un único output dir). Este comando se mantiene por compatibilidad; remoción prevista en plugin v3.0.0. Detalles: `docs/conclusiones/007-export-commands-family.md` §R2.
```

## Estado (plugin v3.0.0 — Fase 2 — futuro)

**Sin compromiso de fecha**. Disparadores que activarían Fase 2:

1. Telemetría / encuesta confirma que ≥80% de workspaces migraron a `/agent-workflow:export-scripts`.
2. Ningún PR en los últimos 3 meses depende de output legacy (`docs/release/`).
3. Equipo runtime confirma que el plan deprecation Fase 1 cubrió todos los edge cases.

Cuando se active:
- Remover `skills/release/` y `commands/release.md`.
- Remover `skills/release-scripts/` y `commands/release-scripts.md`.
- Decisión sobre `docs/release/` legacy en cada workspace: **NO** se migra. Queda como histórico fijo (workspaces de producto los preservan; el AI los lee si el usuario pregunta).
- Bump plugin a v3.0.0 (BREAKING).

## Compatibilidad cross-skill

### Skills/refs que aún apuntan a `release` o `release-scripts`

Lista a verificar al cerrar Fase 1:

| Skill / archivo | Referencia | Acción Fase 1 | Acción Fase 2 |
|---|---|---|---|
| `agent-workflow:session/SKILL.md` §"Cerrar sesión" tabla de kinds | `/agent-workflow:release` como único disparador de kind `script` y `release` | Mantener — `release` legacy sigue funcionando | Reemplazar por `/agent-workflow:export-scripts` |
| `agent-workflow:dev-workflow/SKILL.md` | Referencia release como punto de entrada | Mantener | Actualizar |
| `agent-workflow:release/SKILL.md` | Banner deprecation | Banner agregado | Skill removido |
| `agent-workflow:release-scripts/SKILL.md` | Banner deprecation | Banner agregado | Skill removido |
| `qtc-plugins-marketplace/.claude-plugin/marketplace.json` | Descripción del plugin | v2.8.0 con texto nuevo + deprecation note | v3.0.0 sin mención de release legacy |
| `agent-workflow/README.md` | Header de versión | v2.8.0 + 13 commands | v3.0.0 + 11 commands |

### Reusos cross-skill durante Fase 1

`export-scripts` referencia (no porta) algunos archivos de release/release-scripts:

| Skill | Archivo referenciado | Por qué reference y no port |
|---|---|---|
| `release` | `references/manual-actions-catalog.md` | Contenido invariante (matriz acción↔condición). Deduplicar. |

Cuando Fase 2 remueva `release`/`release-scripts`: este archivo se **colapsa** al port (mover a `export-scripts/references/manual-actions-catalog.md`). Es parte del checklist de Fase 2.

## Comunicación a usuarios

Al cargar `release` o `release-scripts` legacy (v2.0.1):

```
> ⚠️  Comando deprecated desde plugin v2.8.0
> Migrar a: /agent-workflow:export-scripts
> Detalles: docs/conclusiones/007-export-commands-family.md §R2
```

El banner se imprime una vez por sesión (no spammea). El skill continúa ejecutando normalmente.

## Decisiones de no-acción

- **NO** redirigir `/agent-workflow:release` a `/agent-workflow:export-scripts` internamente. El refactor no es semánticamente idéntico (output dir + estructura cambian). Un redirect silencioso confundiría a workspaces con CI que asume `docs/release/`.
- **NO** migrar `docs/release/` histórico de workspaces de producto. Cada workspace lo decide cuando active export-scripts.
- **NO** crear `--legacy-output` flag en export-scripts. Romper la simetría del patrón export-* por compat sería deuda futura.
