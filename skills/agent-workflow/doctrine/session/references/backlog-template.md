# Template — `BACKLOG.md` (artefacto opcional lazy de sesión)

Plantilla canónica del archivo en `.workflow/sessions/<folder>/BACKLOG.md`. Lazy: solo se crea si hay valor en preservar items pendientes al cierre.

## Cuándo crear

- ≥1 ítem abierto en TASKS.md al cierre.
- Usuario menciona items diferidos/descartados durante la sesión.
- Closure sin implementación (F-E.1) con followups derivados que no entran a la próxima sesión inmediata.

## Cuándo NO crear

- Sesión cerrada con TASKS.md 100% completas y sin followups explícitos.
- Usuario indica explícitamente "no hay backlog para esta sesión".
- BACKLOG vacío sería peor que su ausencia (no escribir secciones placeholder).

## Estructura

````markdown
# Backlog — session<NNN>-<flow>-<slug>

## Deferred

Items con valor pero fuera del alcance temporal de esta sesión.

- **D1**: <descripción accionable>. Razón: <out-of-scope/ETA-insuficiente/dependencia-X>. Sugerencia: <abrir sessionNNN-flow-slug>.
- **D2**: <descripción>. Razón: <...>.

## Discarded

Items evaluados y descartados, con razón explícita.

- **X1**: <descripción>. Razón: <no-aplica/contraproducente/redundante-con-Y>.
- **X2**: <descripción>. Razón: <...>.

## Followups

Acciones concretas para otras sesiones, con sugerencia de slug y dependencia.

- **F1**: <acción>. Sesión sugerida: `sessionNNN-<flow>-<slug>`. Dependencia: <ninguna|sessionYYY ok>. ETA: ≈<N>h.
- **F2**: <acción>. Sesión sugerida: ...

## Notas

- Append-only en práctica. No borrar entries; mover a `Discarded` con razón si cambia el contexto.
- Consumido por `/agent-workflow:export-plan` como "Tasks abiertas heredadas" del corpus.
- NO se gradúa al canon. Vive solo en `.workflow/sessions/<folder>/BACKLOG.md`.
````

## Ejemplo real (smoke)

````markdown
# Backlog — session055-analyze-docs-from-sessions

## Deferred

- **D1**: Implementar export-conclusions skill. Razón: scope inicial de session055 cerró en propuesta + 4 comandos (no 6). Sugerencia: abrir sessionNNN-dev-export-conclusions post-062.
- **D2**: Plan de deprecación Fase 2 (remover `/agent-workflow:release` legacy). Razón: requiere ≥1 mes de uso de la familia export-* nueva. Sugerencia: revisar Q3 2026.

## Discarded

- **X1**: Modelo "1 skill genérico de docs" (`docs-generator`). Razón: feedback explícito del usuario — prefiere responsabilidades separadas con naming `export-*`.

## Followups

- **F1**: Decisión meta sobre nuevos `kind`s (arquitectura, funcional, documentation) en modelo de graduación. Sesión sugerida: `sessionNNN-analyze-graduation-kinds-fase-2`. Dependencia: ≥1 mes de uso. ETA: ≈2h.
- **F2**: Validar contratos cross-host (Claude Code + Codex) para los 4 commands export-* nuevos. Sesión sugerida: `sessionNNN-dev-validacion-cross-host-export`. Dependencia: ninguna. ETA: ≈1h.
````

## Reglas de uso

- **Frontmatter**: NO usar. BACKLOG.md no requiere YAML; los IDs (`D1`, `X1`, `F1`) ya proveen estructura.
- **IDs**: prefijos `D` (Deferred), `X` (Discarded), `F` (Followups). Numerados secuencialmente por sección. Reutilizables si se mueve item entre secciones (mantener el prefijo del estado actual).
- **Idioma**: ES default (igual que otros artefactos del workspace).
- **Concisión**: 1-2 líneas por item; sin prosa extensa.
- **Razón obligatoria**: cada `D` y `X` debe declarar razón explícita. Sin razón → mejor no incluir.
- **Sesión sugerida en `F`**: best-effort. Si no hay slug claro, omitir y dejar solo la acción.

## Integración con otros artefactos

| Artefacto | Relación con BACKLOG.md |
|---|---|
| `TASKS.md` | Items `[ ]` no cerrados → candidatos a `Deferred` o `Followups`. |
| `CHECKPOINT.md` | NO duplicar. CHECKPOINT = estado para retomar; BACKLOG = pendiente para otras sesiones. |
| `CONCLUSIONS.md` | Si analyze produjo recomendations no incluidas en alcance → registrar como `Followups`. |
| `export-plan` | Lee BACKLOG.md de las N sesiones consolidadas como input adicional al plan derivado. |
| `export-conclusions` | NO consume BACKLOG (su input son CONCLUSIONS.md). |

## Reglas absolutas

- Lazy: no crear archivo vacío.
- Append-only: no borrar entries históricas.
- No graduar: BACKLOG queda en sesión.
- Mover entre secciones con `(antes: D1 en sessionXXX)` como nota para trazabilidad si aplica.
- Si una sesión retoma items de un BACKLOG previo → mencionarlo en `OBJECTIVE.md ## Origin` (no en BACKLOG).
