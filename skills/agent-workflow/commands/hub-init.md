---
description: Inicializa un workspace en modo Hub (multi-repo) — escribe el bloque AW-PROJECT con Mode hub y ≥2 fuentes (rutas + ramas). Solo scaffold; la visibilidad multi-root es opt-in (--attach). La forma interactiva vive en el TUI.
argument-hint: (opcional) --proyecto "descripción" | --fuente alias:path | --working-branch alias:rama | --main-branch <rama> | --attach
allowed-tools:
  [
    "Read",
    "Write",
    "Bash",
    "AskUserQuestion",
  ]
---

# Hub Init (agent-workflow)

Inicializa un **hub workspace** — un directorio que coordina ≥2 repos pares. Escribe el bloque `<!-- AW-PROJECT-START -->` en `CLAUDE.md` y `AGENTS.md` del CWD con `Mode: hub` + la lista de fuentes (alias / path / rama) + ramas de trabajo. **Es solo scaffold**: no toca la visibilidad de hosts salvo `--attach`.

> Distinto de `/agent-workflow:project-init` (single-repo). Hub mode activa heurísticas en el resto de la familia: `session` itera ramas por fuente, `implement` valida cross-repo, `release` agrupa por alias.

## La vía más simple: el TUI

`agent-workflow` → tab **Project** → **Initialize as hub**. Form interactivo (nombre + paths + rama base, alias inferido de la carpeta) dentro del TUI. Sin flags ni comandos a mano.

## Flujo (host) — mínimo

1. **Detectar** vía `agent-workflow workspace-mode`. Si ya es hub → agregar/reiniciar. Si es `project` con fuentes → ofrecer promover. Bloque de una topología legacy → delegar a `/agent-workflow:migrate`.
2. **Reunir**: descripción (1 línea), ≥2 fuentes (alias + path), rama base (default `certificacion`). El alias se infiere de la carpeta si no se da.
3. **Escribir el bloque**:
   ```
   agent-workflow hub-init \
       --proyecto "<descripción>" \
       --fuente "alias1:path1" --fuente "alias2:path2" \
       [--working-branch "alias1:rama1" ...] [--main-branch <rama>]
   ```
   Rutas Windows (`C:\Source\...`) van directo. Escribe `CLAUDE.md` + `AGENTS.md`. **No toca `settings.json` / `config.toml`.**
4. **Reportar** fuentes registradas + próximo paso (`/agent-workflow:session "<objetivo>"`).

## Visibilidad multi-root (opt-in, aparte)

Solo si el usuario quiere que los hosts escriban en los repos fuente:

- `agent-workflow hub-init ... --attach`, o `agent-workflow attach-multiroot --from-sources` después.
- Per-workspace (gitignored, recomendado): `<hub>/.claude/settings.local.json` (`permissions.additionalDirectories`) + `<hub>/.codex/config.toml` (`additional_writable_roots` + `[projects.'<path>'] trust_level`).
- Diagnóstico: `agent-workflow visibility doctor --workspace .` (lee `settings.json` y `settings.local.json`).

## Argumentos

Sin argumentos: el host arma el flujo mínimo de arriba (o usá el TUI).

- `--proyecto "<texto>"`
- `--fuente "alias:path[:rama]"` — repetible (mín 2).
- `--working-branch "alias:rama"` — repetible.
- `--main-branch <rama>` — override del default `certificacion`.
- `--attach` — además del bloque, configura la visibilidad multi-root.

**Argumentos:** $ARGUMENTS

## Skill asociada

Ver `doctrine/hub-init/SKILL.md` para el flujo, la promoción project→hub y la visibilidad multi-root.
