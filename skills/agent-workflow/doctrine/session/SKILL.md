---
name: session
description: Lifecycle universal de sesiones agent-workflow en 4 fases (planning/execution/validation/closure). Crea, retoma, lista o cierra sesiones componiendo skills de especialidad según el flow elegido (dev/design/analyze). Auto-plan antes de editar código. Topic-change detection en execution. Closure propone commits por fuente afectada (propose-then-execute). Invocado solo vía /agent-workflow:session.
version: 4.3.0
---

# Session — Lifecycle universal agent-workflow v3.0

Skill **único** y **universal** para el ciclo de vida de sesiones de toda la familia agent-workflow. Vive en agent-workflow; los flow plugins son especialistas standalone vía `/agent-workflow:use` y declaran su comportamiento como workflow consumido por este skill.

## Cuándo se invoca

- `/agent-workflow:session [create|resume|close|list] [args]` — entry point **único** del lifecycle.

Los flows (`dev`, `design`, `analyze`) son agrupaciones de skills de especialidad **dentro de `agent-workflow`** — no son repos/plugins separados desde la consolidación de v2.0.0. El único entry point del lifecycle es `/agent-workflow:session`; las especialidades se invocan internamente por composición.

## Resolución de intención

Evaluar `$ARGUMENTS`:

1. `close` → flujo de cierre.
2. `list` → flujo de listado.
3. Matchea `sessionXXX` o `XXX` (3 dígitos) → retomar.
4. Texto descriptivo → crear.
5. Sin args:
   - Sin sesiones activas → preguntar y crear.
   - Una activa → retomar automático.
   - ≥2 activas → disparar `AskUserQuestion` con spec de S4 (`references/prompts-catalog.md#S4`). Header `resume`, ≤4 opciones (top-3 sesiones por última actividad + "Abrir nueva"). Other auto = nombre de sesión custom. Preview opcional con tabla `code · phase · last-activity · open-tasks`. NO narrar la pregunta en texto plano.

Una sesión está **activa** si aparece en `AW-PROJECT.Status.Sesiones activas`.

## Crear nueva sesión

### 1. Verificar AW-PROJECT

```
agent-workflow project-md-upsert --read
```

Si falta → proponer `/agent-workflow:project-init` (single-repo) o `/agent-workflow:hub-init` (multi-repo) y detener.

### 2. Detectar flow

Resolver el flow desde el texto del comando o del OBJECTIVE.md:

1. **Heurística por keywords**:
   - `implementar`/`refactor`/`bugfix`/`SQL`/`endpoint`/`API`/`script` → flow=`dev`.
   - `mockup`/`UI`/`UX`/`pantalla`/`wireframe`/`spec`/`flujo de pantalla` → flow=`design`.
   - `investigar`/`propuesta`/`post-mortem`/`auditar`/`analizar`/`evidencia` → flow=`analyze`.
2. **Fallback S3** (si la heurística no resuelve o el texto es ambiguo): disparar `AskUserQuestion` con spec de S3 (`references/prompts-catalog.md#S3`). Header `flow`, 4 opciones (dev/design/analyze/no estoy seguro). NO narrar la pregunta en texto plano.
3. **Override explícito**: si el usuario pasa `--flow <dev|design|analyze>` en `$ARGUMENTS`, usarlo directamente y saltar heurística/S3.

### 3. Cargar workflow del flow

```
agent-workflow workflows --flow <flow>
```

Output: `session_args` (ej. `--tipo`/`--modalidad`), `artifacts_by_phase`, `skills_by_phase`, `refs_format`, `resume_counters`.

### 4. Capturar OBJECTIVE + args + handoff opcional + plan opcional

- Slug kebab-case (≤4 palabras), brief, criterios de aceptación, ramas por fuente.
- Args declarados en `session_args` del workflow.
- Handoff opcional `--from <flow>:<code>`: precarga `## Origin` en OBJECTIVE + tag `origen:` en HISTORY refs.
- **Plan opcional `--from-plan <NNN|path>` (F-E.3)**: si el usuario arranca desde un plan generado por `/agent-workflow:export-plan`:
  - Acepta NNN (busca en `<docs>/planes/NNN-*.md`) o path absoluto/relativo.
  - Lee frontmatter YAML + `## Resumen` del plan. Si `--objetivo` está vacío, lo deriva del Resumen.
  - Append a OBJECTIVE.md: `## Origin (plan)` con referencia al plan y `sessions:` del frontmatter.
  - Transición del plan: si `state == draft` → `active` con entry append-only en `state_changes[]` (canon en `agent-workflow/skills/export-plan/references/state-transitions.md`).
  - Idempotente: si `state == active`, no-op silencioso.
  - Errores claros: `PLAN_NOT_FOUND`, `PLAN_ARCHIVED`, `PLAN_INVALID_FRONTMATTER`.
  - Si el plan está en `state: done`: ejecutar igualmente (caller puede querer abrir sesión follow-up); no transitiona automáticamente.
- **Tasks heredadas**: el AI puede leer manualmente la tabla `## Tasks` del plan y trasladarla a TASKS.md de la sesión nueva como base. Esta extracción NO la hace el CLI; queda al AI siguiendo la doctrina del skill.

### 5. Crear

```
agent-workflow session-create --flow <flow> --name <slug> --objetivo "<texto>" --branches alias:rama,…
# opcionalmente:
agent-workflow session-create --flow <flow> --name <slug> --from-plan <NNN|path> --branches alias:rama,…
```

Crea `.workflow/sessions/sessionNNN-<flow>-<slug>/`, escribe OBJECTIVE.md (legacy ES: OBJETIVO.md), agrega fila `active` en HISTORY, registra en AW-PROJECT.Status. Si se pasó `--from-plan`, el output incluye `plan_transition: {plan, from, to}` para trazabilidad.

### 6. Verificar ramas (proactivo, gate de avance)

Aplicar el **bloque común de verificación** descrito abajo en "Verificación interactiva de ramas". El AI **debe** presentar conflictos al usuario y esperar decisión antes de avanzar a fase planning. Sin confirmación explícita, no se ejecuta ningún `git checkout / stash / reset`.

### 7. Entrar a fase planning

## Las 4 fases

```
planning → execution → validation → closure
   ↑           ↓
   └───────────┘
```

| Fase | Qué pasa | Skills típicas | Artefactos |
|---|---|---|---|
| **planning** | OBJECTIVE + TASKS. Auto-plan decide skip/lite/full. | `analyze-synthesize`, opcional `design-brief` | OBJECTIVE.md, TASKS.md |
| **execution** | El trabajo. AI compone especialidades. Topic-change detection. | `implement` + `coding-standards` + `sql-script-organizer` + `analyze-investigate` + `design-deliver` | DECISIONS.md, scripts/, DELIVERY.md, EVIDENCE.md, FINDINGS.md, CONCLUSIONS.md |
| **validation** | Verifica criterios. Tests si aplica. | `testing-strategy`, `coding-standards` review | logs, marcado en TASKS |
| **closure** | Graduate (6 kinds) + compact automático. | `compact` (auto-disparado) | docs/decisiones/, docs/manuales/, docs/especificaciones/, docs/scripts/, docs/conclusiones/, docs/release/ + CHECKPOINT.md |

### Fase 1 — planning

**Regla obligatoria**: no editar código antes de TASKS.md, salvo OBJECTIVE trivialmente atómico.

#### Auto-plan trigger

```
agent-workflow auto-plan-decide --objetivo-file .workflow/sessions/<folder>/OBJECTIVE.md
```

Output: `{decision: "skip"|"lite"|"full", reason, signals, metrics}`. El AI puede override con justificación.

**Trigger de S6 — scope advisory**: si `decision = "full"` y `metrics.eta_hours > 4`, disparar `AskUserQuestion` con spec de S6 (`references/prompts-catalog.md#S6`). Header `scope`, 3 opciones (Lite primero con 3 tasks core / Full / Split en 2 sesiones). La elección moldea cómo `analyze-synthesize` genera TASKS.md después: Lite → 3 tasks; Full → plan completo; Split → re-crear sessionA + sessionB con dependencia explícita. **Si `tasks_count ≤ 3` ya en el OBJECTIVE**: skip S6 (scope ya es lite). NO narrar la pregunta en texto plano.

#### Plan agent + Specialty (suggestion-only)

**Gate por harness**: antes de proponer Plan subagent o sub-agente per-flow, ejecutar `agent-workflow harness` y validar `supports_plan_subagent: true`. Si false (Codex/Copilot/unknown), saltar al fallback descrito en `references/lifecycle-deep.md` (redactar TASKS.md directamente o usar `specialty-choose` para sugerencias inline). Aplica también a `Task(subagent_type="<flow>-agent")` opt-in.

Para detalles de Plan subagent nativo (CC `Task(subagent_type="Plan")`), prompt completo, trade-offs y persistencia: ver `references/lifecycle-deep.md`.

```
agent-workflow specialty-choose --phase planning --objetivo-file .workflow/sessions/<folder>/OBJECTIVE.md
```

Devuelve `{suggestions, rationale, invoke_explicitly: true}`. **Mostrar** sugerencias al usuario, **esperar confirmación**, **invocar sólo las confirmadas** vía namespace explícito (`Skill(agent-workflow:analyze-synthesize)`; legacy `qtc-analyze:analyze-synthesize` válido durante convivencia Strangler Fig). Nunca auto-invocar.

#### Datos estructurados de la sesión (token-optimized v3.4+)

```
agent-workflow objetivo-data --code <CODE>          # tipo, modalidad, criterios, fuentes, origen
agent-workflow tasks-data --code <CODE> [--only-open]  # counts + items + next_open
agent-workflow decisiones-list --code <CODE>        # DEC-NNN headers + previews
agent-workflow session-artifacts --code <CODE>      # dump consolidado
```

Usar estos antes de leer archivos completos.

#### Cierre de planning (DESIGN.md + S7 + next-step prompt)

Al cerrar planning (TASKS.md producido + auto-plan resuelto + ramas verificadas), pipeline canónico **antes** de iniciar el loop de `execution`:

1. **DESIGN.md + S7** — sólo si `flow=dev` y `## Type ∈ {feature, refactor}` (resuelto vía Capa 1/2/3 — ver `dev-workflow/SKILL.md` §"Resolución del `## Type`"):
   - Si `DESIGN.md` no existe: el AI produce un draft completo desde OBJECTIVE+TASKS siguiendo `implement/references/design-md-template.md`. Headers EN canon (`## Context`, `## Goals`, etc.), body en idioma del usuario. Sección `## Open questions` obligatoria (escribir `None` si vacía).
   - Disparar **`AskUserQuestion`** con spec de S7 (`references/prompts-catalog.md#S7`). Header `design-review`, 3 opciones (Sí lo reviso / Approve as-is / Refinar antes) + Other auto = feedback puntual con re-disparo. Preview ASCII opcional. NUNCA narrar la pregunta en texto plano.
   - **Confirmación obligatoria**: el gate no avanza a M10 hasta señal explícita. Opción 3 ("Refinar antes") y Other auto iteran el DESIGN.md y re-disparan S7 hasta confirmación 1 o 2.
   - **Skip silencioso** para `## Type: bugfix|chore`: no se produce DESIGN.md, no dispara S7. La doctrina bugfix (3 pasos canónicos en `implement/SKILL.md`) no requiere design artifact upfront.

2. **M10 — next-step**: tras DESIGN.md/S7 (o tras planning si tipo bugfix/chore), disparar `AskUserQuestion` con spec de M10 (`references/prompts-catalog.md#M10`). Header `next-step`, 3 opciones (Ejecutar end-to-end / T1+T2 en paralelo / Una task por vez). **Recomendación dinámica**: el AI marca `(Recomendado)` en opción 1 si `tasks_count ≤5 ∧ eta_total ≤4h` (estimas TASKS.md S=0.5h/M=2h/L=4h); caso contrario marca opción 2. NO narrar la pregunta en texto plano.

**Si TASKS.md está vacío o ausente** (auto-plan retornó `skip` y el OBJECTIVE es trivialmente atómico): skip M10 y skip DESIGN.md/S7, pasar directo a execution sin loop.

### Fase 2 — execution

Antes de arrancar, evaluar opt-in del **sub-agente per-flow** (`agent-workflow profiles` → `delegate_to_subagent`). Detalles en `references/lifecycle-deep.md`.

#### Verificar rama (obligatorio, gate de avance)

Re-aplicar el **bloque común de verificación** descrito en "Verificación interactiva de ramas" antes de tocar código en cada entrada a execution. La rama puede haber drifted desde la creación de la sesión (el usuario puede haber hecho checkout manual). No avanzar al loop de tasks sin que el bloque retorne consistente.

#### Composición dinámica + diffs incrementales

Tabla de composición + reglas de activación (regla cero) en `references/lifecycle-deep.md`. Loop:

1. Tomar tarea (`tasks-data --only-open`).
2. Verificar rama por archivo.
3. Cambio mínimo + diff.
4. Registrar DECISIÓN sólo si no es obvia.
5. Marcar tarea cerrada.
6. Repetir.

#### Topic-change detection

```
agent-workflow topic-change-check --objetivo-file .workflow/sessions/<folder>/OBJECTIVE.md --request "<resumen>"
```

Si `changed: true`, **dispara `AskUserQuestion`** con spec de S2 (`references/prompts-catalog.md#S2`). Header `topic-change`, 3 opciones (cerrar+abrir nueva / extender OBJECTIVE / ignorar). No bloquea — el Other auto registra el pedido como nota informal. NO narrar la pregunta en texto plano.

### Fase 3 — validation

No automática. Preguntar si valida desde plugin (`testing-strategy`) o manual. Registrar nota en DECISIONS (legacy: DECISIONES) si aporta.

### Fase 4 — closure

Ver "Cerrar sesión" abajo.

#### Closure sin implementación (F-E.1)

Cerrar la sesión sin ejecutar implementación es **válido** cuando el corpus producido representa un análisis terminado o una decisión documentada. El CLI lo permite sin restricciones (`session-close-service.ts` no exige criterios). Doctrina explícita: aceptar el cierre si se cumple:

1. **OBJECTIVE.md presente** (siempre — gate básico), Y
2. **Al menos uno de los siguientes artefactos**:
   - `CONCLUSIONS.md` (flow analyze terminado), O
   - `DELIVERY.md` (flow design entregado), O
   - `DESIGN.md` (decisión de diseño documentada sin código).

Casos de uso típicos:
- Sesión analyze que produjo CONCLUSIONS + roadmap pero el dev se difiere a otra sesión (post-062 es ejemplo canónico).
- Sesión design que entregó DELIVERY.md (specs UX/UI) sin implementación aún.
- Sesión exploratoria que rompió en DESIGN.md sin avanzar a code.

**Si TASKS.md tiene `[ ]` abiertos al cierre**: sugerir crear `BACKLOG.md` (ver F-F abajo) capturando lo diferido/descartado. Es lazy — solo se crea si hay valor en preservar follow-ups.

**Skip silencioso**: si la sesión es dev y no hay CONCLUSIONS/DELIVERY/DESIGN producidos, NO doctrinar el caso. El usuario debe completar la implementación o reconvertir explícitamente la sesión a analyze.

#### BACKLOG.md — artefacto opcional lazy (F-F)

Artefacto opcional por sesión que captura "lo que queda para otras sesiones": diferido, descartado o followups detectados al cierre.

**Cuándo crearlo**:
- TASKS.md con ≥1 ítem abierto al cierre, **o**
- El usuario menciona ítems a diferir/descartar, **o**
- Closure sin implementación (F-E.1) con items derivados que no entran al alcance de la próxima sesión.

**Trade-off rechazado**: incrustar `## Backlog` dentro de CHECKPOINT.md. Razón: CHECKPOINT = retomar **esta** sesión; BACKLOG = qué quedó pendiente **para otras**.

**Estructura mínima** (ver `references/backlog-template.md` para plantilla completa):

```markdown
# Backlog — session<NNN>-<flow>-<slug>

## Deferred
- Item con razón (out of scope, ETA insuficiente, depende de X).

## Discarded
- Item descartado con razón (no aplica, contraproducente, redundante).

## Followups
- Acción concreta para otra sesión, con sugerencia de slug y dependencia.
```

**Reglas**:
- Vive en `.workflow/sessions/<folder>/BACKLOG.md`. NO se gradúa.
- Consumido por `export-plan` como "Tasks abiertas heredadas" al consolidar N sesiones.
- Append-only en práctica (no borrar entries previas; mover items a `Discarded` con razón).
- Si el usuario explícitamente dice "no hay backlog para esta sesión", NO crear el archivo.

## Cerrar sesión

### 0. Detección de items abiertos → sugerir BACKLOG.md (F-F)

Antes de graduar, ejecutar:

```
agent-workflow tasks-data --code <CODE> --only-open
```

Si `open > 0` o si el usuario menciona items diferidos/descartados durante el cierre: sugerir crear `BACKLOG.md` siguiendo `references/backlog-template.md`. Lazy — solo crear si hay valor (≥1 item con razón clara). Si el usuario rechaza o no hay items, skip silencioso.

Reglas:
- NO bloquear el cierre por items abiertos (el cierre sin impl/sin tareas completas es válido per F-E.1).
- NO crear BACKLOG.md vacío ni con placeholders.
- BACKLOG.md no se gradúa; queda en `.workflow/sessions/<folder>/BACKLOG.md`.

### 1. Graduar artefactos (6 kinds — DEC-003)

Sólo 6 kinds graduan al cerrar. El resto vive en la sesión y no se gradúa por default.

| Kind | Comando | Categoría destino |
|---|---|---|
| `decision` | `agent-workflow graduate --kind decision --session <CODE> --id DEC-NNN --slug <kebab>` | `docs/decisiones/NNN-<slug>.md` |
| `manual` | `agent-workflow graduate --kind manual --session <CODE> --slug <kebab>` | `docs/manuales/NNN-<slug>.md` |
| `script` | **`/agent-workflow:release` exclusivamente** (no `graduate --kind script` directo) | `docs/scripts/NNN-sessionXXX-<slug>/` |
| `especificacion` | `agent-workflow graduate --kind especificacion --session <CODE> --slug <kebab>` | `docs/especificaciones/NNN-<slug>/` |
| `conclusion` | `agent-workflow graduate --kind conclusion --session <CODE> --slug <kebab>` (opt-in; default = no graduar) | `docs/conclusiones/NNN-<slug>.md` |
| `release` | **`/agent-workflow:release` exclusivamente** | `docs/release/NNN-informe-release.md` |

**Eliminados del modelo nuevo**: `plan`, `refactor`, `design`, `design-system`, `propuesta`, `postmortem`, `analysis`. Estos artefactos:
- Se quedan en `.workflow/sessions/<folder>/` (no se gradúan).
- O se promueven manualmente a `manual` / `especificacion` si el usuario decide curarlos.

**Regla absoluta del destino (DEC-002)**: la graduación respeta `workspace_mode` sin prompt por sesión. Hub mode → hub root (`<hub>/docs/<categoria>/`); project mode → cwd (`<cwd>/docs/<categoria>/`). Eliminado M12. Regla canónica completa: `references/graduacion-routing.md`.

### `docs/referencias/` transversal (DEC-004 v2)

Material de referencia del usuario (mockups, especificaciones, exports, glosarios, capturas, etc.) vive en una única carpeta transversal al workspace: `<workspace-root>/docs/referencias/`. En hub mode el path es `<hub-root>/docs/referencias/`; en single-repo es `<cwd>/docs/referencias/`. Cualquier sesión activa puede leer las referencias sin tener que subirlas por-sesión.

- **Único path canónico**: `docs/referencias/`. La carpeta legacy `.workflow/sessions/<folder>/referencias/` (DEC-004 v1) **no se lee** bajo ningún flow. Si una sesión cerrada la tiene, queda como histórico; el rescate de contenido pasa por `agent-workflow:migrate` opt-in.
- **Manual del usuario**: cualquier formato (md, pdf, xlsx, png, txt, etc.). El usuario coloca archivos ahí; la sub-estructura interna es libre.
- **Lectura del AI**: cualquier sesión (flow=dev/design/analyze) lee referencias relevantes al OBJECTIVE on-demand. Sin pre-procesamiento ni índices.
- **El AI no escribe** salvo solicitud explícita ("guardá esto en referencias", "agregá este wireframe a referencias").
- **Lazy**: la carpeta no se crea automáticamente; el workspace puede sembrar `docs/referencias/README.md` describiendo el contrato.
- **No se gradúa**: queda en `docs/referencias/`, fuera del flujo de graduación de las 6 kinds.

**Histórico DEC-004**: v1 (sesiones previas): `.workflow/sessions/<folder>/referencias/` por sesión. v2 (session080-dev-referencias-globales): mover a `docs/referencias/` transversal y eliminar lectura legacy.

### 1.5. Inspección y limpieza pre-commit (closure cleanup gate)

Gate canónico de calidad. Corre entre paso 1 (graduate) y paso 2 (propose commits). Inspecciona el diff working-tree por fuente dirty, categoriza hallazgos y propone correcciones antes de M1. Aplicación del anchor universal `agent-workflow:closure-cleanup` (ver `doctrine/rules/SKILL.md`).

**Skip silencioso**:
- Si todas las fuentes tienen `dirty=false` (nada que limpiar).
- Si el sumario de hallazgos es 0 tras inspección (working tree ya limpio).

**Pasos**:

1. Ejecutar `agent-workflow sources --session <CODE>` para refrescar `dirty` por fuente.
2. Para cada fuente con `dirty=true`:
   - Leer diff: `git -C <path> diff <main_branch>...HEAD` (limitar a archivos cambiados; usar `--stat` primero para tamaño).
   - Componer `agent-workflow:coding-standards` (anchor #5 del bundle `/rules`) para reglas por stack del path.
   - Categorizar hallazgos:
     - **Comentarios redundantes** — qué obvio, código muerto comentado, TODO sin owner/fecha, headers decorativos.
     - **Complejidad cognitiva** — métodos largos (>50 líneas), nesting profundo (>3), early-return ausente, condicionales anidados.
     - **Antipatrones** — `catchError(() => of([]))`, magic numbers, side effects no declarados, god class/method, lógica replicada FE+BE.
     - **Code smells** — DRY violado, naming oscuro, duplicación con `shared/`/`common/`, validación post-uso, mutación de parámetros.
     - **Código muerto** — imports sin usar, branches inalcanzables, variables huérfanas, funciones no llamadas.
   - Producir reporte breve: máximo 1 página por fuente, agrupado por categoría, cada hallazgo con `file:line` + 1 línea de fix sugerido.
3. Si la suma de hallazgos es 0 en todas las fuentes → skip silencioso al paso 2 (propose commits).
4. Disparar `AskUserQuestion` con spec de M13 (`references/prompts-catalog.md#M13`). N questions tab-por-fuente, header `<alias>`, opciones: "Aprobar fixes sugeridos (Recomendado)" / "Sólo reportar (no tocar)" / "Saltar esta fuente". Other = nota custom o fix manual del usuario. NO narrar la pregunta en texto plano.
5. Por cada fuente con opción 1 aprobada: aplicar edits acotados (`Edit`/`MultiEdit` por archivo, mostrar diff antes/después). Sin auto-rewrite masivo; cada edit local y reversible.
6. Por cada fuente con opción 2: dejar el reporte en `CHECKPOINT.md` como "Hallazgos pendientes" sin modificar working tree.
7. Re-ejecutar `agent-workflow sources --session <CODE>` para refrescar `dirty` tras edits aprobados.

**Sandbox plan-mode**: describir hallazgos por categoría en el plan file (paths + razones agrupadas). NO ejecuta `Edit`/`Write`/`Bash` mutante. M13 no se dispara.

**Composición** (SRP — el gate no duplica reglas):
- `agent-workflow:coding-standards` — fuente de verdad de qué es "bien".
- `agent-workflow:redaccion-simple` — formato del reporte (frases cortas, listas, sin jerga).
- `agent-workflow:branch-verification` — implícita; las fuentes ya vienen verificadas desde execution.

**No alcances**:
- NO reemplaza linter/formatter del stack (ESLint, Spotless, Prettier, Checkstyle, etc.) — el gate complementa.
- NO refactors estructurales mayores. Esos van a sesiones `## Type: refactor` con Strangler Fig.
- NO ejecuta tests — inspección estática del diff.
- NO modifica artefactos ya graduados en paso 1 (vivien en `docs/<categoria>/`, fuera del scope del gate).

### 2. Proponer commits por fuente afectada (propose-then-execute)

Aplicación canónica del patrón **universal** definido en `references/commits-policy.md` (Regla 3) — closure es uno de 3 disparadores del prompt M1 (los otros 2: solicitud explícita con/sin sesión activa). El flujo siguiente describe la variante auto-disparada por closure; el patrón completo (bypass por mensaje literal, fuera de sesión, etc.) vive en el canon.

Antes de compactar, ejecutar el **commit prompt** definido en `references/commits-policy.md` (Regla 3) y `references/prompts-catalog.md#M1`:

1. `agent-workflow sources --session <CODE>` → leer `sources[]` con `dirty` y `current_branch` por fuente.
2. Si todas tienen `dirty=false` → **skip silencioso**. Continuar al paso 4.
3. Si hay 1+ fuentes con `dirty=true`, invocar **una sola** `AskUserQuestion` con N questions tab-por-fuente (N = #fuentes-dirty, máx 4 simultáneas). Spec literal de cada question, headers, opciones y manejo del Other → ver `references/prompts-catalog.md#M1`. Resumen operacional:
   - Header de cada tab: `<alias>` puro (ej. `core`, `dev`).
   - 2 opciones explícitas: "Aprobar sugerido (Recomendado)" con el mensaje canónico (1 línea, ≤72 chars, tag `session<CODE>`, sin co-author, ver `commits-policy.md` regla 2) / "Saltar esta fuente".
   - `Other` auto-inyectado = mensaje de commit custom.
   - Por cada question respondida: si aprueba o el usuario escribió en Other, ejecutar `git commit -m "<msg>"` **solo en esa fuente** (`git -C <path>`), respetando hooks (sin `--no-verify`).
   - Si la fuente tiene `match=false` (rama inesperada), omitirla del prompt — abortar commit ahí, avisar al usuario y dejar que alinee la rama primero.
   - Si N > 4 fuentes dirty (caso excepcional): ejecutar en tandas. Registrar parcial en `CHECKPOINT.md` entre tandas.
4. Re-ejecutar `agent-workflow sources --session <CODE>` para verificar que las fuentes aprobadas quedaron limpias y registrar en `CHECKPOINT.md`.

Reglas absolutas: nunca `--amend`, nunca `git push`, nunca commits en fuentes no aprobadas, nunca `--no-verify`. Si un hook pre-commit falla, mostrar el error y dejar al usuario decidir.

### 3. Compact automático

1. Invocar skill `compact` → escribe CHECKPOINT.md final + dispara `/compact` host.
2. Tras `/compact`, contexto liberado. Sesión cerrada en HISTORY pero con CHECKPOINT.md por si retoma.

### 4. Cerrar formalmente

```
agent-workflow session-close --code <CODE> \
    --graduated-decisions "001-slug1,002-slug2" \
    --graduated-plan 001-plan-slug \
    --graduated-scripts NNN-sessionXXX-<slug>
```

## Retomar sesión

1. `agent-workflow checkpoint-read --code <CODE>` (si existe).
2. Si no, fallback `agent-workflow session-resume --code <CODE>`.
3. Aplicar el **bloque común de verificación** descrito en "Verificación interactiva de ramas". El usuario puede haber cambiado de rama o introducido cambios sin commit entre sesiones. Sin consistencia, no avanzar.
4. Presentar resumen + continuar desde fase actual.

## Verificación interactiva de ramas (canon — invocado en pasos 6/retomar/execution)

Bloque común que el AI **debe** seguir. Detalles del flujo y mensajes en `references/branch-verification.md`.

```
agent-workflow sources [--session CODE] [--scope alias1,alias2]
```

El payload incluye `sources[]` (per-fuente: `match`, `dirty`, `current_branch`, `expected_work_branch`, `flow`), `cross_source_consistent` y `divergent_sources`. El flow se resuelve automáticamente desde la sesión activa; para sesiones `flow=analyze` la rama esperada cae a `main_branch` (típicamente `certificacion`) cuando no se declaran branches en la sesión.

**Decisión por fuente** (orden):
1. `cross_source_consistent=false` (hub mode con divergencia no declarada) → **hard gate**. Mostrar matriz `alias → current → expected` (de `divergent_sources`) y disparar `AskUserQuestion`:
   - "Alinear todas a una misma rama" (preguntar cuál y aplicar Caso A por fuente).
   - "Declarar la divergencia explícita" (re-crear o `project-md-upsert --update-phase <folder> --branches alias:rama,...` con valores distintos).
   - "Cancelar acción".
   No avanzar hasta resolver.
2. Para cada fuente con `match=false`:
   - `dirty=false` → **Caso A** (`AskUserQuestion`): "¿Hago `git checkout <expected>` en `<alias>`?" / "Mantener current y actualizar la sesión" / "Cancelar".
   - `dirty=true` → **Caso B**: pausar y esperar resolución manual del usuario. Listar archivos modificados. NO ofrecer checkout. Reintentar el check después de "listo/continúa".
3. Para fuentes con `flow=analyze` y `match=true` que durante execution el usuario decide editar: **Caso C** (proactivo del AI): preguntar nombre de rama de trabajo, verificar existencia con `git rev-parse --verify`, ofrecer `checkout` o `checkout -b` desde `main_branch`, registrar en sesión vía `project-md-upsert --update-phase`.

**Reglas absolutas**:
- Nunca ejecutar `git stash`, `git reset --hard`, `git checkout -- .`, `git restore .`, `git clean` sin confirmación explícita del usuario para esa fuente.
- Después de cualquier acción git, re-ejecutar `agent-workflow sources --scope <alias>` para confirmar el nuevo estado.
- Si el usuario rechaza todas las opciones, abortar la acción que disparó el check (no avanzar).

## Listar sesiones

```
agent-workflow sessions [--include-legacy]
```

## Reglas generales

- **Sin fallbacks automáticos**: explicar antes de aplicar.
- **AW-PROJECT obligatorio**: si falta, proponer project-init/hub-init.
- **Fuentes globales**: el proyecto las declara una vez; las sesiones sólo indican ramas.
- **BD: scripts versionados, no ejecución directa**. MCP `<mcp-cert>`/`<mcp-prod>` son read-only por contrato (SELECT, EXPLAIN, `\d`). Cualquier mutación (INSERT/UPDATE/DELETE/DDL) se materializa como script en `docs/scripts/` del workspace de la fuente; el AI nunca ejecuta el script — el usuario lo aplica manualmente y confirma post-ejecución antes de cerrar la tarea. Excepción única: el usuario explícitamente delega ejecución por bloque.
- **No tocar sesiones de otro flow** sin pedir cambio de plugin/comando.

## Recursos adicionales

- **`references/lifecycle-deep.md`** — Plan agent details, sub-agente per-flow, hub mode, plan mode, composición dinámica, compatibilidad legacy.
- **`references/branch-verification.md`** — flujo cuando rama no coincide.
- **`references/commits-policy.md`** — política controlada de commits cross-plugin (anchor `agent-workflow:commits-policy`). Define las 5 reglas: prohibición de commits autónomos, formato canónico, propose-then-execute universal (M1) en cualquier solicitud o mención de commit, interacción con release/graduate, y bypass por mensaje literal.
- **`references/specialty-decision-tree.md`** — árbol completo para choose_specialty.
- **`references/topic-change-rules.md`** — heurística + ejemplos.
- **`references/auto-plan-rules.md`** — disparadores skip/lite/full.
- **`references/sandbox-readonly-rules.md`** — reglas universales de plan mode (canon).
- **shared-contract.md §14-§19** — contrato del lifecycle universal.
- **`agent-workflow:redaccion-simple`** — guía transversal de redacción para todos los artefactos agent-workflow (frases cortas, listas, sin jerga). Aplicar al escribir OBJECTIVE/TASKS/DECISIONS/EVIDENCE/FINDINGS/CONCLUSIONS/CHECKPOINT/STATUS/PROBLEM/IDEAS/DELIVERY.
