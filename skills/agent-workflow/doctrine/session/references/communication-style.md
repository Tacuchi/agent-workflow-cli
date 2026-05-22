# Communication style — confirm before mutate

> Anchor `agent-workflow:communication-style`. Regla de interacción para skills que producen **artefactos consolidados** (release bundle SQL, release-scripts thematic bundle, project-init full overwrite).

## La regla

**Confirmar antes de mutar archivos consolidados.** Cuando una skill va a generar un artefacto que junta/sobrescribe el trabajo de N sesiones (no un edit puntual), pregunta al usuario antes de escribir.

## Cuándo aplica

| Skill | Artefacto a generar | Confirmar antes |
|---|---|---|
| `release` | `docs/releases/NNN-<slug>/REPORT.md` + bundle SQL | Sí |
| `release-scripts` | `docs/releases/NNN-<slug>/scripts-by-theme/` | Sí |
| `project-init --force` | Sobrescribir bloque AW-PROJECT existente | Sí |
| `migrate --apply` | Renombrar `.claude/sessions/` → `.workflow/sessions/` | Sí |
| `hub-init --apply` | Cambiar `Mode: project` → `Mode: hub` | Sí |

## Cuándo NO aplica

- Edits puntuales a un archivo (skills `implement`, `refactor`, `design-deliver`, etc.).
- Read-only operations (`/agent-workflow:doctor`, `aw sessions`, `aw checkpoint-read`).
- `--dry-run` flags — la skill solo describe lo que haría, sin escribir.

## Forma del prompt

```
Voy a generar:
- <artefacto 1>: <ruta>
- <artefacto 2>: <ruta>

Esto sobrescribe/crea N archivos. ¿Procedo?
- Sí, generar
- Solo dry-run (mostrá qué haría sin escribir)
- Cancelar
```

## Si el usuario declina

- **Solo dry-run**: la skill imprime el contenido que generaría y deja referencias a artefactos previos (no escribe).
- **Cancelar**: skill aborta, no produce side effects.

## Composición con sandbox-readonly

Cuando la skill se invoca en plan mode (sandbox read-only), este prompt no se dispara — el plan describe lo que escribiría y queda en read-only. La confirmación viene implícita al aprobar el plan.

## Refs

- `sandbox-readonly-rules.md` — reglas universales de plan mode.
- `prompts-catalog.md` (S5/M*) — otros prompts del lifecycle.
