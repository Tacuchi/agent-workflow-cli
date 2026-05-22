# M1 — commit-prompt universal (CASO ANCLA)

Spec literal del prompt M1. Index: [`../prompts-catalog.md#m1--commit-prompt-universal--caso-ancla`](../prompts-catalog.md#m1--commit-prompt-universal--caso-ancla).

> **Nota de filename**: el archivo se llama `M1-closure-commit-prompt.md` por origen histórico (M1 nació en closure de `/agent-workflow:session`). El alcance canónico **ya no es exclusivo del closure**: ver `commits-policy.md` Regla 3 (universal). El nombre se conserva para no romper anchors ni cross-refs (DD-2 de session075).

## Cuándo se dispara

El AI invoca M1 ante **cualquiera** de estos 3 disparadores canónicos. La condición común: el usuario quiere/menciona un commit como acción a ejecutar y no aporta el mensaje literal en la solicitud (si lo aporta, ver Edge cases — Regla 5 bypass).

1. **Closure de `/agent-workflow:session`** (auto): antes de `session-close`, el skill `session` ejecuta `agent-workflow sources --session <CODE>` y dispara M1 si hay 1+ fuentes `dirty=true`. Documentado en `skills/session/SKILL.md` §"Cerrar sesión — 2. Proponer commits".
2. **Solicitud explícita con sesión activa** (planning/execution): el usuario dice "commitea esto", "guardá los cambios", "subí lo nuevo" sin mensaje literal. El AI ejecuta `agent-workflow sources --session <CODE>` y dispara M1 igual que en closure. El mensaje sugerido incluye tag `session<NNN>`.
3. **Solicitud explícita sin sesión activa**: el usuario pide commit en una fuente agent-workflow (hub o project) que no tiene sesión registrada en `AW-PROJECT.Status.Sesiones activas`. El AI ejecuta `agent-workflow sources` (sin `--session`) y dispara M1. El mensaje sugerido **omite** el tag `session<NNN>`.

## Forma

- **1 invocación** con N questions tab-por-fuente (N = #fuentes-dirty, max 4 simultáneas).
- En project mode con 1 fuente → N=1 question.
- En hub mode con N fuentes dirty (típico 1-3) → N questions tab-por-fuente.
- Por question:
  - `header`: `<alias>` puro (ej. `core`, `dev`, `design`, `analyze`, `marketplace`).
  - `question`: "¿Cómo commiteás los cambios en `<alias>`?"
  - `multiSelect`: false.
  - `options`:
    1. `label`: "Aprobar sugerido (Recomendado)" — `description`: el mensaje canónico siguiendo `commits-policy.md` Regla 2 (1 línea, ≤72 chars, tag `session<CODE>` si hay sesión activa, sin co-author).
    2. `label`: "Saltar esta fuente" — `description`: "No commitear ahora; los archivos quedan dirty para una decisión posterior."
  - **Other auto-inyectado** = el usuario escribe el mensaje custom. Se ejecuta el commit con ese mensaje (validando Regla 2 — ver Edge cases).
- **Si N > 4 fuentes dirty** (caso excepcional): ejecutar en tandas. Primera tanda cubre fuentes 1-4, segunda 5+. Registrar parcial en `CHECKPOINT.md` (si hay sesión activa) o avisar al usuario por chat entre tandas.
- **Si fuente tiene `match=false`**: omitir esa fuente del prompt (abortar commit ahí, avisar al usuario y dejar que alinee la rama primero — coherente con `commits-policy.md` Regla 3 paso 4).
- **Si N=0** (todas las fuentes limpias): skip silencioso, no invocar `AskUserQuestion`. Avisar al usuario: "No hay nada que commitear; todas las fuentes están limpias."

## Edge cases

### Bypass por mensaje literal (Regla 5 de commits-policy)

Si el usuario aporta el mensaje exacto en la solicitud (`"commitea con mensaje 'X'"`, `"commit -m 'X'"`, `"--message <X>"`), el AI ejecuta `git commit -m "<X>"` directo, sin invocar M1. El bypass aplica por fuente (el usuario puede aportar mensaje literal sólo para 1 fuente; las demás dirty siguen el flujo M1 normal).

Si el mensaje literal viola Regla 2 (multi-línea, co-author, etc.), el AI avisa antes de ejecutar y pide confirmación. No reescribe silenciosamente.

### Workspace no agent-workflow (sin AW-PROJECT)

`agent-workflow sources` falla → no hay fuentes que enumerar. El AI cae al flujo simple: sugiere 1-line msg en chat, espera confirmación, ejecuta. No invoca M1.

### Workspace hub con cambios en el workspace mismo (no en fuentes declaradas)

El AI **no** los commitea por iniciativa. M1 sólo opera sobre las fuentes declaradas en `AW-PROJECT.Fuentes`. Cambios en `.workflow/HISTORY.md`, `CLAUDE.md`, `AGENTS.md` o sesiones del hub workspace no entran al prompt salvo solicitud explícita del usuario.

### Single source en hub mode (caso transitorio)

Aunque el workspace sea hub, si sólo 1 fuente tiene `dirty=true` el prompt es N=1 question. Sigue siendo M1 (la spec no asume "≥2 questions"). Reduce ruido visual y mantiene la UX consistente con project mode.

## Ejemplo concreto — closure con 2 fuentes dirty

```
AskUserQuestion({
  questions: [
    {
      header: "core",
      question: "¿Cómo commiteás los cambios en `core`?",
      multiSelect: false,
      options: [
        { label: "Aprobar sugerido (Recomendado)",
          description: "session010: agrega prompts-catalog y refactor closure tab-por-fuente" },
        { label: "Saltar esta fuente",
          description: "No commitear ahora; los archivos quedan dirty para una decisión posterior." }
      ]
    },
    {
      header: "analyze",
      question: "¿Cómo commiteás los cambios en `analyze`?",
      multiSelect: false,
      options: [
        { label: "Aprobar sugerido (Recomendado)",
          description: "session010: M5 modalidad analyze con AskUserQuestion explícito" },
        { label: "Saltar esta fuente",
          description: "No commitear ahora; los archivos quedan dirty para una decisión posterior." }
      ]
    }
  ]
})
```

## Ejemplo concreto — solicitud explícita sin sesión activa

Usuario: "commitea los cambios que hay en agent-workflow".

```
AskUserQuestion({
  questions: [
    {
      header: "agent-workflow",
      question: "¿Cómo commiteás los cambios en `agent-workflow`?",
      multiSelect: false,
      options: [
        { label: "Aprobar sugerido (Recomendado)",
          description: "fix: drift en hooks.json del CLI"  // sin tag session<NNN>
        },
        { label: "Saltar esta fuente",
          description: "No commitear ahora; los archivos quedan dirty para una decisión posterior." }
      ]
    }
  ]
})
```
