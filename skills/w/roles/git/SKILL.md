---
name: git
description: >-
  Git-safe capability — built-in default for the `git` role. Verifies the expected
  work branch per source before editing, proposes commits (one per source) and only
  commits when the user approves, and NEVER runs push, --amend, --no-verify, force,
  merge/rebase/cherry-pick, tags, or destructive resets without explicit user request.
  Read-only git (status/log/diff/branch) is always allowed. Use when a loop is about
  to edit code, when the user asks to commit / save / push changes, or to resolve an
  in-progress merge conflict (via /w:fix-git).
---

# git — git-safe capability

## Role

`git` — built-in default. Rebindable in `.workflow/skills.toml` (third-party skill or `off`). This skill encodes invariant 5: **git seguro**.

## Purpose

Operar git de forma **segura y controlada**: verificar la rama esperada antes de editar, **proponer** commits por fuente, y nunca ejecutar operaciones destructivas o de publicación sin pedido explícito del usuario.

## Composed by

- **`plan-exec-loop`** — verifica rama antes de cada edit; propone commits al cerrar/checkpoint.
- **`quick-loop`** — igual, en el atajo liviano.
- **`/w:fix-git`** (comando transversal) — compone la sección *Resolución de conflictos de merge* para resolver un merge en curso en cualquier repo.

(Cualquier flujo que edite código o que el usuario quiera commitear lo usa.)

## Knowledge

### Operaciones prohibidas sin solicitud explícita del usuario

Lista cerrada. La IA **nunca** las ejecuta por iniciativa propia:

- `git commit` (incluye `--amend`)
- `git push` (incluye `--force` / `-f`)
- `git merge` · `git rebase` · `git cherry-pick`
- `git tag` (crear o editar)
- `git reset --hard` · `git restore .` · `git checkout -- .` · `git clean -fd` · `git stash` (cuando hay trabajo sin commit)

Y **siempre** prohibido, aún cuando el usuario pida commit: `--no-verify` (respetar los hooks pre-commit), `--force`, trailers `Co-Authored-By`, firmas de modelo.

> **Excepción — merge en curso:** resolver los conflictos de un merge **ya iniciado** (MERGE_HEAD), o iniciado a pedido **explícito** del usuario vía `/w:fix-git`, **sí** está permitido (es solicitud explícita, no iniciativa propia) — ver *Resolución de conflictos de merge*.

### Operaciones read-only (siempre permitidas, sin preguntar)

`status` · `log` · `diff` · `branch --show-current` · `rev-parse` · `show`. `git checkout` (cambio de rama) **no** es read-only: requiere *structured-choice* (capacidad del arnés — ver `../../harness/SKILL.md`; en **Claude Code** es `AskUserQuestion`, máx 4 preguntas/llamada → **≤3 preguntas de contenido + 1 control `flow`**; sin elección estructurada degrada a **markdown numerado**) aunque no sea destructivo (ver verificación de rama).

### Verificación de rama (antes de editar)

La rama esperada **nunca se asume desde la rama actual** — el usuario pudo cambiarla a mano. Verificar contra la rama de trabajo declarada por fuente antes de cualquier `Write/Edit`.

Campos por fuente: `alias`, `path`, `main_branch` (base, default `certificacion`), `expected_work_branch`, `current_branch`, `match` (`current == expected`), `dirty` (cambios sin commit).

Casos:

- **`match=true`** → OK, editar.
- **`match=false, dirty=false`** (Caso A — rama distinta, repo limpio) → *structured-choice*: hacer `git checkout <expected>` / mantener current y actualizar la expectativa de la sesión / cancelar.
- **`match=false, dirty=true`** (Caso B — rama distinta + cambios sin commit) → **pausar y esperar resolución manual**. No proponer checkout (podría perder trabajo). Pedir al usuario commit/stash/discard y avisar cuando continuar.
- **Cross-fuente (hub)**: si las fuentes tocadas apuntan a ramas distintas sin declararlo, **hard gate** — bloquear avance con *structured-choice* (alinear todas / declarar divergencia explícita / cancelar).
- **HEAD detached** → tratar como Caso A.
- **Fuente fuera de git** (`is_repo=false`) → informar, no bloquear.

### Commits — propose-then-execute, una fuente a la vez

Ante cualquier pedido o disparo de commit (cierre de loop, "commitea esto", "guardá los cambios"):

1. Resolver las fuentes y su estado dirty/rama.
2. Si hay 1+ fuentes `dirty=true`, invocar **una sola** *structured-choice* con una pregunta de contenido por fuente dirty (máx 4 simultáneas → **≤3 preguntas de contenido + 1 control `flow`**; si N>3, en tandas):
   - Header de la pregunta: el `alias` de la fuente.
   - Opciones: "Aprobar sugerido (Recomendado)" con el mensaje canónico / "Saltar esta fuente". `Other` = mensaje custom.
3. Ejecutar `git -C <path> commit -m "<msg>"` solo en las fuentes aprobadas, **una a una**. Respetar hooks (sin `--no-verify`).
4. Si una fuente tiene `match=false` (rama distinta a la esperada): **omitirla y abortar su commit**; avisar para alinear la rama primero.
5. Si todas están `dirty=false` → skip silencioso, informar en chat que no hay nada que commitear.

**Bypass** (Regla 5): si el usuario aporta el mensaje literal exacto (`-m "..."`, comillas), commitear directo sin *structured-choice*, pero seguir validando rama, hooks y formato. Si el literal viola el formato, avisar antes de ejecutar.

### Formato canónico del mensaje

- **Una sola línea**, corta (≤72 chars sugerido), descriptiva (qué cambia, no cómo).
- Incluir el código de sesión activa (`session<NNN>` como tag o en el prefijo) cuando aplique.
- Prefijo Conventional Commits **opcional** (`feat:` `fix:` `docs:` `chore:` `refactor:` `test:`).
- **Prohibido**: multi-línea/body, trailers `Co-Authored-By`, firmas de modelo, emojis (salvo pedido explícito), `--no-verify`.

Válidos:
```
session007: agrega politica de commits controlados
feat(session012): nuevo export-scripts
fix(session018): corrige drift en hooks.json
```

Fuera de sesión activa: relajar a "1 línea + sin co-author"; el tag `session<NNN>` se omite. El propose-then-execute sigue activo.

### Resolución de conflictos de merge

`git merge` autónomo está prohibido (arriba), **pero** resolver un merge **ya en curso** (MERGE_HEAD) o invocado por el usuario vía `/w:fix-git` **sí** es trabajo sancionado. **Agnóstico al workspace**: opera sobre cualquier repo (no requiere `.workflow/`, flows ni sesiones).

1. **Detectar + identificar** con `aw merge-state [<path>|--source <alias>|--all]` (read-only): `is_merging`, `current_branch` (**destino / ours**), `merge_origin` (**origen / theirs**), `conflicted_files`. Si `merge_origin` viene vacío, mirar `.git/MERGE_MSG` o `git log --oneline -1 MERGE_HEAD`.
2. **Analizar la intención** de cada conflicto **antes** de resolver — nunca elegir un lado a ciegas:
   - Las tres versiones: `git show :1:<file>` (base) · `:2:<file>` (ours/destino) · `:3:<file>` (theirs/origen).
   - El porqué de cada lado: `git log --merge -p -- <file>`; el historial del hunk en cada rama.
   - El código alrededor del marcador (coherencia con el resto del archivo).
3. **Resolver** editando el archivo (quitar `<<<<<<<` / `=======` / `>>>>>>>`): elegir **ours**, **theirs**, **combinar** ambas intenciones, o **reescribir** para satisfacer las dos. `git add <file>` lo resuelto.
4. **Preguntar** (*structured-choice*) cuando la intención es **ambigua** o los dos lados son **incoherentes** entre sí (no combinables sin perder algo): una pregunta de contenido por archivo/hunk dudoso (≤3 + control `flow`), opciones "Ours (`<destino>`)" / "Theirs (`<origen>`)" / "Combinar" / "Editar manual". **No inventar** una resolución cuando hay duda real.
5. **Commit propuesto**: completar el merge es un `git commit` (el merge commit) → **propose-then-execute** como cualquier commit (formato canónico de arriba; fuera de sesión → 1 línea sin tag `session<NNN>`; nunca `--no-verify`/`--amend`/`push`). El hook `git-commit-advisor` lo gatea.
6. **Escape**: si el merge no debe completarse, `git merge --abort` **tras confirmación** del usuario (*structured-choice*) — deja el repo como antes del merge.

> **Resume por git**: el estado del merge en `.git` (MERGE_HEAD + índice) **es** el checkpoint; re-correr `/w:fix-git` reanuda desde los conflictos que queden. No hay session ni artefacto.
> **Rebase / cherry-pick**: fuera de v1 (misma resolución de markers; distinto `--continue` / `REBASE_HEAD`).

## Output

Ninguno en `docs/`. Produce commits **solo** cuando el usuario aprueba, en los repos fuente. La verificación de rama puede actualizar la expectativa de rama de la sesión si el usuario lo elige.

## Source

Reciclada de la doctrina vieja: `doctrine/session/references/commits-policy.md` (Reglas 1-5: propose-then-execute, formato canónico, bypass) + `doctrine/session/references/branch-verification.md` (Casos A/B/C, cross-fuente hard gate). Se descarta la dependencia de comandos CLI específicos (`agent-workflow sources`): la verificación se hace con git read-only directo más la rama de trabajo declarada por la sesión.
