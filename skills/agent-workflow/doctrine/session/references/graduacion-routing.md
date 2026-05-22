# Graduación: regla hub vs project (DEC-002)

Regla canónica para decidir **dónde** se gradúa un artefacto al cerrar una sesión qtc-*. Reemplaza la regla anterior "hub-vs-fuente con prompt M12".

## Regla absoluta

| `workspace_mode` | Destino de la graduación |
|---|---|
| `hub` | **Hub root** — `<hub>/.workflow/sessions/` y `<hub>/docs/<categoria>/`. **Nunca** se gradúa a fuente. |
| `project` | **CWD del proyecto** — `<cwd>/docs/<categoria>/` (raíz del proyecto único). |

**Sin prompt por sesión.** El destino se decide automáticamente leyendo `workspace_mode` del bloque AW-PROJECT en `CLAUDE.md` / `AGENTS.md`. Eliminado M12 (graduacion-destino).

## Definiciones operativas

- **`workspace_mode=hub`**: workspace con bloque `Mode: hub` en CLAUDE.md/AGENTS.md y `.workflow/` propio que coordina ≥2 fuentes (cada una con su propio repo + branch). Toda graduación va al hub.
- **`workspace_mode=project`**: workspace single-repo (sin `Mode: hub`). Toda graduación va al cwd.

## Kinds graduables (modelo nuevo, DEC-003)

Sólo 6 kinds graduan vía `agent-workflow graduate`. El resto vive en la sesión y no se gradúa.

| Kind | Destino | Disparado por |
|---|---|---|
| `decision` | `docs/decisiones/NNN-<slug>.md` | `agent-workflow graduate --kind decision` (al cerrar) |
| `manual` | `docs/manuales/NNN-<slug>.md` | `agent-workflow graduate --kind manual` (al cerrar) |
| `script` | `docs/scripts/NNN-sessionXXX-<slug>/` | **`/agent-workflow:release` exclusivamente** (no `graduate --kind script` directo) |
| `especificacion` | `docs/especificaciones/NNN-<slug>/` | `agent-workflow graduate --kind especificacion` (al cerrar) |
| `conclusion` | `docs/conclusiones/NNN-<slug>.md` | `agent-workflow graduate --kind conclusion` (al cerrar; opt-in — default es no graduar) |
| `release` | `docs/release/NNN-informe-release.md` | **`/agent-workflow:release` exclusivamente** |

Eliminados del modelo nuevo: `plan`, `refactor`, `design`, `design-system`, `propuesta`, `postmortem`, `analysis`. Estos artefactos:
- Se quedan en `.workflow/sessions/<folder>/` (no se gradúan).
- O se promueven manualmente a `manual` / `especificacion` si el usuario decide curarlos.

## Árbol de decisión

```
1. Leer workspace_mode del bloque AW-PROJECT (CLAUDE.md/AGENTS.md).
2. ¿workspace_mode == "hub"?
   ├─ SÍ  → destino = <hub>/docs/<categoria>/. Stop.
   └─ NO  → destino = <cwd>/docs/<categoria>/. Stop.
```

Sin prompts. Sin override. Sin breadcrumbs entre hub y fuente.

## Por qué se eliminó M12 y la regla hub-vs-fuente

- **Antes (≤v3.x)**: defaults por kind + prompt M12 cuando ambiguo + breadcrumbs en `000-INDEX.md`. Mucha lógica para decidir destino.
- **Ahora (DEC-002)**: el `workspace_mode` ya declara la intención del usuario al abrir el workspace. Hub mode → hub es deliverable; el usuario armó el hub para coordinar. Project mode → todo va al proyecto.
- **Consecuencia**: si una fuente quiere documentación propia, el usuario abre un workspace project con esa fuente como cwd. Si quiere documentación cross-fuente, abre el hub.

## `docs/referencias/` — no se gradúa (DEC-004 v2)

Material de referencia del usuario vive en una única carpeta transversal: `<workspace-root>/docs/referencias/` (hub root en hub mode, cwd root en single-repo). Cualquier formato (md, pdf, xlsx, png, txt, etc.). Cualquier sesión activa puede leerla on-demand sin tener que subirla por-sesión.

Reglas:
- **Único path canónico**: `docs/referencias/`. La carpeta legacy `.workflow/sessions/<folder>/referencias/` (DEC-004 v1) no se lee; queda como histórico inerte en sesiones cerradas. El rescate de contenido pasa por `agent-workflow:migrate` opt-in.
- **Manual del usuario**: el usuario coloca archivos ahí; el AI sólo lee si existe.
- **El AI no escribe en `docs/referencias/` salvo solicitud explícita** ("guardá esto en referencias", "agregá este wireframe a referencias").
- **Lazy**: la carpeta no se crea automáticamente; aparece cuando el usuario la inicializa (puede sembrar `docs/referencias/README.md` describiendo el contrato).
- **No se gradúa**: queda en `docs/referencias/`, fuera del flujo de graduación de las 6 kinds. Persiste mientras viva el workspace.

## Comando

```
agent-workflow graduate --kind <kind> --session <CODE> --slug <kebab>
```

El CLI internamente:
1. Lee `workspace_mode` desde el bloque AW-PROJECT.
2. Resuelve `docs_root`:
   - hub mode → `<hub-cwd>/docs/`.
   - project mode → `<cwd>/docs/`.
3. Numera con `next-number <docs_root>/<categoria>/`.
4. Mueve el artefacto desde `.workflow/sessions/<folder>/` al destino.

No requiere flags adicionales (`--destination`, `--source`, `--breadcrumb`). El destino es función pura de `workspace_mode + kind`.

## Validación posterior (doctor)

`agent-workflow doctor` puede verificar:
- En hub mode: que ningún `<fuente>/docs/<categoria>/` tenga artefactos graduados desde una sesión del hub (warn si los hay — son legacy).
- En project mode: que `<cwd>/docs/<categoria>/` tenga la numeración consistente.

---

**Origen**: session006-dev-modelo-artefactos-lifecycle (DEC-002, 2026-05-07). Reemplaza la versión basada en routing hub-vs-fuente con prompt M12.
