---
description: Lee CHECKPOINT.md de la sesión activa y presenta resumen para retomar el trabajo. Fallback a session-resume base si no hay checkpoint.
argument-hint: (sin args)
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# Resume — agent-workflow

Invoca el skill `resume` (canónico de agent-workflow).

## Acción

1. Detectar sesión(es) activa(s) via `resume-summary`.
2. Leer CHECKPOINT.md si existe; fallback a `session-resume`.
3. Presentar resumen estructurado al usuario.
4. Preguntar si continúa.

Ver `skills/resume/SKILL.md` para detalles.
