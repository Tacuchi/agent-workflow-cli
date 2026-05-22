# Lifecycle universal — detalles avanzados

Contenido detallado movido desde `SKILL.md` para optimización de tokens (lazy-load).

## Plan subagent nativo (v2.3+ — opcional)

Para descomposiciones `lite` o `full`, agent-workflow puede delegar la estructuración del plan al Plan subagent nativo del cliente (Claude Code expone `Task(subagent_type="Plan")`).

### Detección del harness

```
agent-workflow harness
```

Output: `{harness: "claude-code"|"codex"|"unknown", supports_plan_subagent: bool, detected_via: "..."}`.

| Harness | supports_plan_subagent | Acción |
|---|---|---|
| `claude-code` | true | `Task(subagent_type="Plan")` con OBJECTIVE + Fuentes + decisión auto-plan. Output → TASKS.md. |
| `codex` | false | Fallback: redactar TASKS directamente con o sin sugerencias de `specialty-choose`. |
| `unknown` | false | Fallback igual que codex. No bloquear. |

### Prompt al Plan agent (CC)

```
Estructurá un plan accionable (TASKS.md) para esta sesión agent-workflow.

OBJECTIVE:
<contenido de .workflow/sessions/<folder>/OBJECTIVE.md>

Fuentes (de AW-PROJECT):
<tabla de Fuentes con paths y ramas>

Auto-plan decisión: <skip|lite|full> — <reason>

Restricciones:
- TASKS.md formato: items `- [ ]` con criterio de aceptación + dependencias.
- `lite` → 1-3 items; `full` → ≥3 items con descomposición explícita.
- Cada item debe ser ejecutable en una sola tarea (no compuesto).
- Sugerir orden por dependencias.
- NO incluir steps de validación (eso va a fase 3).

Devolvé el contenido completo de TASKS.md.
```

### Trade-offs

- **Contexto aislado**: el Plan subagent no comparte el transcript actual. Recibe sólo el prompt construido.
- **OBJECTIVE.md sigue siendo la fuente de verdad** persistente — sobrevive `/compact`, accesible al retomar. Plan agent es soporte, no reemplazo.
- **Re-iteración**: si el plan resultante no satisface, editar TASKS.md directamente; no re-invocar el subagent.
- **Skip cuando obvio**: para `auto-plan = skip` o tareas atómicas, NO invocar el subagent (latencia sin valor).

### Persistencia del output

1. Capturar el contenido devuelto por Task(Plan).
2. Escribir a `.workflow/sessions/<folder>/TASKS.md` con `Write`.
3. Mostrar al usuario el TASKS.md resultante y pedir confirmación antes de avanzar a execution.

## Sub-agente per-flow (v2.4+ — opt-in)

### Detección del opt-in

```
agent-workflow profiles
```

Si el output incluye `"delegate_to_subagent": true` y el harness es `claude-code`, **delegar**. Si false, unknown, o harness=Codex, **composición clásica**.

### Modo delegación (opt-in + CC)

```
Task(
  subagent_type="<flow>-agent",
  prompt=<OBJECTIVE + Fuentes + TASKS.md + skills cross-plugin confirmadas + decisión auto-plan>
)
```

Donde `<flow>` se lee del campo `flow` de la sesión activa (metadata persistida por `agent-workflow session-create --flow <flow>`):
- `flow=dev` → `dev-agent` (NUNCA design-agent ni analyze-agent).
- `flow=design` → `design-agent`.
- `flow=analyze` → `analyze-agent`.

El comando entry point es único (`/agent-workflow:session`); el flow se resolvió en planning vía heurística + S3 fallback (ver `SKILL.md` paso "Detectar flow").

### Loop con sub-agente

```
Task(<flow>-agent, prompt) → output JSON con next_action
                                       │
                                       ▼
                  ┌──────────┬──────────┴──────────┬─────────────┐
              "continue"  "needs_user_input"   "validation"   "ready_for_handoff"
                  │              │                  │                │
              Task(...)     pasar pregunta      avanzar phase   sugerir handoff
              de nuevo      al usuario, esperar  a validation   `/agent-workflow:session --from <flow>:<code>`
```

El caller hace el bucle hasta que `next_action ∈ {validation, ready_for_handoff}` o el usuario detenga.

### Trade-offs

- **Aislamiento**: el sub-agente NO ve el transcript principal. Recibe sólo el prompt construido.
- **Latencia**: cada delegación es 1 round-trip extra. Compensa en sesiones largas.
- **Default off**: opt-in vía `~/.workflow/user-config.md` para no romper sesiones existentes.

Si delegás, **saltar la sección "Composición dinámica de especialidades"** del SKILL.md — el sub-agente la maneja internamente.

## Composición dinámica de especialidades

| Necesidad | Skill a invocar | Flow |
|---|---|---|
| Editar código (Java/TS/etc.) | `implement` + `coding-standards` | dev |
| Migración SQL / scripts BD | `sql-script-organizer` + `sql-rollback-generator` | dev |
| Producir spec UI | `design-deliver` + `frontend-design` | design |
| Investigación técnica | `analyze-investigate` | analyze |
| Cierre de análisis (propuesta / informe / post-mortem) | `analyze-conclude` (modulado por modalidad) | analyze |
| UI form / list / modal (referencia) | `frontend-design` | design |
| Test strategy | `testing-strategy` | dev |

> Todos los skills viven en `agent-workflow` (consolidación v2.0.0). La columna "Flow" indica el agrupamiento conceptual de la skill, no el plugin que la hospeda.

**Reglas de activación** (regla cero — v2.1+):

- Skills del **mismo flow**: el AI las invoca por contexto cuando aplican. Composición interna autorizada.
- Skills **cross-plugin**: el AI las **sugiere al usuario** y espera confirmación explícita. Invocación por namespace (`Skill(agent-workflow:frontend-design)` post-Fase C; legacy `Skill(qtc-design:frontend-design)` válido durante convivencia) o `@`-mención. Nunca auto-invocar por keyword.

## Hub mode (v4.5+)

Si el workspace declara `Mode: hub` (detectado vía `agent-workflow workspace-mode`):

- **Crear sesión**: pedir explícitamente las **ramas de trabajo por fuente** (al menos para las que la sesión va a tocar). Las pre-existentes en AW-PROJECT.Status pueden sugerirse como default.
- **Verificar rama**: `agent-workflow sources` itera todas las fuentes. Para subset: `--scope alias1,alias2`.
- **Auto-plan**: si la sesión menciona ≥2 fuentes en OBJECTIVE, peso adicional hacia `full`.
- **Topic-change**: divergencia entre fuentes-tocadas y fuentes-mencionadas-en-OBJECTIVE es señal adicional.
- **Composición cross-flow**: igual que en project mode — namespace explícito.

Para `Mode: project` (default), todas las heurísticas hub-aware quedan inactivas.

## Sandbox read-only

Reglas universales en `references/sandbox-readonly-rules.md`. El lifecycle entero queda **en pausa** durante plan mode.

| Fase | Qué describir (no ejecutar) |
|---|---|
| **Crear sesión** | Carpeta + archivos OBJECTIVE.md/TASKS.md + filas en HISTORY/AW-PROJECT. |
| **Phase 1 (planning)** | Output esperado de `auto-plan-decide` y `specialty-choose`. NO invocar skills sugeridas. |
| **Phase 2 (execution)** | Lista de archivos, scripts SQL, decisiones. Verificación read-only de rama. |
| **Phase 3 (validation)** | Comandos de test con args. NO ejecutar destructivos. |
| **Phase 4 (closure)** | Lista de artefactos a graduar + paths destino. |

Sub-comandos plan-mode-safe: `project-md-upsert --read`, `sessions`, `auto-plan-decide`, `specialty-choose`, `topic-change-check`, `session-resume`, `checkpoint-read`, `objetivo-data`, `tasks-data`, `decisiones-list`, `session-artifacts`.

## Compatibilidad legacy

Migrables con `/agent-workflow:migrate`:
- Sesiones v1.x con fases per-flow → mapeo a 4 fases v2.0.
- Bloques `<!-- QTC-WORKFLOW -->` (pre-v0.8) → AW-PROJECT.
- `STATUS.md`, `REQUIREMENTS.md`, etc.

No migrar automáticamente; usuario decide.
