---
name: hub-init
description: Inicializa workspace Hub multi-repo con bloque AW-PROJECT en modo hub. Captura ≥2 fuentes con rutas y ramas de trabajo, valida cross-fuente y persiste marcador Mode hub que activa heurísticas hub-aware en sessions/implement/release. Promociona workspaces project con múltiples fuentes. Invocado vía /agent-workflow:hub-init.
version: 1.1.0
---

> **Profile parametrization**: lee `claude_md_block` de `profile.json` (resuelto vía cascade 5 capas). Ver [`references/profile-parametrization.md`](../../references/profile-parametrization.md) para el contrato completo y comportamiento por defecto cuando el profile está vacío.

# Hub Init

Bootstrap del bloque AW-PROJECT para un workspace **multi-repo** (hub mode). Hub mode introduce el marcador `Mode: hub` que activa heurísticas hub-aware en el resto de la familia agent-workflow.

## Cuándo usar

- Workspace que coordina ≥2 repos pares (sesiones cross-cutting).
- Promover un workspace existente que ya creció a multi-repo.

## Diferencias vs `/agent-workflow:project-init`

| Aspecto | project-init | hub-init |
|---|---|---|
| Fuentes | 1 (mín y máx) | ≥2 (mínimo) |
| Marcador `Mode:` | `project` | `hub` |
| Captura ramas de trabajo | No | Sí, por fuente, en Status |
| Validación cross-fuente | No | Sí (aliases únicos, paths git válidos, comparación con `git rev-parse`) |
| Stack auto-detect | Sobre CWD | Sobre CWD; suele caer en `_Workspace base_` |
| Heurísticas hub-aware | Off | On (sessions, implement, release, doctor) |

## Flujo detallado

### 1. Detectar bloque existente

```
agent-workflow workspace-mode
```

Output: `{mode, sources, working_branches, sources_count, is_hub}`.

| Caso | Acción |
|---|---|
| `mode=hub` | Mostrar fuentes actuales y preguntar: ¿agregar nuevas? ¿reiniciar? ¿abortar? |
| `mode=project` con ≥1 fuente | Detectar promoción: mostrar fuente original y preguntar "¿Promover a hub?". Si confirma, continuar al paso 2 con la fuente original ya cargada. |
| Sin bloque | Flujo limpio. |
| Bloque legacy `<!-- QTC-WORKFLOW-START -->` | Recomendar `/agent-workflow:migrate --upgrade-topology` antes. Abortar. |

### 2. Capturar descripción del workspace

Pedir 1-3 líneas que mencionen que coordina N repos. Va a `## Proyecto`.

### 3. Capturar fuentes

Loop por cada fuente:

- **Alias** kebab-case único.
- **Path absoluto** al repo. Validar `os.path.isdir(path)` y que sea repo git (`<path>/.git/` o `git -C <path> rev-parse --git-dir`).
- **Rama de trabajo actual**: default sugerido = `git -C <path> rev-parse --abbrev-ref HEAD`. Usuario acepta o sobreescribe.

**NO preguntar la rama principal**: el CLI usa `"certificacion"` como default interno. Override sólo con `--main-branch <rama>` (raro).

Mínimo 2 fuentes en flujo limpio. En "agregar a hub existente", mínimo 1 nueva.

### 4. Validaciones cross-fuente

Antes de persistir:

- **Aliases únicos**: si duplicó, error y reintenta.
- **Paths existen + son git repos**: si falla, error y reintenta esa entrada.
- **Rama declarada vs actual**: comparar con `git -C <path> rev-parse --abbrev-ref HEAD`. Si difieren → advertir (no bloquear). Sugerir `git checkout` o aceptar la actual.

### 5. Auto-detectar stack del CWD

```
agent-workflow stack
```

En hub workspaces el CWD suele ser un directorio "base" sin stack propio. Si auto-detección falla → `_Workspace base — stack heterogéneo (ver fuentes individuales)._` en `## Stack`.

Para stack de cada fuente individual: `agent-workflow stack --all-sources` (después del init).

### 6. Persistir bloque + visibilidad (atómico desde v1.1.0)

Una sola invocación atómica al CLI. `agent-workflow hub-init` (introducido en v1.1.0, soportado por `agent-workflow-cli`) orquesta `project-md-upsert --init` + `attach-multiroot --from-sources` en un solo paso. Garantiza que el workspace queda consistente: bloque AW-PROJECT persistido **y** visibility configurada per-workspace, sin pasos separados que el AI pueda olvidar.

```
agent-workflow hub-init \
    --proyecto "<descripción>" \
    --fuente "alias1:path1" --fuente "alias2:path2" \
    --working-branch "alias1:rama1" --working-branch "alias2:rama2"
```

El comando:

- Escribe `CLAUDE.md` y `AGENTS.md` del CWD con bloque `## Proyecto` (Mode: hub), `## Fuentes`, `## Stack`, `## Status` con `- Ramas de trabajo actuales:` + sesiones activas.
- Mergea paths en `<CWD>/.claude/settings.json → permissions.additionalDirectories` con backup `.bak.<timestamp>`.
- Mergea paths en `<CWD>/.codex/config.toml → additional_writable_roots` + bloques `[projects.'<path>'] trust_level = "trusted"` con backup.
- Output JSON consolidado: `{ok, dry_run, workspace, project_md:{…}, attach_multiroot:{scope,scope_dir,paths_input,claude:{…},codex:{…}}}`.

Reportar al usuario: paths registrados, ubicación de cada archivo (énfasis en que están dentro del hub, no en `~`), backups generados.

#### Flags adicionales

- `--main-branch <rama>`: override del default interno `certificacion`.
- `--workspace <DIR>`: override cuando el CWD no es la raíz del hub.
- `--skip-attach`: opt-out del paso de visibility (usar si el usuario prefiere configuración manual o la corre con `attach-multiroot` directamente).
- `--dry-run`: previsualizar sin escribir.

#### Si el usuario prefiere visibility manual

Si `--skip-attach`, el AI debe avisar al usuario que tiene que correr `attach-multiroot` después o configurar manualmente. Snippets de referencia en `references/multiroot-manual.md`.

#### Revertir contaminación global previa

Si en versiones anteriores los paths quedaron en `~/.claude/...` / `~/.codex/...` (legacy v3.3.3 o pre-v1.1.0), correr el inspector y la limpieza:

```
agent-workflow visibility doctor --workspace . --global
agent-workflow detach-multiroot --global --from-sources
```

`visibility doctor --global` reporta paths del hub presentes en scope global con sugerencia explícita; `detach-multiroot --global` los remueve idempotentemente.

### 7. Reportar

- Archivos modificados (CLAUDE.md, AGENTS.md, settings.json, config.toml).
- N fuentes registradas con aliases, paths, ramas.
- Estado de visibilidad multi-root (paths registrados + scope).
- Próximos pasos: `/agent-workflow:session "<objetivo>"` para crear primera sesión cross-cutting.

## Reglas

- **Mínimo 2 fuentes** en flujo limpio. Si quiere 1, redirigir a `/agent-workflow:project-init`.
- **Promoción auto-detectada**: bloques `mode=project` con ≥1 fuente se detectan; sin flag `--promote`.
- **Idempotente**: re-ejecución con datos idénticos es no-op.
- **No tocar legacy QTC-WORKFLOW**: avisar y delegar a migrate.
- **Visibilidad multi-root atómica** (v1.1.0+): el paso 6 colapsa init + attach en `agent-workflow hub-init`. Idempotente con backup. Si el usuario quiere opt-out: `--skip-attach` (la skill avisa que la visibility queda pendiente).

## Política — sin fallback al CLI

Si `agent-workflow workspace-mode|stack|hub-init|attach-multiroot|detach-multiroot|visibility` falla (no está en PATH, comando no reconocido, exit code != 0), **cortá la acción y reportá al usuario**: pedile que verifique `npm install -g @tacuchi/agent-workflow-cli`. No hay flujo alternativo Python.

## Sandbox read-only

`../session/references/sandbox-readonly-rules.md`. Plan describe:

- Archivos a crear/modificar: `CLAUDE.md`, `AGENTS.md`, `<CWD>/.claude/settings.json`, `<CWD>/.codex/config.toml`.
- Bloque AW-PROJECT a escribir: fuentes + ramas + `Mode: hub`.
- Validaciones cross-fuente que se correrían (sin ejecutar `git` ni mutar).
- Si reemplaza bloque existente o promociona desde project, indicarlo.

NO ejecutar `hub-init`, `project-md-upsert --init`, `attach-multiroot`, ni `git rev-parse` en plan mode.

## Recursos adicionales

- **`references/multiroot-manual.md`** — snippets de configuración manual si el usuario declina la automatización.
- **shared-contract §27** (Hub mode) — definición canónica del modo, API, marcador.
- **`/agent-workflow:project-init`** — equivalente single-repo.
- **CLI `--main-branch <rama>`** — override de la rama principal (default interno: `certificacion`).
