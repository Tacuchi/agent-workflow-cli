---
description: Lifecycle universal de sesiones agent-workflow-* (4 fases: planning → execution → validation → closure). Crea, retoma, lista o cierra sesiones componiendo skills de especialidad según el OBJECTIVE.
argument-hint: (sin args | <slug-objetivo> | sessionXXX | XXX | list | close)
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
  ]
---

# Session — Lifecycle universal agent-workflow-*

Invoca el skill `session` (canónico de agent-workflow) con `$ARGUMENTS`.

## Resolución de intención

El skill evalúa `$ARGUMENTS` en orden:

1. `close` → flujo de cierre.
2. `list` → flujo de listado.
3. Matchea `sessionXXX` o `XXX` (3 dígitos) → flujo de retomar.
4. Texto descriptivo → flujo de crear (con prompts adicionales para slug + ramas).
5. Sin args → escanear estado y proponer.

## Plan mode

Skill resuelve la intención normalmente y describe acciones en el plan file en lugar de ejecutarlas.

## Recursos

Ver `skills/session/SKILL.md` para el árbol de decisión completo y los recursos de referencia.
