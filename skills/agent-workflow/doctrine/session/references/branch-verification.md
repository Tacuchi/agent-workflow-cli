# Verificación de rama de trabajo — Referencia canónica (agent-workflow)

> Documento canónico de la familia qtc-* para validación y orquestación de ramas. Referenciado por `skills/session/SKILL.md` y el hook PreToolUse (`agent-workflow hook branch-check`). Los flow plugins (qtc-dev, qtc-design, qtc-analyze) **no duplican** este flujo — apuntan acá.

## Contexto

Las **fuentes del workspace** (alias, path, rama principal) se declaran una sola vez en el bloque `AW-PROJECT` de `CLAUDE.md` y `AGENTS.md` (sección `Fuentes`). Cada sesión activa declara su **rama de trabajo por fuente** en `Status → Sesiones activas`. El sub-comando `agent-workflow sources` resuelve ambas, las contrasta con el git status real y devuelve un payload uniforme.

Campos relevantes por fuente:
- `alias` — nombre corto (ej: `core`, `dev`, `api`, `web`).
- `path` — ruta local al repo de esa fuente.
- `main_branch` — base de la cual sale y hacia la cual vuelve la rama de trabajo (default `certificacion`).
- `expected_work_branch` — rama esperada según resolución (sesión > working_branches > main_branch para analyze).
- `current_branch` — rama actual del repo (live).
- `match` — `current_branch == expected_work_branch`.
- `dirty` — hay archivos modificados sin commit (`git status --porcelain`).

**Regla fundamental**: la rama esperada **nunca se asume desde la rama actual**. El usuario puede haber cambiado de rama manualmente para revisar otras cosas; el agente verifica antes de cualquier acción.

## Cuándo se ejecuta el check

| Momento | Comando | Quién dispara |
|---|---|---|
| 1. Crear sesión | `agent-workflow sources [--session NNN] [--flow F]` | `agent-workflow/skills/session/SKILL.md` paso 6 |
| 2. Retomar sesión | igual | `skills/session/SKILL.md` paso retomar |
| 3. Entrar a fase execution | igual | `skills/session/SKILL.md` fase 2 |
| 4. PreToolUse Edit/Write/MultiEdit/NotebookEdit | `agent-workflow check-branch --file <path> --strict` | `agent-workflow hook branch-check` (hook) |

## Estructura del output de `agent-workflow sources`

```json
{
  "workspace_mode": "hub",
  "is_hub": true,
  "session_code": "003",
  "scope": null,
  "sources": [
    {
      "alias": "core",
      "path": "/Users/x/Git/agent-workflow",
      "main_branch": "certificacion",
      "expected_work_branch": "certificacion",
      "current_branch": "certificacion",
      "match": true,
      "dirty": false,
      "changed_files": [],
      "is_repo": true,
      "error": null
    }
  ],
  "session_branches": ["core:certificacion", "dev:certificacion"],
  "working_branches_from_status": {"core": "certificacion", "dev": "certificacion"},
  "cross_source_consistent": true,
  "divergent_sources": []
}
```

Interpretación por fuente:
- `match: true` → todo OK.
- `match: false` + `dirty: false` → rama distinta, repo limpio. Aplicar **Caso A**.
- `match: false` + `dirty: true` → rama distinta y cambios sin commit. Aplicar **Caso B**.
- Para `flow=analyze` con cambios decididos a mitad de sesión → **Caso C** (no se manifiesta en el output; lo dispara el usuario al pedir editar).

Interpretación cross-fuente (hub mode):
- `cross_source_consistent: false` → hard gate (Cross-fuente abajo).

## Caso A — repo limpio, rama distinta (`match=false, dirty=false`)

El agente informa la divergencia y **pide confirmación** vía `AskUserQuestion`. Spec literal (header `branch:<alias>`, 3 opciones) → `prompts-catalog.md#M2`. Resumen:

```
La fuente `core` (~/Git/agent-workflow) está en `main` pero la rama
de trabajo es `certificacion`. ¿Hago `git checkout certificacion`?
```

Opciones:
- **Sí, hacer checkout** → ejecutar `git -C <path> checkout <expected>` y reintentar la acción original.
- **Mantener current y actualizar la sesión** → invocar `agent-workflow project-md-upsert --update-phase <folder> --branches <alias>:<current>` para registrar la nueva expectativa, luego avanzar.
- **Cancelar** → abortar la acción que disparó el check.

## Caso B — repo dirty, rama distinta (`match=false, dirty=true`)

El agente **pausa y espera resolución manual** del usuario. NO propone checkout porque podría perder trabajo:

```
La fuente `core` está en `main` (esperada `certificacion`) con cambios sin
commit en:
  - skills/session/SKILL.md
  - hooks/hooks.json
No voy a cambiar de rama porque podrías perder trabajo.
Resolvé manualmente (commit / stash / discard) y avisame cuando continúo.
```

Cuando el usuario indica "listo" / "continúa" / equivalente:
1. Re-ejecutar `agent-workflow check-branch --source <alias>`.
2. Si ahora `dirty=false` → aplicar Caso A.
3. Si sigue `dirty=true` → informar y esperar de nuevo.

**Prohibido sin confirmación explícita del usuario** (bajo ningún atajo):
- `git stash`
- `git reset --hard`
- `git checkout -- .`
- `git restore .`
- `git clean -fd`

Estas operaciones son destructivas y no autorizadas por el lifecycle.

## Caso C — flow=analyze + edición decidida

Las sesiones `flow=analyze` resuelven `expected_work_branch = main_branch` (default `certificacion`) cuando no se declaran `--branches` explícitamente al crear la sesión. La intención: **leer producción**, no editarla.

Si durante la investigación el usuario decide hacer cambios en código, ejecutar **2 prompts encadenados**. Spec literal (headers `work-branch` → `checkout` o `branch-new`) → `prompts-catalog.md#M3`. Resumen:

1. El agente avisa: "vamos a salir de modo lectura → necesitamos la rama de trabajo".
2. **Prompt 1** — pedir nombre de rama de trabajo (sugerencia por defecto: `feature/sessionNNN-<slug>`); el `Other` auto cubre nombres alternativos.
3. **Prompt 2** — verifica con `git -C <path> rev-parse --verify <work_branch>`:
   - **Si la rama existe** → `AskUserQuestion`: "¿Hago `git checkout <work_branch>`?" (header `checkout`).
   - **Si no existe** → `AskUserQuestion`: "Crear `<work_branch>` desde `<main_branch>`? (`git checkout -b <work_branch> <main_branch>`)" (header `branch-new`).
4. Sólo con confirmación explícita, ejecutar el comando.
5. Registrar la nueva rama en AW-PROJECT.Status → la sesión vía `project-md-upsert --update-phase <folder> --branches <alias>:<work_branch>`.
6. Continuar con la edición.

El usuario también puede declarar `--branches alias:rama` al crear la sesión analyze; ese override gana sobre el default `main_branch`. Caso C sólo aplica cuando la sesión arrancó en modo lectura (sin branches declaradas).

## Cross-fuente (hub mode) — hard gate

En workspaces `Mode: hub`, la convención es que **todas las fuentes tocadas por una sesión comparten la misma rama de trabajo** (la "rama de la sesión"). Divergencias deben ser declaradas explícitamente al crear la sesión.

`cmd_sources` consolida y devuelve:
- `cross_source_consistent: bool` — true si todas las fuentes con `expected_work_branch` declarada apuntan a la misma rama.
- `divergent_sources: [{alias, current, expected}]` — fuentes que difieren del consenso.

**Si `cross_source_consistent=false`**, el agente bloquea avance con `AskUserQuestion`. Spec literal (header `cross-branch`, 3 opciones, preview ASCII opcional con la matriz divergente) → `prompts-catalog.md#M4`. Resumen:

```
Las fuentes en este workspace apuntan a ramas distintas:
  - core:        actual=certificacion   esperada=certificacion
  - dev:         actual=feature/foo     esperada=certificacion
  - analyze:     actual=feature/foo     esperada=certificacion

Esperaba que todas compartan rama. ¿Cómo resolvemos?
```

Opciones:
- **Alinear todas a una misma rama** → dispara prompt anidado para elegir cuál rama (current consensus / expected / otra vía Other) y aplica Caso A por fuente divergente.
- **Declarar divergencia explícita** → re-crear la sesión con `--branches alias:rama` distintos; o actualizar la activa con `project-md-upsert --update-phase <folder> --branches "alias1:rama1,alias2:rama2"`.
- **Cancelar acción** → abortar y dejar al usuario decidir manualmente.

No avanzar a planning/execution hasta que `cross_source_consistent=true` o el usuario haya declarado explícitamente la divergencia.

## Casos especiales

| Situación | Estado | Acción |
|---|---|---|
| Fuente fuera de git | `is_repo: false` | Informar al usuario, no bloquear. No participa en cross-fuente. |
| HEAD detached | `current_branch == "HEAD"` | Tratar como mismatch limpio (Caso A) — proponer checkout a expected. |
| Path inexistente | `error` poblado | Alertar — fuente desactualizada en AW-PROJECT. Sugerir `agent-workflow:project-init` para corregir. |
| Archivo fuera de cualquier fuente | hook devuelve `reason: file_not_in_managed_source` | El hook no bloquea; el SKILL no incluye la fuente en validación. |
| Múltiples sesiones activas | `_resolve_session_branches` toma la primera | Pasar `--session CODE` explícito si se necesita otra. |
| Sesión sin `--branches` declarada (no-analyze) | `expected_work_branch` cae a `working_branches_from_status` | Si tampoco hay working_branches, `expected_work_branch=null` y no se valida. |
| Sesión analyze sin `--branches` | `expected_work_branch = main_branch` | Default Caso C-aware; el SKILL trata edición como Caso C. |

## Integración con el hook PreToolUse

`agent-workflow hook branch-check` (invocado desde `hooks/hooks.json` y `codex-hooks/hooks.json`):

1. Lee `tool_input.file_path` del stdin JSON (`Edit | Write | MultiEdit | NotebookEdit`).
2. Resuelve la fuente dueña validando el path contra `Fuentes` del bloque AW-PROJECT (hub-aware).
3. Resuelve flow desde la sesión activa.
4. Calcula `expected_work_branch` combinando session branches + working branches + main_branch.
5. Si match → exit 0 (allow).
6. Si mismatch → exit 2 (block) con stderr formateado por Caso A o B.

El stderr siempre apunta acá (`skills/session/references/branch-verification.md`) para que el AI sepa cómo proceder.

## Comandos útiles

```bash
# Visión global del workspace
agent-workflow sources

# Foco en una sesión y subset de fuentes
agent-workflow sources --session 003 --scope core,dev,analyze

# Override flow (ej: probar comportamiento analyze en una sesión dev)
agent-workflow sources --flow analyze

# Validación atómica de UNA fuente (uso del hook)
agent-workflow check-branch --source core --strict
agent-workflow check-branch --file /path/to/file.py --strict
```

## Referencias

- `agent-workflow/src/lib/sources.ts` — implementación (`checkSourceBranch`, `expectedWorkBranch`, `resolveSessionFlow`, `cmdSources`, `cmdCheckBranch`).
- `agent-workflow hook branch-check` — comando hook PreToolUse universal.
- `skills/session/SKILL.md` — orquestación del check en el lifecycle.
- `docs/shared-contract.md §27` — contrato de promoción del check al agent-workflow.
