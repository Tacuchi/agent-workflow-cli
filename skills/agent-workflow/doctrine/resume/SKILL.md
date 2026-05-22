---
name: resume
description: Lee CHECKPOINT.md de la sesión activa, sintetiza placeholders si hace falta y presenta resumen de dónde quedó el trabajo. Invocado vía /agent-workflow:resume, NL como retomar/donde quedamos/continuar, o automáticamente desde el PostCompact hook tras /compact. Fallback a session-resume base si no hay checkpoint.
version: 2.4.0
---

# Resume — qtc v2.1

Recupera el estado de la sesión activa después de un compact (o al volver al proyecto). Lee `.workflow/sessions/<folder>/CHECKPOINT.md` y lo presenta al usuario.

## Triggers

- **Slash explícito**: `/agent-workflow:resume`.
- **NL del usuario**: "retomar", "retomemos", "donde quedamos", "continuar", "seguir con la sesión".
- **Automático en PostCompact hook**: tras un `/compact` el hook lee el resumen y se lo pasa al AI para presentarlo.

## Acción

### 1. Detectar sesión(es) activa(s)

```
agent-workflow resume-summary
```

Output:
```json
{
  "active_sessions": ["session046-dev-jobs-async"],
  "primary_session": "session046-dev-jobs-async",
  "phase_from_qtc_project": "execution",
  "branches_from_qtc_project": ["mscore-solicitud-spring=feature/session046"],
  "checkpoint_present": true,
  "checkpoint": {
    "actualizado": "2026-04-25 20:14",
    "fase": "execution (2/4)",
    "avance": "60% (3 de 5 tareas en TASKS.md completas)",
    "proximo": ["Implementar el consumer de la cola DLQ"]
  }
}
```

Si `active_sessions` está vacío → "No hay sesiones activas para retomar." y stop.

### 2. Síntesis post-compact (fill placeholders)

Si la sesión activa tiene `checkpoint_status` en `missing`, `draft` o `stale`, ejecutar antes de presentar:

1. Si `checkpoint_status: missing`: ejecutar `agent-workflow checkpoint-write --code <primary_session_code>` para regenerar el draft. Continuar con el draft recién generado.
2. Si `checkpoint_status: draft` o `stale` (o el draft recién se regeneró): leer `checkpoint_path` y rellenar cada placeholder `_[AI: ...]_` con la mejor información disponible. Mapeo de campos:
   - `ultimo` → 1-3 oraciones del último avance, basado en `decisiones recientes` y archivos tocados.
   - `proximo` → 1-2 oraciones leyendo el primer ítem abierto de TASKS.md de la sesión.
   - `archivos_proposito` → 1 línea por archivo en la lista.
   - `contexto` → 2-3 párrafos con info mínima para retomar.
   - `skills` → lista de skills invocadas (en post-compact suele ser solo `compact`/`resume`).
3. Si para algún campo no hay información suficiente: escribir `_(sin info — completar al retomar)_` en lugar de inventar. Editar el archivo con la herramienta Edit.

Si `checkpoint_status: complete` (o `needs_ai_action: false`): saltar este paso. Pasar directo a la presentación.

Esta lógica vivía antes en el hook PostCompact (entry prompt). Quedó acá porque (a) es lógica de skill no de hook (boundary clean), y (b) Codex no soporta prompt-type en hooks → en CC se auto-dispara via /agent-workflow:resume; en Codex el usuario lo invoca manualmente.

### 3. Si hay CHECKPOINT.md

Leer el archivo completo:

```
agent-workflow checkpoint-read --code <CODE>
```

Presentar al usuario un resumen estructurado:

```markdown
**Sesión activa**: session046-dev-jobs-async
**Fase**: execution (2/4) · 60% completa (3/5 tareas)
**Última actualización**: 2026-04-25 20:14

**Lo último que hicimos**: <campo del checkpoint>

**Próximo paso**: <campo del checkpoint>

**Decisiones recientes**:
<lista>

**Archivos tocados sin commit**:
<lista corta>

**Contexto crítico**:
<párrafos del checkpoint>
```

Y disparar `AskUserQuestion` con spec de S5 (`../session/references/prompts-catalog.md#S5`). Header `post-compact`, 3 opciones (Retomar misma sesión / Abrir nueva sesión / Solo recapitular, después decido). **Recomendación dinámica**: el AI marca `(Recomendado)` en opción 1 si CHECKPOINT.md indica `tasks_open ≥ 1`; caso contrario marca opción 2. NO narrar la pregunta en texto plano.

Resolución por opción:

- **Retomar misma sesión** → cargar OBJECTIVE.md, TASKS.md, DECISIONS.md como contexto activo; verificar ramas (`agent-workflow sources`); reanudar en la fase indicada.
- **Abrir nueva sesión** → cerrar la actual como `paused` (graduación postergada) y delegar al skill `session` con prompt de OBJECTIVE.
- **Solo recapitular** → mantener el resumen presentado; pausar el loop y dejar que el usuario decida en próximo turno.
- **Other auto** → instrucción custom (ej. "retomá pero salteá a la T5") — interpretar y aplicar; si ambiguo, fallback a "Solo recapitular".

**Si CHECKPOINT.md ausente o ilegible**: skip S5 y fallback a `session-resume` base con soft prompt "¿Continuamos desde acá?".

### 4. Si NO hay CHECKPOINT.md

Fallback a:

```
agent-workflow session-resume --code <CODE>
```

Devuelve campos base (objetivo, fase, ramas, tasks counts). Presentar como resumen y preguntar si continúa.

### 5. Si hay múltiples sesiones activas

Listar todas con resumen 1-línea cada una y pedir al usuario seleccionar cuál retomar.

### 6. Si NO hay sesiones activas — detectar cerradas con artefactos (F-E.2)

Cuando `resume-summary` retorna `active_sessions: []`, re-invocar con `--include-recent-closed` para detectar sesiones cerradas en los últimos 7 días que tengan artefactos "completos":

```
agent-workflow resume-summary --include-recent-closed
```

Heurística "completos" por flow (definida en G5 de session062):

| Flow | Criterio |
|---|---|
| `analyze` | `EVIDENCE.md` + `FINDINGS.md` + `CONCLUSIONS.md` presentes |
| `dev` | `TASKS.md` con ≥50% closed Y `DECISIONS.md` presente |
| `design` | `DELIVERY.md` presente |

Si `recent_closed_with_artifacts.length > 0`, disparar `AskUserQuestion` con spec del S-prompt `closed-with-artifacts` (`../session/references/prompts-catalog.md#closed-with-artifacts`):

- Header: `closed-with-artifacts`.
- 4 opciones:
  1. **Export plan** — invocar `/agent-workflow:export-plan --sessions <NNN>` con la sesión elegida.
  2. **Export conclusions** — invocar `/agent-workflow:export-conclusions --sessions <NNN>` (solo si la sesión es analyze con CONCLUSIONS).
  3. **Abrir nueva sesión** — delegar a `/agent-workflow:session` con prompt OBJECTIVE.
  4. **Solo recapitular** — leer artefactos y presentar resumen, sin acción derivada.

**Recomendación dinámica**: si hay 1 sola sesión analyze cerrada → opción 2 marcada `(Recomendado)`. Si hay ≥2 sesiones del mismo dominio → opción 1 marcada `(Recomendado)`. Sin ambigüedad: el AI explica brevemente la heurística antes del prompt.

**Other auto** = "Otra acción" → registrar como nota informal y consultar.

Si `recent_closed_with_artifacts.length == 0`: "No hay sesiones activas para retomar." y stop (comportamiento previo).

## Ejemplo

Usuario abre Claude Code después de un compact previo.

PostCompact hook dispara → AI ejecuta `agent-workflow resume-summary` → recibe el JSON.

AI presenta:
```
Sesión activa: session046-dev-jobs-async (execution 2/4, 60%).

Última actualización: 2026-04-25 20:14.

**Lo último**: Implementé el publisher de jobs con RabbitMQ — flujo end-to-end de
encolado funciona, mensajes llegan a `qtc.jobs.priority`.

**Próximo paso**: Implementar el consumer de la cola DLQ con retry exponencial.

**Decisiones recientes**: DEC-003 — Usar RabbitMQ exchange `topic` (no `direct`)
para soportar wildcards en routing keys.

**Contexto crítico**: La cola principal usa publisher confirms; el consumer DLQ
debe replicar el patrón. El test de integración corre en `mscore-jobs-test`.

¿Continuamos desde el consumer DLQ?
```

Usuario: "sí" → AI carga TASKS.md, busca el item del consumer, arranca implementación.

## Sandbox read-only

Reglas universales en `../session/references/sandbox-readonly-rules.md` (canon agent-workflow).

`resume` es read-only por diseño — los sub-comandos que invoca (`resume-summary`, `checkpoint-read`, `session-resume`) están todos en la lista plan-mode-safe. Igual, en plan mode esta skill describe en el plan file:

- Qué sesión activa se detectó (output de `resume-summary`) — lectura ya ejecutada o a ejecutar.
- Qué presentaría al usuario (resumen estructurado: fase, avance, lo último, próximo paso, decisiones, archivos sin commit, contexto crítico).
- Qué **NO** hace: cargar OBJECTIVE.md (legacy: OBJETIVO.md) / TASKS.md / DECISIONS.md (legacy: DECISIONES.md) como contexto activo (eso es para post-aprobación del plan), ni invocar `agent-workflow sources` que también es read-only pero forma parte del "flujo activo" post-plan.

## Reglas

- **Una sola sesión por turno**: si hay varias activas, presentar todas pero retomar una a la vez.
- **No asumir continuación**: siempre preguntar antes de cargar contexto profundo.
- **CHECKPOINT.md > session-resume base**: si existe checkpoint, es la fuente de verdad. Si no, base.
- **Branches verification**: antes de editar, correr `agent-workflow sources`.

## Política — sin fallback al CLI

Si `agent-workflow resume-summary`, `checkpoint-read` o `sources` falla (no está en PATH, comando no reconocido, exit code != 0), **cortá la acción y reportá al usuario**: pedile que verifique `npm install -g @tacuchi/agent-workflow-cli`. No hay flujo alternativo Python.

## Recursos

- `agent-workflow checkpoint-read` — lectura programática del último CHECKPOINT.md.
- shared-contract.md §17 — formato CHECKPOINT.md.
- **`agent-workflow:redaccion-simple`** — guía de redacción para el resumen que se presenta al retomar. Frases cortas, una idea por línea.
