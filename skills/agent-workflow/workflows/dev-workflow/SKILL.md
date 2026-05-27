---
name: dev-workflow
description: "Workflow especializado dev (especialidad construcción de código), antes en qtc-dev. Consumido por /agent-workflow:session cuando flow=dev para orquestar el lifecycle universal con composición dev-específica. v2.7+ adopta modelo phased extendido (Phase 0-5 = Mapeo+Contrato → Lecturas → Escritura → Validaciones → Seguridad placeholder → Optimizaciones opt-in) y bugfix doctrina con superpowers:systematic-debugging."
version: 2.2.1
flow: dev
workflow_schema: 1.0
---

# Dev Workflow

Workflow declarativo del flow=dev. Define cómo se comporta la especialidad en dos modos:

- **Standalone** (`/agent-workflow:use`): activa la especialidad sin sesión, en cualquier workspace.
- **Orchestrated** (consumido por `/agent-workflow:session` cuando flow=dev): describe args, artefactos, skills y graduación que agent-workflow:session orquesta.

## Brief

**flow=dev** es la especialidad de construcción de código del plugin qtc. Aplica:

- **coding-standards**: fail-fast, logging por nivel apropiado, naming descriptivo, parametrización SQL, no exposición de secrets, reglas FE-BE (Sparse DTO + PATCH + sin fallbacks ocultos).
- **implement**: loop de tareas con flat mode o phased mode v2.7+ (Phase 0 Mapeo+Contrato con routing → Phase 1 Lecturas → Phase 2 Escritura → Phase 3 Validaciones → Phase 4 Seguridad placeholder → Phase 5 Optimizaciones opt-in; gate M6 entre phases). v2.8+ retira M9; el design review se materializa via DESIGN.md + S7 disparado desde `skills/session/SKILL.md` durante planning closure, antes de Phase 0. Bugfix doctrina v2.7+ compone con `superpowers:systematic-debugging` + test de regresión.
- **refactor**: análisis legacy + Strangler Fig (rename `<feature>-legacy/` + rebuild paralelo en Phase 0-5 + cleanup) cuando `## Type: refactor` (alias legacy `## Tipo`).
- **sql-script-organizer**: categoriza scripts SQL (DDL / migración / inserts) y aplica estilo del proyecto.
- **sql-rollback-generator**: pares forward/rollback para migraciones reversibles.
- **testing-strategy**: define alcance y tipo de tests según el cambio.
- **frontend-design**: patterns UX agnósticos (single-slot, máster-slave, validación inline).
- **release / release-scripts**: consolidación de cambios + bundle SQL para release (excepciones session-aware — ver §"Excepciones session-aware").

**Política BD (transversal al flow=dev)**: las mutaciones a BD se materializan exclusivamente como scripts SQL versionados bajo `docs/scripts/` del workspace de la fuente. **flow=dev nunca ejecuta DML/DDL** contra `<mcp-cert>`/`<mcp-prod>` ni ningún otro destino — el usuario es quien aplica los scripts manualmente y confirma. Aplica a todas las skills del flow (`implement`, `sql-script-organizer`, `sql-rollback-generator`, `release`, `release-scripts`).

**Política de commits**: ver `agent-workflow:commits-policy` (canónico). Cualquier commit que el usuario solicite — durante execution, en closure auto, o sin sesión activa — pasa por el flujo M1 propose-then-execute con `AskUserQuestion` (Regla 3 universal). Bypass por mensaje literal vía Regla 5.

**Política sin fallback al CLI (transversal al flow=dev)**: si `agent-workflow <subcmd>` falla (no está en PATH, comando no reconocido, exit code != 0), **cortá la acción y reportá al usuario**: pedile que verifique `npm install -g @tacuchi/agent-workflow-cli`. No hay flujo alternativo Python.

## Standalone (use) — DEPRECADO (session096)

> `/agent-workflow:use` nunca se materializó como comando (no está en los commands canónicos ni en el marketplace). Para una tarea dev pequeña con trazabilidad mínima usá **`/agent-workflow:patch`** (micro-lifecycle, modo `--lite` de flow=dev — ver `session/SKILL.md` §"Modo lite (/patch)"). Para trabajo largo, `/agent-workflow:session`. Esta sección queda como histórico read-only; no describe un comando activo.

## Excepciones session-aware (v2.1+)

En flow=dev v2.0+ la regla general es "comandos standalone vía /agent-workflow:use". Las **únicas excepciones** son:

- `/agent-workflow:release` — consolida N sesiones cerradas en un paquete de paso a producción (informe + bundle SQL + escaneo + acciones manuales). Renombrado desde `release-report` en v2.1.0.
- `/agent-workflow:release-scripts` — vista alternativa por tema del bundle SQL del release.

Estos NO crean ni modifican sesiones (siguen siendo read-only del lifecycle), pero **dependen de su existencia**. Si el workspace no tiene sesiones, abortan con mensaje sugiriendo `/agent-workflow:session create` primero.

Ambos consumen el CLI `agent-workflow` (no leen paths hardcodeados):
- `agent-workflow release-data [--since sessionNNN] [--source alias] [--include-graduated]`
- `agent-workflow session-artifacts --code <NNN>` — lee OBJECTIVE/TASKS/DECISIONS de una sesión (con fallback bilingual a OBJETIVO/TASKS/DECISIONES legacy).
- Resolución hub-aware de `docs/<source>/` y `release/<source>/` la maneja el CLI internamente.

**Formato requerido**: solo sesiones v0.9+ (OBJECTIVE.md / OBJETIVO.md legacy ES). Sesiones legacy con REQUIREMENTS.md deben migrarse con `/agent-workflow:migrate --upgrade-topology` antes de usar release.

## Session integration

Cuando agent-workflow:session consume este workflow durante `/agent-workflow:session create` con flow=dev:

### Args al crear sesión

(ninguno extra para dev — solo los comunes: `--name`, `--objetivo`, `--branches`, `--from`)

### Convención `## Type` en OBJECTIVE.md — alias legacy `## Tipo` (v2.8+)

Toda sesión `flow=dev` declara `## Type` justo después del título (o después de `## Origin` si existe). Determina si la sesión sigue el flujo **phased** y si activa el skill `refactor`. Los **valores** son slugs `feature|refactor|bugfix|chore` (EN, no requieren traducción).

**Rename v2.8+**: el header canónico es `## Type` (EN, alineado con i18n scope memory `feedback_i18n_scope_runtime_only` y harmonizado con `flow=design` que ya usa `## Type` para S1). `## Tipo` queda como alias legacy ES read-only — el parser bilingüe `parseTypeFromObjetivo()` en `agent-workflow-cli` acepta ambas formas y normaliza a EN. Sesiones cerradas con `## Tipo` legacy siguen siendo legibles sin migración forzada.

| Type | Phased? | Skill `refactor` activo? | Artefactos extra | Ejemplo de Brief |
|---|---|---|---|---|
| `feature` | sí (default-on) | no | DESIGN.md + S7 gate | "agregar mantenimiento de categorías con CRUD" |
| `refactor` | sí (default-on) | sí | DESIGN.md + S7 gate; REFACTOR.md (vive en sesión; **no se gradúa con kind dedicado** — DEC-003) | "rebuild de mantenimiento de categorías al estándar nuevo" |
| `bugfix` | no | no | — (no DESIGN.md, no S7) | "fix de validación en formulario de usuarios" |
| `chore` | no | no | — (no DESIGN.md, no S7) | "bump de dependencias, limpieza de imports" |

### Resolución del `## Type` — defensa en profundidad (v2.8+)

Tres capas garantizan que `## Type` nunca esté ausente:

**Capa 1 — CLI template (Mit-A)**: `agent-workflow session-create --flow dev` inyecta `## Type: <valor>` en el OBJECTIVE.md template materializado. Posición canónica: línea 3 si no hay `## Origin`, después de `## Origin` si existe.

**Capa 2 — Heurística (Mit-C)**: el CLI analiza `--objetivo` con tabla de keywords y elige tipo + confianza. Flag `--type <valor>` opcional para override explícito.

- Brief contiene `refactor`/`rebuild`/`migrar`/`mover a nuevo`/`reescribir`/`legacy` → `refactor` (alta confianza).
- Brief contiene `agregar`/`nueva pantalla`/`crear endpoint`/`nuevo módulo`/`feature de` → `feature` (alta confianza).
- Brief contiene `fix`/`arreglar`/`corregir`/`error en` con scope ≤1 archivo → `bugfix` (media confianza).
- Brief contiene `bump`/`actualizar dependencia`/`limpiar imports`/`formato`/`tipos` → `chore` (alta confianza).
- Sin match claro → `feature` (fallback). Emitir log: `[session-create] Type inferido como 'feature' por baja confianza heurística (brief no matchea keywords). Pasá --type <valor> para override.`

**Capa 3 — Default-on en lectura**: `implement` y otras skills que lean OBJECTIVE.md aplican fallback `feature` con log informativo si `## Type` está ausente (sesiones legacy, migradas, o con borrado manual). Detalles en `skills/implement/SKILL.md` §"Resolución del `## Type`".

**Promoción mid-session**: el usuario puede editar `## Type` en OBJECTIVE.md (o `## Tipo` legacy) sin re-crear la sesión. `implement` re-lee al iniciar cada loop. Si `Type` cambia de `bugfix` → `feature`, el siguiente cambio dispara comportamiento phased; tareas previas no se reescriben.

**Refs HISTORY**: el flow=dev añade tag `type:<feature|refactor|bugfix|chore>` cuando aplica para que `release` y `release-scripts` puedan filtrar. Alias legacy `tipo:` también legible.

### Flujo phased en execution (v2.7+)

Cuando `Tipo: feature|refactor`, TASKS.md se organiza en hasta 6 secciones canónicas:

```markdown
## Phase 0 — Mapeo + Contrato
- [ ] interfaces/DTOs/endpoints stub que devuelven mocks
- [ ] routing FE conectado a BE (FE consume mock; navegación e2e funciona)…

## Phase 1 — Lecturas
- [ ] consultas, combos, filtros, listados con datos reales…

## Phase 2 — Escritura
- [ ] create/update/delete funcionales (sin Bean Validation aún)…

## Phase 3 — Validaciones / Correcciones
- [ ] Bean Validation con groups, handler global 400 estructurado, reglas de negocio, cleanup smells…

## Phase 4 — Seguridad   <!-- placeholder; pendiente-spec; skip silencioso si vacía -->

## Phase 5 — Optimizaciones   <!-- opt-in; skip silencioso si no se declara -->
- [ ] EXPLAIN sobre queries, índices, async, caching…
```

`implement` lee las secciones y dispara M6 (phase-gate) entre cada par phase → phase. Phase 4 placeholder y Phase 5 opt-in se saltan silenciosamente si están vacías o no declaradas. Si TASKS.md no tiene `## Phase X — Y`, `implement` cae a flat mode (compat hacia atrás 100%). **DESIGN.md + S7 design-review** se producen y disparan ANTES de Phase 0 desde `skills/session/SKILL.md` durante planning closure (v2.8+ — reemplazo de M9 retirado).

#### Routing dentro de Phase 0

El cableado FE↔BE↔DB de Phase 0 incluye **navegación e2e con datos hardcoded**: si la feature involucra un login, en Phase 0 click "Ingresar" debe llevar al home; si home muestra una tabla, esa tabla ya consume el endpoint BE responding mock. El cableado y routing ya fueron declarados en `DESIGN.md` §"Wiring" + §"Target state" y revisados via S7 antes de Phase 0 (v2.8+) — Phase 0 implementa el spec, no lo re-define.

Sin separar Phase 0a (mocks) y Phase 0b (routing): mocks sin routing son inútiles porque no se prueban e2e; routing sin mocks no funciona. Van juntos en Phase 0 como sub-checklist.

**Reglas FE-BE aplicadas** en Phase 0 (Sparse DTO unificado + PATCH + sin fallbacks ocultos + DB stub-first): ver canónico `coding-standards/references/fe-be-integration.md` (R1-R6).

### Bugfix doctrina (flat mode v2.7+)

Cuando `## Type: bugfix` (alias legacy `## Tipo`), TASKS.md sigue flat (sin `## Phase X — Y`). Doctrina nueva en 3 pasos canónicos:

1. **Reproducir + diagnosticar**: el AI compone `superpowers:systematic-debugging` (root-cause analysis sistemático). Output: 1 DEC mínima en DECISIONS.md con causa raíz o hipótesis a validar.
2. **Aplicar fix mínimo**: loop flat normal, 1-3 tareas como mucho, sin gates.
3. **Verificación específica**: `testing-strategy` exige test de regresión que reproduce el bug original (rompe antes / pasa después).

**Skip permitido del paso 1** si el bug es trivialmente obvio (1 line con justificación inline en DECISIONS, ej. "typo en regex que rompía parsing — sin causa raíz adicional").

**Fallback si `superpowers:systematic-debugging` no está instalado**: aplicar guideline textual de root-cause: "¿qué pasó? ¿qué cambió? ¿cuál es el error exacto? ¿se reproduce?" antes de fix. Sin nuevo `## Type: hotfix`; la urgencia se expresa en el OBJECTIVE.

### Artefactos por fase

- planning: OBJECTIVE.md, TASKS.md
- execution: DECISIONS.md, scripts/, DEPENDENCIES.md
- validation: tests, logs en TASKS marcados
- closure: docs/decisiones/ (kind=`decision`); SQL bundles vía `/agent-workflow:release` en `docs/scripts/` (kind=`script`)

### Skills por fase

- planning: analyze-synthesize (cross-flow, sugerir al usuario)
- execution: implement, coding-standards, sql-script-organizer, sql-rollback-generator
- validation: testing-strategy, coding-standards
- closure: graduate `--kind decision` (DEC-NNN graduadas a `docs/decisiones/`); para SQL ver `/agent-workflow:release`

### Refs HISTORY

- dec: docs/decisiones/{val}.md
- sql: docs/scripts/{val}/ (vía `/agent-workflow:release`)

### Conteos resume

- tasks: TASKS.md (counts pendientes/en_progreso/completadas)
- decisions: DECISIONS.md (count DEC-NNN headers)
- dependencies: DEPENDENCIES.md (rows post-header)
- scripts: scripts/*.sql + scripts/bundle/ check

## Sandbox read-only

Standalone: en plan mode, solo describir qué skills se cargarían, qué stack se detectaría, qué paths se sugerirían. No tocar archivos.

Orchestrated: ver `agent-workflow:session` plan mode rules.
