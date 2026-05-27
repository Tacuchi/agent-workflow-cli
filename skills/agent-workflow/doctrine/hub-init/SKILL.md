---
name: hub-init
description: Inicializa workspace Hub multi-repo — escribe el bloque AW-PROJECT en modo hub (≥2 fuentes con rutas y ramas) que activa heurísticas hub-aware en sessions/implement/release. Solo scaffold; la visibilidad multi-root es opt-in. La forma interactiva vive en el TUI (tab Project → Initialize as hub). Invocado vía /agent-workflow:hub-init.
version: 2.0.0
---

> **Profile parametrization**: lee `claude_md_block` de `profile.json` (cascade 5 capas). Ver [`references/profile-parametrization.md`](../../references/profile-parametrization.md).

# Hub Init

Escribe el bloque AW-PROJECT para un workspace **multi-repo** (hub mode). El marcador `Mode: hub` activa heurísticas hub-aware en el resto de la familia. **Es solo scaffold**: escribe el bloque y nada más. La visibilidad de hosts (que Claude Code / Codex puedan escribir en los repos fuente) es un paso aparte y **opt-in**.

## La vía fácil: el TUI

Lo más simple es el form interactivo: `agent-workflow` → tab **Project** → **Initialize as hub**. Pide nombre + paths de fuentes (alias inferido de la carpeta) + rama base, todo dentro del TUI. No hay que recordar flags ni armar comandos.

## Cuándo usar la vía CLI/host

- Workspace que coordina ≥2 repos pares.
- Promover un workspace `project` que creció a multi-repo.

## Flujo (host) — mínimo

No sobre-validar ni preguntar de más. El comando solo persiste lo declarado.

1. **Detectar bloque** (rápido): `agent-workflow workspace-mode` → `{mode, is_hub, ...}`. Si ya es hub → preguntar si agregar/reiniciar. Si es `project` con fuentes → ofrecer promover. Bloque legacy `<!-- QTC-WORKFLOW-START -->` → delegar a `/agent-workflow:migrate`.
2. **Reunir datos**: descripción (1 línea), ≥2 fuentes (alias + path), rama base (default `certificacion`). El alias se infiere del nombre de la carpeta si no se da.
3. **Escribir el bloque**:

   ```
   agent-workflow hub-init \
     --proyecto "<descripción>" \
     --fuente "alias1:path1" --fuente "alias2:path2" \
     [--working-branch "alias1:rama1" ...] \
     [--main-branch <rama>]
   ```

   Rutas Windows (`C:\Source\...`) van directo — el parser respeta el colon de unidad, no hace falta workaround. Escribe `CLAUDE.md` + `AGENTS.md` con `## Proyecto` (Mode: hub) + `## Fuentes` + `## Stack` + `## Status`. **No toca `settings.json` ni `config.toml`.**
4. **Reportar**: fuentes registradas + próximo paso (`/agent-workflow:session "<objetivo>"`).

## Visibilidad multi-root (opt-in, aparte)

Para que los hosts escriban en los repos fuente, configurá visibilidad — **solo si el usuario lo pide**:

- `agent-workflow hub-init ... --attach` — además del bloque, mergea los paths en `.claude/settings.json` + `.codex/config.toml` (con backup).
- o `agent-workflow attach-multiroot --from-sources` después.
- Convención por-máquina (gitignored): el usuario puede preferir `.claude/settings.local.json` + `.codex/config.toml`; snippets en `references/multiroot-manual.md`.

Diagnóstico: `agent-workflow visibility doctor --workspace .` (lee `settings.json` **y** `settings.local.json`). Legacy global contaminado: `visibility doctor --global` + `detach-multiroot --global --from-sources`.

## Flags

- `--attach` — opt-in: además del bloque, configura la visibilidad multi-root.
- `--main-branch <rama>` — override del default `certificacion`.
- `--workspace <DIR>` — override si el CWD no es la raíz del hub.
- `--dry-run` — previsualizar sin escribir.

## Reglas

- **Mínimo 2 fuentes**. Si quiere 1 → `/agent-workflow:project-init`.
- **Default = solo bloque**. La visibilidad no se configura salvo `--attach` o pedido explícito.
- **Idempotente**: re-ejecución con datos idénticos es no-op.
- **No tocar legacy QTC-WORKFLOW**: avisar y delegar a migrate.

## Política — sin fallback al CLI

Si `agent-workflow workspace-mode|hub-init|attach-multiroot|visibility` falla (no está en PATH, exit ≠ 0), **cortá la acción y reportá**: pedí verificar `npm install -g @tacuchi/agent-workflow-cli`. No hay flujo Python alterno.

## Sandbox read-only

`../session/references/sandbox-readonly-rules.md`. En plan mode describí: archivos a crear (`CLAUDE.md`, `AGENTS.md`; + `settings.json`/`config.toml` solo si `--attach`), y el bloque AW-PROJECT (fuentes + ramas + `Mode: hub`). NO ejecutar `hub-init` / `attach-multiroot` en plan mode.

## Recursos

- **`references/multiroot-manual.md`** — visibility manual / `settings.local.json`.
- **`/agent-workflow:project-init`** — equivalente single-repo.
