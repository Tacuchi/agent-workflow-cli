# Catálogo de prompts interactivos agent-workflow — referencia canónica

> Anchor: `agent-workflow:prompts-catalog`. Documento canónico que define **cuándo y cómo** los skills de la familia agent-workflow deben usar `AskUserQuestion` (Claude Code) o equivalente. Referenciado desde `skills/session/SKILL.md`, `references/commits-policy.md`, `references/branch-verification.md` y los workflows de los flow plugins. Los SKILL apuntan acá; el spec literal de cada punto vive en `prompts/<id>-<slug>.md` (1 archivo por prompt) y este catálogo es el index.
>
> Origen: session009-analyze-prompts-interactivos-session (propuesta). Ver `DECISIONES.md` de esa sesión para el razonamiento de DEC-001..008.
>
> Extensión session013-dev-flujo-feature-refactor-phased: M6 (phase-gate), M7 (refactor-legacy-detected), M8 (refactor-cleanup) y M9 (contract-review, retirado en session050) — soportan el flujo phased y el skill `qtc-dev:refactor` con migración Strangler Fig.
>
> Extensión session050-dev-design-md-and-s7-gate: S7 (design-review) reemplaza a M9. El gate de review se mueve de post-stub (al cerrar Phase 0) a pre-stub (antes de Phase 0). Nuevo artefacto `DESIGN.md` revisable entre planning y execution. Default-on `## Type: feature` con defensa en profundidad (Mit-A CLI template + Mit-C heurística + default-on lectura). Rename `## Tipo` → `## Type` con alias bilingüe legacy ES.
>
> Extensión session015-dev-aplicar-flujo-fases-extendido: el modelo phased crece a Phase 0-5 (Mapeo+Contrato → Lecturas → Escritura → Validaciones → Seguridad placeholder → Optimizaciones opt-in). M6 puede aparecer hasta 5 veces por sesión completa; Phase 4 placeholder y Phase 5 opt-in se saltan silenciosamente. M9 preview gana fila de Routing FE↔BE (M9 retirado en session050; ver entrada del catálogo).
>
> Extensión session002-dev-eje1-prompts-catalog (workspace `qtc-plugin-v2`, Propuesta 002 consolidar-arquitectura-qtc): M10 (next-step), M11 (context), S4 (resume), S5 (post-compact) y S6 (scope) — soportan el monopolio de comandos lifecycle en `agent-workflow` y la guía proactiva del manager. Cuándo se dispara cada uno + heurísticas de recomendación dinámica (M10/S5).
>
> Extensión session008-dev-prompts-catalog-split: spec literal de cada prompt extraído a `prompts/<id>-<slug>.md`. Este index conserva los anchors `#m1...` `#s1...` `#c1...` para no romper refs cross-skill.

## Contrato del API `AskUserQuestion`

`AskUserQuestion` es nativo de Claude Code. Constraints:

- **1-4 questions por invocación**. Más → tandas (segunda invocación tras la primera).
- **2-4 options por question**. Mínimo 2 (no se puede 1 sola opción + Other).
- `multiSelect`: boolean. Si `true`, no admite `preview` por opción.
- `preview`: opcional, solo single-select. Render markdown monospace en panel lateral.
- `header`: ≤12 chars. Chip/tag visible en UI.
- `question`: termina con `?`.
- **`Other` auto-inyectado siempre** — entrada libre. NUNCA agregarla manual a `options`. `notes` opcional con texto libre del usuario.
- Cada `option`: `label` 1-5 palabras + `description` con explicación o trade-off.
- Recomendado: opción recomendada **primera** y agregar "(Recomendado)" al label.

## Cuándo NO usar AskUserQuestion (no-goals)

- Lecturas de archivos (`Read`, `Glob`, `Grep`).
- Comandos read-only (`git status/log/diff`, `agent-workflow read/sources`).
- Refresh de cache.
- Edits triviales con scope explícito ya autorizado por el usuario.
- **Captura de texto libre puro** (descripción del proyecto, brief inicial libre) — la API exige 2-4 opciones; Other-only no es contrato válido. Usar input conversacional natural.
- Iteración creativa (mocks en `design-develop`, feedback en `design-deliver`, brainstorming).
- Confirmaciones obvias del SKILL ("voy a leer X" — narración, no decisión).
- Auto-plan output `skip|lite|full` — el AI rara vez quiere override.
- Graduación de artefactos al cierre — el destino se decide automáticamente por `workspace_mode` (DEC-002). Hub mode → hub root; project mode → cwd. Sin prompt por sesión.

## Convención de headers

DEC-006 — mixta según contexto. Cada header debe ser inmediatamente legible en su contexto natural:

- **Alias puro** (`core`, `dev`, `design`, `analyze`, `marketplace`) cuando el contexto es inequívoco por su fase. **Aplica solo a M1** (closure-commit, donde la fase implica commit).
- **Prefijo descriptivo + alias** (`branch:<alias>`) cuando el prompt puede aparecer fuera de un contexto obvio. **Aplica a M2** (branch verification puede ocurrir en cualquier momento).
- **Headers descriptivos** (`work-branch`, `checkout`, `branch-new`, `cross-branch`, `modality`, `design-type`, `topic-change`, `flow`, `specialty`, `cost`) cuando no hay alias o el prompt es global. Headers ES legacy (`modalidad`, `design-tipo`) son aceptados por compat con sesiones pre-R3.

## Catálogo

### Q-must (11 puntos — M1..M11; M12 eliminado por DEC-002)

#### M1 — commit-prompt (universal — CASO ANCLA)
Spec: [`prompts/M1-closure-commit-prompt.md`](prompts/M1-closure-commit-prompt.md) (archivo no renombrado; preserva anchor `#m1`). Cuándo: **cualquier** solicitud o mención de commit como acción a ejecutar — closure auto-disparado, solicitud explícita en planning/execution con sesión activa, solicitud explícita sin sesión activa, hub o project. Forma: 1 invocación con N questions tab-por-fuente (max 4); en project mode N=1. Canon del alcance: `commits-policy.md` Regla 3 + Regla 5 (bypass por mensaje literal).

#### M2 — branch-caso-A (rama distinta, repo limpio)
Spec: [`prompts/M2-branch-caso-A.md`](prompts/M2-branch-caso-A.md). Cuándo: una fuente con `match=false ∧ dirty=false`. Forma: 1 question, header `branch:<alias>`, 3 opciones (checkout / mantener current / cancelar).

#### M3 — branch-caso-C (analyze pasa a editar)
Spec: [`prompts/M3-branch-caso-C.md`](prompts/M3-branch-caso-C.md). Cuándo: `flow=analyze` decide editar código en execution. Forma: 2 prompts encadenados (work-branch → checkout|branch-new).

#### M4 — cross-source-hard-gate (hub mode con divergencia)
Spec: [`prompts/M4-cross-source-hard-gate.md`](prompts/M4-cross-source-hard-gate.md). Cuándo: workspace `Mode: hub` con `cross_source_consistent=false`. Forma: 1 question + (si elige alinear) prompt encadenado para target-branch.

#### M5 — modality-analyze (standalone o sesión nueva sin modality)
Spec: [`prompts/M5-modality-analyze.md`](prompts/M5-modality-analyze.md). Cuándo: `flow=analyze` sin `## Modality` declarada en OBJECTIVE.md (legacy: `## Modalidad` en OBJETIVO.md). Forma: 1 question, header `modality`, 3 opciones (Technical / Data / Incident). Valor canónico EN persistido (`technical`/`data`/`incident`); valores ES legacy (`tecnica`/`datos`/`incidente`) sólo en lectura.

#### M6 — phase-gate (transición entre phases en implement)
Spec: [`prompts/M6-phase-gate.md`](prompts/M6-phase-gate.md). Cuándo: cierre de `## Phase X` en TASKS.md (`flow=dev` con `## Type: feature|refactor`; alias legacy `## Tipo`). Forma: 1 question + preview opcional. Hasta 5× por sesión phased completa (Phase 0-5).

#### M7 — refactor-legacy-detected (rename Strangler en skill `refactor`)
Spec: [`prompts/M7-refactor-legacy-detected.md`](prompts/M7-refactor-legacy-detected.md). Cuándo: tras "Análisis legacy" en REFACTOR.md, antes de tocar paths. Forma: 1 question + preview tree. 4 opciones (rename+AI / rename+IDE / solo análisis / Other custom path).

#### M8 — refactor-cleanup (eliminación de paths legacy)
Spec: [`prompts/M8-refactor-cleanup.md`](prompts/M8-refactor-cleanup.md). Cuándo: refactor validado e2e (status `validating → completed`). Forma: 1 question, 3 opciones (eliminar / mantener / cancelar).

> **M9 — contract-review**: RETIRADO (DEC-002 de `session049-analyze-mejoras-flujos-qtc-runtime`, implementado en `session050-dev-design-md-and-s7-gate`). El gate de review se mueve de post-stub a pre-stub vía S7 (ver §"Q-should"). La validación post-implementación se delega al skill futuro `agent-workflow:review <sessionNNN>` (placeholder DEC-002 / R5 de CONCLUSIONS session049). Spec histórico conservado en [`prompts/M9-contract-review.md`](prompts/M9-contract-review.md).

#### M10 — next-step (cierre de planning)
Spec: [`prompts/M10-next-step.md`](prompts/M10-next-step.md). Cuándo: cierre de planning con TASKS.md ≥1 task abierta, antes de execution. Forma: 1 question, 3 opciones (e2e / paralelo / una por vez). Recomendación dinámica por `tasks_count` y `eta_total`.

#### M11 — context (auto-trigger por carga de contexto)
Spec: [`prompts/M11-context.md`](prompts/M11-context.md). Cuándo: AI estima carga >75%. Forma: 1 question, 3 opciones (compact ahora / seguir / cerrar). Skip si sesión ya en `closure`.

> **M12 — graduacion-destino**: ELIMINADO (DEC-002). El destino de graduación se decide automáticamente por `workspace_mode` sin prompt por sesión. Hub mode → hub root; project mode → cwd. Ver `references/graduacion-routing.md`.

### Q-should (7 puntos — frecuencia media, ROI claro)

#### S1 — type-design (standalone o brief ambiguo)
Spec: [`prompts/S1-type-design.md`](prompts/S1-type-design.md). Cuándo: `flow=design` sin `## Type` declarado en OBJECTIVE.md (legacy: `## Tipo` en OBJETIVO.md). Forma: 1 question, header `design-type`, 2 opciones (Project / System). Valor canónico EN persistido (`project`/`system`); valores ES legacy (`proyecto`/`sistema`) sólo en lectura. Other = clarificación libre, no se infiere.

#### S2 — topic-change-detection
Spec: [`prompts/S2-topic-change-detection.md`](prompts/S2-topic-change-detection.md). Cuándo: `topic-change-check` retorna `changed=true` durante execution. Forma: 1 question, 3 opciones (cerrar+abrir nueva / extender OBJECTIVE / ignorar).

#### S3 — flow-detection
Spec: [`prompts/S3-flow-detection.md`](prompts/S3-flow-detection.md). Cuándo: heurística de flow ambigua. Forma: 1 question principal + (si elige opción 4) sub-prompt para clasificar.

#### S4 — resume (sesión sin args + ≥2 sesiones activas)
Spec: [`prompts/S4-resume.md`](prompts/S4-resume.md). Cuándo: `/agent-workflow:session` sin args con ≥2 sesiones activas. Forma: 1 question + preview opcional (tabla code·phase·last-activity·open-tasks). Skip si <2 activas.

#### S5 — post-compact (PostCompact hook)
Spec: [`prompts/S5-post-compact.md`](prompts/S5-post-compact.md). Cuándo: tras `/compact` o `/agent-workflow:compact`, CHECKPOINT.md leído. Forma: 1 question, 3 opciones. Recomendación dinámica por `tasks_open`.

#### S6 — scope (auto-plan-decide retorna `full` con ETA >4h)
Spec: [`prompts/S6-scope.md`](prompts/S6-scope.md). Cuándo: planning con `decision=full ∧ eta_total > 4h`. Forma: 1 question, 3 opciones (Lite primero / Full / Split en 2 sesiones). Skip si `tasks_count ≤ 3`.

#### S7 — design-review (gate de aprobación del DESIGN.md antes de Phase 0)
Spec: [`prompts/S7-design-review.md`](prompts/S7-design-review.md). Cuándo: cierre de planning, tras producir `DESIGN.md`, antes de M10. Aplica a `flow=dev` con `## Type: feature|refactor`. Forma: 1 question, 3 opciones (Sí lo reviso / Approve as-is / Refinar antes) + Other auto = feedback puntual con re-disparo. Preview ASCII opcional. Always-on para tipos cubiertos; skip silencioso para `bugfix|chore`. Confirmación obligatoria.

#### S8 — closed-with-artifacts (resume detect closed+complete, F-E.2)
Cuándo: skill `resume` ejecuta `resume-summary --include-recent-closed` y obtiene `recent_closed_with_artifacts.length > 0` con `active_sessions: []`. Forma: 1 question, header `closed-with-artifacts`, 4 opciones:
1. **Export plan** — `/agent-workflow:export-plan --sessions <NNN[,NNN]>` con la sesión elegida (o set si el usuario eligió varias en preview).
2. **Export conclusions** — `/agent-workflow:export-conclusions --sessions <NNN>` (solo si la sesión es analyze con CONCLUSIONS).
3. **Abrir nueva sesión** — delegar a `/agent-workflow:session` con prompt de OBJECTIVE.
4. **Solo recapitular** — leer artefactos y presentar resumen.

Recomendación dinámica: 1 sola sesión analyze cerrada → opción 2 `(Recomendado)`; ≥2 sesiones del mismo dominio → opción 1 `(Recomendado)`. Other auto = "Otra acción" → consultar. Preview opcional con tabla `code · flow · closed_age · artifact_signal`.

### Q-could (2 puntos — parking, opcional, Fase 3)

#### C1 — specialty-selection (planning)
Spec: [`prompts/C1-specialty-selection.md`](prompts/C1-specialty-selection.md). Cuándo: planning con 2+ skills sugeridas por `specialty-choose`. Forma: 1 question multi-select.

#### C2 — cost-guard (queries pesadas en analyze-investigate)
Spec: [`prompts/C2-cost-guard.md`](prompts/C2-cost-guard.md). Cuándo: query costosa (>10k filas o seq scan >100k). Forma: 1 question + preview SQL+EXPLAIN. 2 opciones (proceder / cancelar).

## Apéndice A — Fallback cross-platform

**Contrato del AI**: antes de invocar `AskUserQuestion`, validar el harness con `agent-workflow harness` (devuelve `harness: claude-code|codex|unknown`). Si el harness no es `claude-code` ni Gemini, **no intentar el tool**: ir directo al fallback texto plano descrito abajo. Las SKILLs delegan acá vía `agent-workflow:prompts-catalog#XX` y no repiten esta gate.

`AskUserQuestion` es Claude Code-específico. Para plataformas distintas:

| Plataforma | Equivalente | Tratamiento |
|---|---|---|
| Claude Code | `AskUserQuestion` nativo | Use canónico. |
| Gemini CLI | `ask_user` ("Request structured input from the user") | Mapping 1:1. Confirmar parámetros del tool antes de invocar. |
| Codex | Sin equivalente directo | Fallback texto plano (abajo). |
| Copilot CLI | Sin equivalente directo | Fallback texto plano (abajo). |
| Otros | Sin equivalente | Fallback texto plano (abajo). |

### Formato del fallback texto plano

Cuando no hay tool nativo, el AI imprime una lista numerada y espera respuesta:

```
[Sesión agent-workflow — decisión] <pregunta>

  1. <option 1 label> — <description>
  2. <option 2 label> — <description>
  ...

  Escribí el número o tu mensaje custom.
```

El AI parsea la respuesta:
- Número entero (1..N) → opción seleccionada.
- Texto libre → equivalente a `Other` (mensaje custom o cancelación según el punto).

**Limitaciones del fallback**:
- No hay tabs (las preguntas con N>1 se hacen en serie, no en paralelo).
- No hay multiSelect (se pide al usuario que liste números separados por coma).
- No hay preview ASCII (el preview se imprime arriba de las opciones).

Documentar en cada SKILL que el fallback se usa cuando la plataforma no es Claude Code ni Gemini.

## Apéndice B — Convención de naming phased

M6 (phase-gate) consume TASKS.md detectando secciones de phase. El detector acepta 4 variantes equivalentes:

| Forma | Ejemplo de heading | Uso típico |
|---|---|---|
| `Phase` (canónica) | `## Phase 0 — Contrato` | recomendada — alinea con la documentación oficial |
| `Fase` | `## Fase 0 — Contrato` | castellano puro |
| `Sprint` | `## Sprint 1 — Quitar Supervisor` | vocabulario agile |
| `Etapa` | `## Etapa 2 — Mutaciones` | castellano alterno |

El regex canónico es `^## (Phase|Fase|Sprint|Etapa) [0-9]+( — .+)?$`. El " — `<title>`" después del número es opcional para tolerar TASKS.md mínimos.

Las 4 formas son **sinónimos sin diferencia funcional**. Mezclar formas en un mismo TASKS.md (ej. `Phase 0` + `Sprint 1`) es legal pero no recomendado — preferí 1 forma consistente. Cuando documentes una sesión phased en HISTORY.md, prosa o changelogs, usá `Phase X` para mantener referencia uniforme.

## Apéndice C — Cómo agregar nuevos puntos al catálogo

Para extender este catálogo sin romper la convención:

1. **Numeración secuencial estricta** — siguiente Q-must = M`<N+1>` (último activo: M11; M12 eliminado y no reusable). Igual para Q-should (último: S6) y Q-could (último: C2). No saltar números, no reusar.
2. **Categoría según frecuencia**: M (must, alto tránsito), S (should, frecuencia media), C (could, parking opcional). Si dudás, empezá en C — promovés a S/M cuando se valida ROI.
3. **Header descriptivo** ≤12 chars (`next-step`, `context`, `scope`), salvo alias-puro inequívoco (M1 con `core`, `dev`, etc.).
4. **Recomendación dinámica**: si `(Recomendado)` depende del contexto (ej. M10 según `tasks_count`, S5 según `tasks_open`), documentarlo en sub-sección `**Recomendación dinámica**` debajo de `options`. No hardcodear la marca en una opción si el AI debe elegir en runtime.
5. **Skip silencioso por edge case**: por cada condición que invalida el prompt (sesión vacía, hook no aplicable, modo standalone, ya en closure), documentar `**Si <condición>**: skip silencioso` para evitar prompts espurios.
6. **Refina/Reemplaza obligatorio** apuntando al SKILL invocador (ej. `**Refina**: paso X en \`skills/Y/SKILL.md\``). Si el SKILL todavía no existe, marcá `**Refina (futuro)**` con TODO.
7. **Crear archivo standalone**: agregar `prompts/<id>-<slug>.md` con la spec literal (cuándo + forma + opciones + tratamiento del Other + skip rules + Refina). Index entry en este archivo: 1-2 líneas resumen + link al spec file.
8. **Validar post-edit**: correr `agent-workflow plugin-doctor --plugin-root <core-plugin-path>` y verificar que ninguna referencia interna del catálogo se rompió. Bumpear minor del manifest del plugin (extiende, no breaking).

## Refs

- `skills/session/SKILL.md` — orquestador del lifecycle universal; usa M1 en closure, M2/M3/M4 vía branch-verification, M10 al cierre de planning, S4 al retomar con multi-sesión activa, S6 al detectar scope full+ETA>4h.
- `skills/compact/SKILL.md` — usa M11 (auto-trigger contexto >75%) y S5 (PostCompact hook).
- `skills/resume/SKILL.md` — complemento S5 si el PostCompact hook delega en resume.
- `skills/session/references/commits-policy.md` regla 3 — canon del commit prompt; alineado con M1.
- `skills/session/references/branch-verification.md` Casos A/C/Cross — canon del flujo de ramas; alineado con M2/M3/M4.
- `qtc-analyze/skills/analyze-workflow/SKILL.md` — usa M5 en standalone modalidad.
- `qtc-design/skills/design-workflow/SKILL.md` + `qtc-design/skills/design-brief/SKILL.md` — usarán S1 en Fase 2.
- `.workflow/sessions/session009-analyze-prompts-interactivos-session/RECOMENDACION.md` — propuesta origen (DEC-001..008, M1-M5/S1-S3/C1-C2).
- `qtc-dev/skills/implement/SKILL.md` — usa M6 (phase-gate) cuando TASKS.md tiene secciones `## (Phase|Fase|Sprint|Etapa) X` (apéndice B). S7 (design-review) dispara antes de Phase 0 desde `skills/session/SKILL.md` durante cierre de planning.
- `qtc-dev/skills/refactor/SKILL.md` — usa M7 (refactor-legacy-detected) y M8 (refactor-cleanup).
- `qtc-plugin-v2/.workflow/sessions/session001-analyze-consolidar-arquitectura-qtc/RECOMENDACION.md` + `docs/rfcs/002-consolidar-arquitectura-qtc.md` — propuesta origen de M10/M11/S4/S5/S6.
- `qtc-plugin-v2/.workflow/sessions/session002-dev-eje1-prompts-catalog/` — sesión que implementó la extensión (Eje 1 de la Propuesta 002).
- `~/.claude/plugins/cache/.../superpowers/.../using-superpowers/references/{codex,copilot,gemini}-tools.md` — mapping cross-platform.
