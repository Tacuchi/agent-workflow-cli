---
name: project-init
description: Inicializa el bloque AW-PROJECT en CLAUDE.md y AGENTS.md del workspace con las 4 secciones gestionadas (Proyecto, Fuentes, Stack, Status). Para workspaces que coordinan múltiples repos pares, ver hub-init. Invocado sólo vía /agent-workflow:project-init.
version: 1.0.0
---

> **Profile parametrization**: lee `claude_md_block` de `profile.json` (resuelto vía cascade 5 capas). Ver [`references/profile-parametrization.md`](../../references/profile-parametrization.md) para el contrato completo y comportamiento por defecto cuando el profile está vacío.

# Project Init

Bootstrap del bloque AW-PROJECT para un workspace **single-repo** (project mode). El bloque es la memoria permanente del proyecto y lo lee toda la familia agent-workflow (sessions, doctor, hooks).

## Cuándo usar

- El workspace coordina **un solo repo** (proyecto típico de servicio Java/Spring, frontend Angular, etc.).
- El bloque AW-PROJECT no existe aún o quedó dañado.

Para workspaces con ≥2 repos pares (ej. `qtc-plugin-marketplace` que coordina 4 plugins), usar **`/agent-workflow:hub-init`** — valida cross-fuente y persiste `Mode: hub` que activa heurísticas hub-aware en el resto de skills.

## Flujo

### 1. Detectar bloque existente

```
agent-workflow project-md-upsert --read
```

Casos:
- **Bloque válido y `Mode: project` (o sin Mode)**: mostrar al usuario y preguntar si reiniciar o abortar.
- **Bloque con `Mode: hub`**: avisar que el workspace está en modo hub. Sugerir `/agent-workflow:hub-init` para administrar fuentes. Abortar.
- **Sin bloque**: continuar al paso 2.
- **Bloque legacy `<!-- QTC-WORKFLOW-START -->`**: recomendar `/agent-workflow:migrate --upgrade-topology` antes de seguir. No tocar el bloque legacy automáticamente.

### 2. Capturar descripción

Pedir al usuario:

> "Describí el proyecto en 1-3 líneas: qué es y por qué existe."

Usar `AskUserQuestion` o campo libre. La descripción va a la sección `## Proyecto` del bloque.

### 3. Capturar fuente

Pedir:
- **Alias**: kebab-case corto (ej. `creditos`, `equipos`, `frontend`).
- **Path absoluto** al repo (ej. `C:/Source/mscore-creditos-spring`).

Validar:
- Path existe (`os.path.isdir`).
- Path es repo git (`<path>/.git/` existe o `git -C <path> rev-parse` no falla).

La **rama principal** default es `certificacion` (constante interna del CLI). Override con `--main-branch <rama>` solo en casos atípicos.

Si el usuario quiere declarar ≥2 fuentes, sugerir cambiar a `/agent-workflow:hub-init`. Permitir continuar si insiste, pero advertir que perderá la heurística hub.

### 4. Auto-detectar stack

```
agent-workflow stack
```

Output: `{build, wrapper, framework, language, db}`. Mostrar al usuario y confirmar antes de escribir. Si no se puede detectar (no hay `pom.xml`/`package.json`/etc.), escribir `_Stack sin detectar. Edita manualmente si aplica._`.

### 5. Persistir el bloque

```
agent-workflow project-md-upsert --init \
    --mode project \
    --proyecto "<descripción>" \
    --fuente "alias:path:certificacion"
```

El comando escribe `CLAUDE.md` y `AGENTS.md` del CWD (ambos archivos para soportar Claude Code y Codex). Cache se invalida automáticamente.

### 6. Reportar

Mostrar al usuario:
- Archivos creados/modificados (CLAUDE.md, AGENTS.md).
- Bloque persistido (sección Proyecto, Fuentes, Stack, Status).
- Próximos pasos sugeridos: `/agent-workflow:session "<objetivo>"` para crear la primera sesión.

## Reglas

- **Idempotente**: re-ejecución con bloque ya válido y datos idénticos es no-op.
- **No borrar sesiones activas**: si el bloque existente tiene sesiones en Status, preservarlas.
- **No tocar legacy**: bloques `<!-- QTC-WORKFLOW-START -->` se preservan; el usuario los migra con `/agent-workflow:migrate`.
- **Plan mode**: en plan mode describir qué archivos se crearían/modificarían (CLAUDE.md, AGENTS.md) y el bloque que se escribiría. NO ejecutar `project-md-upsert --init`.

## Política — sin fallback al CLI

Si `agent-workflow project-md-upsert|stack` falla (no está en PATH, comando no reconocido, exit code != 0), **cortá la acción y reportá al usuario**: pedile que verifique `npm install -g @tacuchi/agent-workflow-cli`. No hay flujo alternativo Python.

## Sandbox read-only

Reglas universales en `../session/references/sandbox-readonly-rules.md`. En plan mode, este skill solo describe:

- Archivos a crear/modificar: `CLAUDE.md`, `AGENTS.md` del CWD.
- Bloque AW-PROJECT a escribir: resumen de las 4 secciones (Proyecto, Fuentes, Stack, Status).
- Si reemplaza un bloque existente, indicar diff conceptual.
- Si detecta legacy QTC-WORKFLOW, advertir y sugerir `/agent-workflow:migrate` antes de re-ejecutar fuera de plan mode.
