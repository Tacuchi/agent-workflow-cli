---
description: Inicializa un workspace en modo Hub (multi-repo) — escribe el bloque AW-PROJECT con Mode hub y ≥2 fuentes (rutas + ramas) y SIEMPRE configura la visibilidad multi-root (settings.local.json + config.toml, gitignored), reconciliando fuentes. La forma interactiva vive en el TUI.
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

Inicializa un **hub workspace** — un directorio que coordina ≥2 repos pares. Escribe el bloque `<!-- AW-PROJECT-START -->` en `CLAUDE.md` y `AGENTS.md` del CWD con `Mode: hub` + la lista de fuentes (alias / path / rama) + ramas de trabajo. Además del bloque, **siempre** configura la visibilidad multi-root (gitignored) — sin preguntar.

> Distinto de `/agent-workflow:project-init` (single-repo). Hub mode activa heurísticas en el resto de la familia: `session` itera ramas por fuente, `implement` valida cross-repo, `release` agrupa por alias.

## La vía más simple: el TUI

`agent-workflow` → tab **Project** → **Initialize as hub**. Form interactivo (nombre + paths + rama base, alias inferido de la carpeta) dentro del TUI. Sin flags ni comandos a mano.

## Flujo (host) — mínimo

1. **Detectar** vía `agent-workflow workspace-mode`. Si ya es hub → agregar/reiniciar. Si es `project` con fuentes → ofrecer promover. Bloque de una topología legacy → delegar a `/agent-workflow:migrate`.
2. **Reunir**: descripción (1 línea), ≥2 fuentes (alias + path) — el **set completo** que querés, porque `hub-init` reemplaza el bloque (para agregar/remover, leé las actuales con `workspace-mode` y pasá el set final) —, rama base (default `certificacion`) y **rama de trabajo** (la feature branch). El alias se infiere de la carpeta si no se da. La rama de trabajo **siempre se solicita**: si no viene en el mensaje, preguntala (`AskUserQuestion`) antes de ejecutar — no la asumas.
3. **Escribir + sincronizar** (un solo comando):
   ```
   agent-workflow hub-init \
       --proyecto "<descripción>" \
       --fuente "alias1:path1" --fuente "alias2:path2" \
       [--working-branch "alias1:rama1" ...] [--main-branch <rama>]
   ```
   Rutas Windows (`C:\Source\...`) van directo. Escribe `CLAUDE.md` + `AGENTS.md` **y** configura la visibilidad multi-root (siempre, ver abajo).
4. **Reportar** fuentes registradas + próximo paso (`/agent-workflow:session "<objetivo>"`).

## Visibilidad multi-root (automática, siempre)

`hub-init` la configura en cada run, sin preguntar:

- **Gitignored** (rutas machine-specific): `<hub>/.claude/settings.local.json` (`permissions.additionalDirectories`) + `<hub>/.codex/config.toml` (`additional_writable_roots` + `[projects.'<path>'] trust_level`). Asegura el `.gitignore`.
- **Reconcile**: attachea las fuentes actuales y detachea las removidas vs el bloque previo (agregar/remover quedan sincronizados).
- Diagnóstico: `agent-workflow visibility doctor --workspace .` (lee `settings.json` y `settings.local.json`).

## Argumentos

Sin argumentos: el host arma el flujo mínimo de arriba (o usá el TUI).

- `--proyecto "<texto>"`
- `--fuente "alias:path[:rama]"` — repetible (mín 2).
- `--working-branch "alias:rama"` — repetible.
- `--main-branch <rama>` — override del default `certificacion`.

**Argumentos:** $ARGUMENTS

## Skill asociada

Ver `doctrine/hub-init/SKILL.md` para el flujo, la promoción project→hub y la visibilidad multi-root.
