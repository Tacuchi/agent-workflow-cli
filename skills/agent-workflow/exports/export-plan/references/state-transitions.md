# State transitions — `docs/planes/NNN-*.md`

Reglas canónicas de transición de `state` en el frontmatter YAML del plan. Implementa la decisión G3 de `docs/conclusiones/008-roadmap-export-plan-lifecycle.md` (session062).

## Estados

| State | Significado |
|---|---|
| `draft` | Plan creado. Sin sesión vinculada todavía. Editable libremente. |
| `active` | Una o más sesiones lo están ejecutando vía `--from-plan`. |
| `done` | Todas las tasks completadas + sesiones vinculadas cerradas sin items abiertos. |
| `archived` | Reemplazado por nueva versión o cancelado por decisión explícita. |

## Árbol de decisión

```
null ─[export-plan create]─> draft
                                │
                                │ [session-create --from-plan <NNN>] (F-E.3, futuro)
                                ▼
                              active
                                │
                                │ [todas tasks closed Y sesiones vinculadas closed sin opens]
                                ▼
                          AskUserQuestion plan-state
                                ├─ "Marcar done" ──> done
                                ├─ "Mantener active porque queda follow-up" ──> (sin cambio)
                                └─ "Archivar" ──> archived

active|done ─[export-plan re-emit con mismo slug]─> AskUserQuestion plan-state
                                                       ├─ "Archivar el anterior" ──> archived (previo)
                                                       └─ "Cancelar re-emit" ──> (sin cambio)

* ─[solicitud explícita del usuario]─> archived
```

## Transiciones automáticas

### `null → draft`

**Trigger**: `/agent-workflow:export-plan` crea el archivo.

**Sin prompt** — escribir directo y registrar en `state_changes[]`:

```yaml
state_changes:
  - {from: null, to: draft, when: '<ISO>', trigger: 'export-plan create'}
```

### `draft → active`

**Trigger**: `agent-workflow session-create --from-plan <NNN>` (capacidad F-E.3, futuro).

Cuando F-E.3 esté operativo:
- El CLI o el skill `session` lee el frontmatter del plan.
- Si `state == draft`: actualizar a `active` y agregar entry en `state_changes`.
- Si `state == active`: no-op (otra sesión ya lo activó).
- Si `state == done|archived`: prompt al usuario (`AskUserQuestion plan-state` con opciones "Reactivar / Crear plan nuevo / Cancelar").

**Sin prompt en draft→active**: la activación es implícita al usar `--from-plan`.

## Transiciones con `AskUserQuestion plan-state`

### Spec del prompt

Cuando el skill detecta heurística de transición (active→done) pero hay ambigüedad o cuando se re-emite un plan que supersede uno previo:

```
header:  plan-state
question:  ¿Marcar el plan <NNN-slug> como?
options:
  1. Marcar done — todas las tasks cerradas y sesiones vinculadas concluidas.
     (Recomendado si auto-detección retorna 100% clean)
  2. Mantener active — queda follow-up pendiente.
  3. Archivar — superseded o ya no aplica.
multiSelect: false
preview:  (opcional, ASCII con la tabla de tasks abiertas/cerradas)
```

**Other auto** = "Otra acción" → registrar como nota informal en `state_changes.trigger`.

### Heurística para disparar `active → done`

Disparar el prompt cuando:

- `tasks_open == 0` Y `tasks_total > 0` en el plan.
- Para cada sesión en `frontmatter.sessions[]`: la sesión está cerrada en HISTORY (`state == 'closed'`) Y `tasks_data --code <NNN>` retorna `open == 0`.

Si la heurística retorna 100% clean → opción 1 marcada `(Recomendado)`.

Si la heurística detecta sesiones abiertas → opción 2 marcada `(Recomendado)`.

Si el trigger fue "re-emit con mismo slug" → opción 3 marcada `(Recomendado)`.

### Regla absoluta

**Nunca cambiar estado sin confirmación si la heurística no es 100%**. El frontmatter YAML registra cada cambio:

```yaml
state_changes:
  - {from: null, to: draft, when: '2026-05-18T22:00:00Z', trigger: 'export-plan create'}
  - {from: draft, to: active, when: '2026-05-20T10:15:00Z', trigger: 'session-create --from-plan 001'}
  - {from: active, to: done, when: '2026-05-25T18:00:00Z', trigger: 'AskUserQuestion plan-state opción 1'}
```

## Transiciones manuales

### `* → archived` por solicitud explícita

Trigger: el usuario pide explícitamente "archivá el plan NNN" (vía slash command no canónico — por ahora, edición manual del frontmatter).

### `archived → draft` (reapertura)

No soportado por design. Si el usuario quiere reabrir: emitir un plan nuevo con `/agent-workflow:export-plan` y referenciar el archivado en el Resumen.

## Skips

- **Plan mode**: NO transicionar nada. Solo describir lo que se haría.
- **Dry-run del export-plan**: la transición `null → draft` se simula pero no se persiste (no se escribe el archivo).

## Trazabilidad

Cada entry en `state_changes[]` es append-only y debe incluir:

- `from`: estado previo (o `null` para creación).
- `to`: estado nuevo.
- `when`: timestamp ISO-8601 UTC.
- `trigger`: identifica el origen (`export-plan create`, `session-create --from-plan`, `AskUserQuestion plan-state opción N`, `manual`).

Nunca borrar entries previas. La auditoría es parte del valor del artefacto.

## Resumen operacional para el skill

| Situación | Acción |
|---|---|
| `export-plan` crea archivo | `null → draft` automático, sin prompt |
| `session-create --from-plan` (F-E.3) | `draft → active` automático, sin prompt |
| Re-emit con mismo slug | Disparar `AskUserQuestion plan-state` para archivar previo |
| `resume` detecta auto-done condición | Disparar `AskUserQuestion plan-state` con opción 1 recomendada |
| Usuario pide "archivar" | Editar `state: archived` + append `state_changes` |
| Heurística inconclusa | Disparar `AskUserQuestion plan-state` sin recomendación marcada |
