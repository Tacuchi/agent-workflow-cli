---
description: Comando ligero para tareas pequeñas y directas (fixes, ajustes, chores acotados). Micro-lifecycle en modo --lite de flow=dev — ceremonia mínima (OBJECTIVE condensado, sin TASKS/DESIGN, closure condensado). Escala in-place a sesión completa si la tarea crece.
argument-hint: (<descripción-tarea> | sessionXXX | XXX | close)
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

# Patch — micro-lifecycle para tareas pequeñas

Azúcar sobre el lifecycle universal: invoca el skill `session` (canónico de agent-workflow) en **modo lite** con `$ARGUMENTS`. Para fixes, ajustes y chores acotados que no justifican la ceremonia de una sesión completa, pero sí merecen trazabilidad mínima (HISTORY + DECISIONS lazy + commit M1).

No es un flow nuevo ni un motor paralelo: `/patch "<qué>"` = `session-create --lite --flow dev "<qué>"`.

## Resolución de intención

El skill evalúa `$ARGUMENTS`:

1. `close` → cerrar el patch activo (closure condensado).
2. Matchea `sessionXXX` o `XXX` (3 dígitos) → retomar ese patch/sesión.
3. Texto descriptivo → crear micro-sesión lite (este es el caso común).

## Qué hace el modo lite (al crear)

1. `agent-workflow session-create --lite --flow dev --name <slug> --objetivo "<texto>"` — crea la micro-sesión.
   - OBJECTIVE condensado (solo `## Type` + `## Requirement`).
   - `## Type` default `bugfix` (o `chore` si la heurística lo detecta). No admite `feature|refactor`.
   - Tag `kind:patch` en la fila de HISTORY.
2. **Salta la ceremonia de planning**: sin auto-plan prompt, sin TASKS.md, sin DESIGN.md/S7, sin M10. El Requirement es la única tarea.
3. **Loop directo**: aplicar el cambio mínimo componiendo `implement` + `coding-standards`. Mostrar diff. Registrar DECISIONS solo si hay algo no obvio (lazy).
4. **Closure condensado**: commit M1 (propose-then-execute) directo; no gradúa por default.

## Escalado in-place

Si durante el trabajo emerge complejidad (toca >3 archivos, requiere scripts SQL/BD, o el cambio resulta ser feature/refactor): el AI **propone promover** a sesión completa. Promover = quitar el tag `kind:patch`, generar TASKS.md y, si el Type sube a feature/refactor, disparar DESIGN.md + S7 — en la **misma** sesión (no fragmenta).

## Plan mode

El skill resuelve la intención normalmente y describe acciones en el plan file en lugar de ejecutarlas.

## Recursos

Ver `skills/session/SKILL.md` §"Modo lite (/patch)" para el detalle del micro-lifecycle y el escalado.
