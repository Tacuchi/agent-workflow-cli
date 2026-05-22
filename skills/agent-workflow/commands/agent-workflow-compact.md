---
description: Persiste estado de la sesión activa en CHECKPOINT.md y dispara /compact host. Combina auto-extracción + síntesis del AI para preservar contexto antes de liberar tokens.
argument-hint: (sin args)
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# Compact — agent-workflow

Invoca el skill `compact` (canónico de agent-workflow).

## Acción

1. Detectar sesión activa via `project-md-upsert --read`.
2. Escribir draft auto-extraído con `checkpoint-write`.
3. Completar placeholders sintéticos editando CHECKPOINT.md.
4. Disparar `/compact` host (excepto si el trigger fue SessionEnd hook).

Ver `skills/compact/SKILL.md` para detalles.
