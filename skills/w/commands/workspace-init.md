---
description: Convierte la carpeta actual en un workspace de agent-workflow (scaffolding .workflow/ + docs/ + WORKSPACE block + skills.toml). Reemplaza hub-init + project-init — sin distinción project/hub. Correr una vez antes de cualquier flujo; idempotente.
argument-hint: --source alias:path[:rama] [--proyecto <nombre>] [--main-branch <rama>] [--dry-run]
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# workspace-init — bootstrap del workspace

Corre `aw workspace-init` para convertir la carpeta actual en un workspace de agent-workflow. Un workspace tiene **1+ fuentes** (repos); "standalone" = una sola fuente. No hay modos project/hub — el modelo es unificado.

```bash
aw workspace-init --source alias:path[:rama] [--proyecto <nombre>] [--main-branch <rama>] [--dry-run]
```

## Pasos interactivos

1. **Detectar/confirmar fuentes** — el CLI detecta la/s ruta/s de repo; el usuario confirma aliases, paths y ramas. Se acepta `--source` múltiple.
2. **Elegir skills por defecto** — se presenta el catálogo de capacidades (roles) disponibles. Para cada rol: `built-in default`, override a skill de tercero (`skills.sh`), o `off`. Resultado escrito en `.workflow/skills.toml`. La cascada de config es: `built-in → ~/.workflow/skills.toml (global) → .workflow/skills.toml (workspace)`.
3. **Escribir scaffolding** — crea `.workflow/sessions/`, `docs/` con su taxonomía (`specs/`, `plans/`, `scripts/`, `manuals/`, `diagrams/`, `reports/`), el bloque `WORKSPACE` en `CLAUDE.md`/`AGENTS.md` (fuentes + metadatos), y `.workflow/skills.toml`.
4. **Multi-fuente** — si hay ≥2 fuentes, configura visibilidad multi-root (settings.local.json + config, gitignored) y reconcilia fuentes.

Al terminar, el usuario puede correr `/w:spec-new`, `/w:plan-new` o `/w:quick` directamente.

**Idempotente**: re-ejecutar reconcilia (no duplica entradas ni sobrescribe configuración manual).

## Plan mode

Resuelve las fuentes y describe el scaffolding que crearía, sin escribir archivos. Muestra qué crearía en `.workflow/` y `docs/`, y qué escribiría en `CLAUDE.md`.

## Resources

- Design reference: `docs/referencias/workflow-commands/workspace-init.md`
- Skills config: `docs/referencias/workflow-roles/` (capacidades/roles disponibles y cascada de binding)
