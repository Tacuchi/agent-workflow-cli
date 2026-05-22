---
name: compact
description: Persiste estado de la sesión activa en CHECKPOINT.md y dispara /compact host. Invocado vía /agent-workflow:compact, NL como compactá/guardá estado/checkpoint, automáticamente desde el SessionEnd hook al cerrar el cliente, o como último paso del cierre de sesión.
version: 2.4.0
---

# Compact — qtc v2.2

Persiste el estado de la sesión activa antes de un compact del contexto. Combina:

1. **Auto-extracción** (CLI `agent-workflow checkpoint-write`): phase, TASKS counts, decisiones recientes, archivos tocados, branches.
2. **Síntesis del AI**: "Last action", "Next step", "Critical context to resume" (legacy ES: "Lo último que hice", "Próximo paso", "Contexto crítico para retomar").
3. **Hand-off al host**: `/compact` nativo de Claude Code/Codex.

El resultado: `.workflow/sessions/<folder>/CHECKPOINT.md` escrito + contexto liberado.

## Dos caminos al compact

Hay dos formas de compactar contexto en CC/Codex y producen calidad de síntesis distinta:

| Camino | Cuándo usar | Síntesis | Calidad |
|---|---|---|---|
| `/agent-workflow:compact` (skill) | Antes de un compact planeado, cuando querés cierre limpio. | **Pre-compact con contexto vivo**: el AI rellena placeholders mirando la conversación entera + diffs + decisiones. | Alta — el AI tiene todo. |
| `/compact` directo (host) | Compact ad-hoc o automático por umbral de contexto. | **Post-compact con `resume-summary`**: el AI rellena placeholders después del compact, leyendo el JSON del hook + CHECKPOINT.md draft + TASKS.md + DECISIONS.md de disco. | Reducida — el AI ya no ve la conversación previa, solo lo que quedó persistido en disco. |

**Regla**: si para algún placeholder en el camino post-compact no tenés info suficiente, escribí `_(sin info — completar al retomar)_` en lugar de inventar. El usuario completa al hacer `/agent-workflow:resume` si necesita.

El camino post-compact lo coordinan los hooks `PreCompact` y `PostCompact` del plugin (ver `hooks/hooks.json`). Importante: por bug del host ([anthropics/claude-code#13572](https://github.com/anthropics/claude-code/issues/13572)) el `PreCompact` puede no disparar en `/compact` manual. El `PostCompact` mitiga este caso: si `checkpoint_status == "missing"` el AI regenera el draft via `checkpoint-write` y luego rellena.

## Triggers

- **Slash explícito**: `/agent-workflow:compact`.
- **NL del usuario**: "compactá", "guardá estado", "checkpoint", "vamos a compactar".
- **Automático en SessionEnd hook**: al cerrar Claude Code/Codex, el hook escribe CHECKPOINT.md (no dispara `/compact` host porque la sesión ya termina).
- **Automático en cierre de sesión**: el último paso de la skill `session` (closure) invoca `compact`.
- **AI auto-trigger por contexto >75%**: cuando el AI estima carga de contexto >75% del modelo activo (heurística manual, no medición exacta), disparar `AskUserQuestion` con spec de M11 (`../session/references/prompts-catalog.md#M11`). Header `context`, 3 opciones (Compact ahora / Seguir, compact después / Cerrar sesión). Si elige "Compact ahora" → continuar con los pasos 1-5 abajo. Si elige otra → respetar la elección y dejar nota informal en CHECKPOINT.md cuando corresponda. **Si la sesión está en `closure`**: skip M11 (closure ya dispara compact opcional). NO narrar la pregunta en texto plano.

## Acción

### 1. Detectar sesión activa

```
agent-workflow project-md-upsert --read
```

Si no hay activa → mensaje "no hay sesión activa para checkpointar" y stop.

Si hay UNA → continuar.

Si hay VARIAS → preguntar al usuario cuál (o hacer una por una).

### 2. Escribir draft auto-extraído

```
agent-workflow checkpoint-write --code <CODE> --force
```

`--force` asegura draft fresco aunque exista un CHECKPOINT.md sintetizado previo (su síntesis estaría desactualizada respecto al estado actual de la sesión).

Esto crea `.workflow/sessions/<folder>/CHECKPOINT.md` con:

- Header con timestamp, fase, avance %.
- Decisión más reciente (si hay).
- Archivos tocados (git diff vs HEAD).
- Refs (origen, ramas, artefactos presentes).

Y deja **placeholders** `_[AI: …]_` en los campos que requieren juicio:

- "Last action"
- "Next step"
- "Critical context to resume"
- Propósito de cada archivo tocado
- Skills usadas en la sesión

### 3. Completar los placeholders

El AI lee el CHECKPOINT.md draft y reemplaza CADA placeholder con texto sintetizado de la conversación reciente:

- **Last action** (legacy ES: "Lo último que hice"): 1-3 oraciones del último avance concreto. Mirá los últimos diffs aplicados, la última entrada de DECISIONS.md.
- **Next step** (legacy ES: "Próximo paso"): 1-2 oraciones de qué falta. Mirá el primer item abierto de TASKS.md y cualquier blocker mencionado.
- **Critical context to resume** (legacy ES: "Contexto crítico para retomar"): 2-3 párrafos con info mínima para continuar sin re-explorar. Qué descubriste, qué decisiones tomadas, qué tener presente.
- **Propósito de archivos**: 1 línea por archivo tocado.
- **Skills usadas**: lista de skills invocadas durante la sesión (implement, coding-standards, sql-script-organizer, etc.).

Editá el archivo con `Edit` tool — preservá la estructura, sólo cambiá el placeholder por el contenido real.

### 4. Disparar /compact host

Tras editar el CHECKPOINT.md:

> Decir al usuario: "Estado guardado en `.workflow/sessions/<folder>/CHECKPOINT.md`. Ahora corro `/compact` para liberar contexto."

Y ejecutar `/compact` (comando nativo).

Si el trigger fue **SessionEnd hook**, **NO disparar /compact** — la sesión ya termina; sólo escribir y salir.

### 5. Resumir al usuario

1-2 líneas. Path del CHECKPOINT, fase actual, próximo paso. Útil si está por cerrar la PC.

## Ejemplo de invocación

Usuario: "compactá"

AI:
1. Detecta `session046-dev-jobs-async` activa.
2. Corre `agent-workflow checkpoint-write --code 046`. Output:
   ```json
   {
     "session": "session046-dev-jobs-async",
     "checkpoint_path": ".workflow/sessions/session046-dev-jobs-async/CHECKPOINT.md",
     "phase": "execution",
     "progress_pct": 60,
     "tasks_open": 2,
     "tasks_closed": 3,
     "files_touched_count": 4
   }
   ```
3. Lee el CHECKPOINT.md draft, edita los placeholders con síntesis.
4. Confirma al usuario: "Estado guardado. Disparo `/compact`."
5. Corre `/compact`.

## Política — sin fallback al CLI

Si `agent-workflow checkpoint-write` o `agent-workflow project-md-upsert` falla (no está en PATH, comando no reconocido, exit code != 0), **cortá la acción y reportá al usuario**: pedile que verifique `npm install -g @tacuchi/agent-workflow-cli`. No hay flujo alternativo Python.

## Sandbox read-only

Reglas universales en `../session/references/sandbox-readonly-rules.md` (canon agent-workflow).

En plan mode esta skill **no ejecuta** `agent-workflow checkpoint-write`, ni `Edit` sobre CHECKPOINT.md, ni `/compact`. Describe en el plan file:

- `.workflow/sessions/<folder>/CHECKPOINT.md` — crearía/sobrescribiría con formato §17 shared-contract. Resumir: timestamp, fase, avance %, lo último (sintetizado por AI), próximo paso, contexto crítico, refs.
- Síntesis del AI a aplicar a placeholders: enumerar campos (`Last action`, `Next step`, `Critical context to resume`, propósito de archivos tocados, skills usadas).
- Confirmación de que se dispararía `/compact` host (o NO si el trigger es SessionEnd hook).

No invocar el sub-comando `checkpoint-write` ni siquiera con `--dry-run` salvo que el comando expusiera ese flag explícitamente — hoy no lo expone, así que abstenerse.

## Recursos

- `agent-workflow checkpoint-{read,write}` — comandos CLI que leen/escriben el CHECKPOINT.md.
- shared-contract.md §17 — formato canónico de CHECKPOINT.md.
- shared-contract.md §18 — close-triggers-compact convention.
- **`agent-workflow:redaccion-simple`** — guía de redacción para los placeholders `_[AI: ...]_` de CHECKPOINT.md. Aplicar al rellenar (frases cortas, sin párrafos, sin relleno).
- **`../session/references/commits-policy.md`** — el `compact` **no commitea** CHECKPOINT.md por iniciativa propia; el commit (si aplica) lo dispara el closure de `session` o el usuario explícitamente.
