# Topic-change rules

> Anchor `agent-workflow:topic-change-rules`. Heurística que detecta cuando el usuario cambia de tema dentro de una sesión activa y `agent-workflow:session` debe proponer abrir una sesión nueva en lugar de continuar.

## CLI runtime

```
agent-workflow topic-change-check --code <NNN> --new-input "<text>"
```

Devuelve `{ topic_changed: bool, confidence: low|medium|high, reason: <text> }`.

## Heurísticas

### Señales fuertes (high confidence)

- El nuevo input menciona archivos/módulos completamente disjuntos de los que tocó la sesión.
- Cambio de fuente: la sesión activa toca `agent-workflow` y el nuevo input pide algo en `agent-workflow`.
- Cambio de Type/Modality declarado (la sesión es `## Type: feature` y el input pide refactor; o flow=design y el input pide implementar).
- El usuario dice explícito "cambiá de tema" / "olvidá lo anterior" / "ahora hagamos X".

### Señales medias (medium confidence)

- El nuevo input agrega features no listados en OBJECTIVE.md acceptance criteria.
- Más del 50% de las menciones nuevas son sobre archivos/conceptos no vistos previamente.

### Señales débiles (low confidence)

- El nuevo input refina un acceptance criterion existente.
- Pide ajustar comportamiento de algo ya implementado en la sesión.

## Acción por confidence

| Confidence | Acción |
|---|---|
| high | `agent-workflow:session` muestra prompt S2 sugiriendo abrir sesión nueva (default) o continuar (override). |
| medium | Mismo prompt pero con default=continuar. |
| low | No interrumpe; trata como refinamiento. |

## Ejemplos

### High — cambio de fuente

- Sesión activa: `session030-dev-fix-history-parser` en `agent-workflow:feature/last`.
- Nuevo input: "ahora actualicemos el README de agent-workflow con los cambios".
- Output: `topic_changed: true`, confidence `high`, motivo "fuente nueva (agent-workflow)".

### Medium — feature creep

- Sesión activa: `session032-dev-add-export-csv`, OBJECTIVE menciona solo CSV.
- Nuevo input: "agregale también export a Excel y JSON".
- Output: `topic_changed: true`, confidence `medium`, motivo "scope creep — JSON/Excel no en acceptance criteria".

### Low — refinamiento

- Sesión activa: `session033-dev-validation-form`.
- Nuevo input: "el error de email vacío que muestra ahora dice 'requerido', cambialo a 'el email es obligatorio'".
- Output: `topic_changed: false`, confidence `low` — refinamiento del mismo scope.

## Override manual

Usuario puede declarar `--continue-anyway` en el CLI para silenciar el check, o decir "es el mismo tema, continuá" en NL.

## Refs

- `references/prompts-catalog.md#S2` — prompt S2 (topic-change-detection).
- CLI: `agent-workflow topic-change-check --help`.
