---
description: Migra sesiones legacy de .claude/.codex/ a .workflow/, convierte proyectos pre-0.9 al formato actual, instalaciones pre-v0.12 al namespacing agent-workflow-*, upgrade v3.x→v4.0 (lifecycle universal) y upgrade hub-mode (≥2 fuentes sin marcador → Mode hub).
argument-hint: "[--flow dev|design|analyze] [--rebuild-history] [--upgrade-topology] [--upgrade-v4] [--upgrade-hub-mode]"
allowed-tools:
  [
    "Read",
    "Write",
    "Bash",
    "Grep",
    "Glob",
  ]
---

# Migrate (agent-workflow)

Migrar artefactos del workspace desde rutas y formatos legacy hacia la topología actual. Vive en agent-workflow (Fase B; antes en qtc-core v3.0+, previamente duplicado en cada flow plugin).

## Modos

- **Modo normal** (sin flags): detecta sesiones legacy en `.claude/`/`.codex/`, indicadores de topología pre-0.9, indicadores pre-v4.0 (lifecycle 5 fases), y workspace eligible para hub-mode (≥2 fuentes sin marcador). Pide confirmación por cada bloque de cambios.
- `--flow dev|design|analyze`: enfoca el upgrade a un flow específico (afecta el destino del rename de carpetas legacy).
- `--rebuild-history`: solo regenera `.workflow/HISTORY.md` leyendo las sesiones existentes y `docs/`.
- `--upgrade-topology`: solo conversión al formato 0.8+ (OBJETIVO/AW-PROJECT/_archived).
- `--upgrade-v4`: solo upgrade v3.x → v4.0 (mapeo de fases + CHECKPOINT.md inicial).
- `--upgrade-hub-mode`: solo upgrade hub-mode (idempotente; delega a `agent-workflow upgrade-hub-mode`).

Ejemplos:

```
/agent-workflow:migrate                              # detección completa + confirmación
/agent-workflow:migrate --upgrade-hub-mode           # solo hub-mode
/agent-workflow:migrate --upgrade-topology           # solo conversión al formato 0.8+
/agent-workflow:migrate --rebuild-history            # regenera HISTORY.md
```

## Flujo

Ver detalle completo en `skills/migrate/SKILL.md`. Resumen:

1. **Detectar** — legacy paths, topología pre-0.9, fases v3.x, workspace eligible para hub-mode.
2. **Informar y confirmar** — bloques de cambios separados, el usuario acepta cada uno.
3. **Ejecutar** cada bloque aceptado.
4. **Reportar** — resumen por bloque ejecutado.

## Reglas

- **Idempotente**: re-ejecutar es no-op para upgrades ya aplicados.
- **Nunca sobreescribir** sesiones existentes.
- **Nunca borrar automáticamente** `.claude/` ni `.codex/`: solo mover contenido del plugin.
- **Siempre confirmar** antes de mutar.

**Argumentos:** $ARGUMENTS

## Skill asociada

Ver `skills/migrate/SKILL.md` para el detalle completo (detección, procesos por upgrade, indicators, etc.).
