---
name: hub-init
description: Inicializa workspace Hub multi-repo — escribe el bloque AW-PROJECT en modo hub (≥2 fuentes con rutas y ramas) y SIEMPRE configura la visibilidad multi-root (settings.local.json + config.toml, gitignored), reconciliando fuentes agregadas/removidas. Sin prompt. La forma interactiva vive en el TUI (tab Project → Initialize as hub). Invocado vía /agent-workflow:hub-init.
version: 2.1.0
---

> **Profile parametrization**: lee `claude_md_block` de `profile.json` (cascade 5 capas). Ver [`references/profile-parametrization.md`](../../references/profile-parametrization.md).

# Hub Init

Escribe el bloque AW-PROJECT para un workspace **multi-repo** (hub mode). El marcador `Mode: hub` activa heurísticas hub-aware en el resto de la familia. Además del bloque, **siempre** configura la visibilidad multi-root para que los hosts (Claude Code / Codex) vean los repos fuente — sin preguntar, en cada run.

## La vía fácil: el TUI

Lo más simple es el form interactivo: `agent-workflow` → tab **Project** → **Initialize as hub**. Pide nombre + paths de fuentes (alias inferido de la carpeta) + rama base, todo dentro del TUI. No hay que recordar flags.

## Cuándo usar la vía CLI/host

- Workspace que coordina ≥2 repos pares.
- Promover un workspace `project` que creció a multi-repo.
- Agregar o remover una fuente de un hub existente (re-correr con el set nuevo).

## Flujo (host) — mínimo

No sobre-validar ni preguntar de más. El comando persiste lo declarado y sincroniza la visibilidad solo.

1. **Detectar bloque** (rápido): `agent-workflow workspace-mode` → `{mode, is_hub, ...}`. Si ya es hub → preguntar si agregar/reiniciar. Si es `project` con fuentes → ofrecer promover. Bloque legacy `<!-- QTC-WORKFLOW-START -->` → delegar a `/agent-workflow:migrate`.
2. **Reunir datos**: descripción (1 línea), ≥2 fuentes (alias + path), rama base (default `certificacion`). El alias se infiere del nombre de la carpeta si no se da.
3. **Escribir + sincronizar** (un solo comando):

   ```
   agent-workflow hub-init \
     --proyecto "<descripción>" \
     --fuente "alias1:path1" --fuente "alias2:path2" \
     [--working-branch "alias1:rama1" ...] \
     [--main-branch <rama>]
   ```

   Rutas Windows (`C:\Source\...`) van directo — el parser respeta el colon de unidad. Escribe `CLAUDE.md` + `AGENTS.md` (`## Proyecto` Mode: hub + `## Fuentes` + `## Stack` + `## Status`) **y** configura la visibilidad multi-root (ver abajo). No hace falta un paso aparte.
4. **Reportar**: fuentes registradas, paths con visibilidad, y próximo paso (`/agent-workflow:session "<objetivo>"`).

## Visibilidad multi-root (automática, siempre)

`hub-init` configura la visibilidad en **cada** run, sin prompt:

- **Target gitignored**: `<hub>/.claude/settings.local.json` (`permissions.additionalDirectories`) + `<hub>/.codex/config.toml` (`additional_writable_roots` + `[projects.'<path>'] trust_level`). Las rutas son absolutas/machine-specific, así que van en archivos per-máquina; `hub-init` también asegura el `.gitignore`.
- **Reconcile**: attachea las fuentes actuales y detachea las que estaban en el bloque previo y ya no (agregar/remover quedan sincronizados).
- Diagnóstico: `agent-workflow visibility doctor --workspace .` (lee `settings.json` **y** `settings.local.json`). Legacy global contaminado: `visibility doctor --global` + `detach-multiroot --global --from-sources`.

## Flags

- `--main-branch <rama>` — override del default `certificacion`.
- `--workspace <DIR>` — override si el CWD no es la raíz del hub.
- `--dry-run` — previsualizar sin escribir (bloque + paths que se attachearían).

## Reglas

- **Mínimo 2 fuentes**. Si quiere 1 → `/agent-workflow:project-init`.
- **Set autoritativo**: el `--fuente` declarado **reemplaza** el bloque (no merge). Para agregar/remover fuentes, pasá el set completo deseado (el form del TUI ya lo hace; por CLI, leé las fuentes actuales con `workspace-mode` y pasá el set final). `hub-init` reconcilia la visibilidad: detacha las removidas, attacha las actuales.
- **Visibilidad siempre**: se configura sola, sin preguntar, en init y en cualquier cambio de fuentes. No hay opt-out (salvo `--dry-run`, que no escribe nada).
- **Idempotente**: re-ejecución con datos idénticos es no-op (attach ya presente, sin cambios).
- **No tocar legacy QTC-WORKFLOW**: avisar y delegar a migrate.

## Política — sin fallback al CLI

Si `agent-workflow workspace-mode|hub-init|attach-multiroot|visibility` falla (no está en PATH, exit ≠ 0), **cortá la acción y reportá**: pedí verificar `npm install -g @tacuchi/agent-workflow-cli`. No hay flujo Python alterno.

## Sandbox read-only

`../session/references/sandbox-readonly-rules.md`. En plan mode describí: archivos a crear (`CLAUDE.md`, `AGENTS.md`, `.claude/settings.local.json`, `.codex/config.toml`, `.gitignore`) y el bloque AW-PROJECT (fuentes + ramas + `Mode: hub`). NO ejecutar `hub-init` / `attach-multiroot` en plan mode.

## Recursos

- **`references/multiroot-manual.md`** — detalle de la visibility / formato de cada archivo.
- **`/agent-workflow:project-init`** — equivalente single-repo.
