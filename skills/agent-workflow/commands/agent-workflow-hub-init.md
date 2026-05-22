---
description: Inicializa un workspace en modo Hub (multi-repo) — bloque AW-PROJECT con Mode hub, captura ≥2 fuentes con sus rutas y ramas de trabajo. La rama principal default es `certificacion` (constante interna del CLI).
argument-hint: (opcional) --proyecto "descripción" | --fuente alias:path | --working-branch alias:rama | --main-branch <rama>
allowed-tools:
  [
    "Read",
    "Write",
    "Bash",
    "AskUserQuestion",
  ]
---

# Hub Init (agent-workflow)

Inicializa un **hub workspace** — un directorio que coordina ≥2 repos pares. Escribe el bloque `<!-- AW-PROJECT-START -->` en `CLAUDE.md` y `AGENTS.md` del directorio actual con el marcador `Mode: hub` y la lista de fuentes (alias / path / rama principal) + ramas de trabajo actuales por fuente.

> Distinto de `/agent-workflow:project-init` (single-repo). Hub mode activa heurísticas en el resto de la familia agent-workflow-*: `session` itera ramas por fuente, `implement` valida paths cross-repo, `release` agrupa por alias, etc.

## Cuándo usar

- Workspace que coordina ≥2 repos pares (ej. `qtc-plugin-marketplace` con 4 plugins, microservicios que cambian juntos, monorepo distribuido).
- Sesiones cross-cutting que tocan múltiples repos a la vez.

## Flujo

1. **Detectar bloque existente** vía `agent-workflow workspace-mode`.
   - Si `mode=hub` → mostrar fuentes actuales y preguntar si **agregar fuentes** o **reiniciar**.
   - Si `mode=project` (o sin `Mode:`) **y ≥1 fuente declarada** → preguntar si **promover a hub** preservando la fuente original.
   - Si no hay bloque → flujo limpio.

2. **Capturar descripción** (1-3 líneas, debe mencionar que coordina N repos).

3. **Capturar fuentes** (mínimo 2 en flujo limpio; ≥1 nueva en flujo "agregar"). Por cada una pedir solo:
   - **Alias** kebab-case (único).
   - **Path absoluto** al repo (validado: existe + es repo git).
   - **Rama de trabajo actual** (default sugerido: `git -C <path> rev-parse --abbrev-ref HEAD`).
   - **NO se pregunta la rama principal**: el CLI usa `certificacion` como default interno. Override con `--main-branch`.

4. **Validaciones cross-fuente**:
   - Aliases únicos.
   - Paths absolutos y existentes (`os.path.isdir`).
   - Cada path es repo git (`<path>/.git/` o `git -C <path> rev-parse`).
   - Si la rama de trabajo declarada no coincide con la rama actual del repo → advertir (no bloquear).

5. **Auto-detectar stack del CWD** (probablemente workspace base sin stack propio). Si no hay stack detectable, escribir `_Workspace base — stack heterogéneo (ver fuentes individuales)._`.

6. **Persistir** vía:
   ```
   agent-workflow project-md-upsert --init \
       --mode hub \
       --proyecto "<descripción>" \
       --fuente "alias1:path1" \
       --fuente "alias2:path2" \
       --working-branch "alias1:rama1" \
       --working-branch "alias2:rama2"
   ```

7. **Reportar** archivos modificados, fuentes registradas, ramas de trabajo capturadas. Sugerir próximos pasos (`/agent-workflow:session "<objetivo>"` o configurar visibilidad multi-root del cliente — ver README de agent-workflow).

## Visibilidad multi-root del cliente

`/agent-workflow:hub-init` solo captura los datos en el bloque AW-PROJECT. Para que Claude Code o Codex CLI vean los paths de las fuentes como writable, configurarlos manualmente:

- **Claude Code**: editar `~/.claude/settings.json` y agregar paths a `permissions.additionalDirectories`. Alternativa por sesión: `/add-dir <path>` por fuente.
- **Codex CLI**: editar `~/.codex/config.toml` con `additional_writable_roots = [...]` y entradas `[projects."<path>"]` con `trust_level = "trusted"`.

Snippets completos en el README de agent-workflow. Iteración futura podrá automatizarlo vía `/agent-workflow:hub-attach`.

## Argumentos

Sin argumentos: flujo interactivo.

- `--proyecto "<texto>"`
- `--fuente "alias:path[:rama]"` — repetible.
- `--working-branch "alias:rama"` — repetible.
- `--main-branch <rama>` — override del default `certificacion`.

**Argumentos:** $ARGUMENTS

## Skill asociada

Ver `skills/hub-init/SKILL.md` para el detalle del flujo, validaciones cross-fuente y promoción project→hub.
