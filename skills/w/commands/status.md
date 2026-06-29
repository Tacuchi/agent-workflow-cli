---
description: Dashboard read-only del workspace — qué se hizo / qué falta / qué se descartó, con fechas en español (hace 2 días, ayer en la mañana). Se apoya en `aw status`. Comando transversal (no es un flow); no escribe nada.
argument-hint: (sin argumentos)
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# status — estado del workspace (read-only)

Muestra, simple y directo, el estado del workspace agrupado en **Hecho / Falta / Descartó**. Single-pass, read-only: no abre loop, no crea sesiones, no escribe en `docs/` ni en `.workflow/`. Comando **transversal** (no pertenece a ningún flow).

## Ejecutar

1. Corré `aw status` (devuelve JSON; se apoya en `status-service`).
2. Renderizá un resumen legible a partir del JSON — **no** muestres el JSON crudo. Usá el campo `relative` tal cual (ya viene humanizado en español). Encabezá con `workspace.name`.
3. Agrupá en tres bloques:
   - **▸ HECHO** — specs con `refined: true`; plans con su progreso (`tasks_done`/`tasks_total`, `progress_pct`); sesiones `closed`.
   - **▸ FALTA** — sesiones `active`; plans con tareas pendientes (`tasks_total − tasks_done`); specs con `open_questions > 0`.
   - **▸ DESCARTÓ** — cada item de `discarded[]` (`kind: deferred` = diferido en BACKLOG; `kind: excluded` = excluido en CHECKPOINT), con su `text`.
4. Cada línea termina con su fecha relativa tras ` · ` (ej. `· ayer en la mañana`). Si una sección queda vacía, mostrá `— (nada)`. No inventes datos que no estén en el JSON.
5. Si `workspace.initialized` es `false` y todo está vacío → decí "No es un workspace de agent-workflow (no hay `.workflow/`)" y sugerí `/w:workspace-init`.

Formato sugerido (texto plano):

```
Workspace: <name>

▸ HECHO
  • plan <slug> — <done>/<total> tareas (<pct>%) · <relative>
  • spec <slug> — refinado · <relative>
  • <folder> (<type>) — cerrada · <relative>

▸ FALTA
  • <folder> (<type>) — activa · <relative>
  • plan <slug> — <pendientes> tareas pendientes
  • spec <slug> — <n> preguntas abiertas

▸ DESCARTÓ
  • <text> (<kind>) · <relative>
```

## Plan mode
Igual que en ejecución: corré `aw status` (read-only) y mostrá el resumen. No hay cambios que aplicar.

## Resources
- CLI: `aw status` (servicio `status-service`; fechas vía `humanize-es`)
- Design reference: `docs/referencias/workflow-skills/status.md`
