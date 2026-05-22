---
name: implement
description: "Orquesta edits de código durante execution. Toma una tarea de TASKS.md, verifica rama, aplica cambio mínimo incremental, muestra diff, registra DECISIONS (legacy = DECISIONES) no obvias, marca tarea cerrada y repite. Detecta secciones `## Phase X — Y` en TASKS.md y dispara M6 entre phases (modo phased default-on para `## Type: feature|refactor`; alias bilingüe legacy `## Tipo`). v2.7+ extiende el modelo a Phase 0-5 (Mapeo+Contrato → Lecturas → Escritura → Validaciones → Seguridad placeholder → Optimizaciones). v2.8+ retira M9 (contract-review post-stub) — el gate de design review se materializa via DESIGN.md + S7 antes de Phase 0 desde `skills/session/SKILL.md`. Doctrina de bugfix compone con `superpowers:systematic-debugging` + test de regresión. Compone con coding-standards, sql-script-organizer, testing-strategy, frontend-design y refactor. Invocado por agent-workflow:session cuando el OBJECTIVE requiere editar código."
version: 2.2.1
---

# Implement — qtc v2.7+

Skill de especialidad **dev**: orquesta edits de código durante la fase `execution` del lifecycle universal.

## Cuándo se invoca

- **Composición desde `agent-workflow:session`** (lo más común): cuando la sesión entra a `execution` y el OBJECTIVE requiere editar código (default si no es analyze/design puro).
- **NL del usuario**: "implementá", "aplicá el cambio", "vamos a codear".
- **Slash explícito** (no canónico, opcional): `/agent-workflow:session` durante execution lo invoca.

NO se activa por sí solo fuera del lifecycle universal — siempre dentro de una sesión activa.

## Pre-requisitos

1. **Sesión activa** registrada en AW-PROJECT.Status.
2. **OBJECTIVE.md presente** y aprobado.
3. **TASKS.md presente** (al menos un item abierto). Si auto-plan declaró `skip`, tomar el OBJECTIVE como única tarea.
4. **Ramas verificadas**: ejecutar `agent-workflow sources`. Si alguna no coincide, aplicar `references/branch-verification.md` antes de cualquier Edit/Write.

## Modos de operación

`implement` opera en dos modos según TASKS.md:

| Modo | Detección | Comportamiento |
|---|---|---|
| **Flat** (default histórico, v1.x) | TASKS.md sin secciones `## Phase X — Y` (ni sinónimos) | Loop lineal sobre todas las tareas hasta cerrar todas. |
| **Phased** (v2.0+, default-on para `## Type: feature\|refactor`) | TASKS.md con ≥2 secciones `## (Phase\|Fase\|Sprint\|Etapa) X — Y` (ver §"Phased mode") | Loop por phase, gate M6 entre phases. DESIGN.md + S7 fueron disparados antes de Phase 0 desde planning closure (no aquí). |

El modo se detecta al iniciar el loop y al releer `TASKS.md` entre tareas (permite promoción mid-session). Phased se activa cuando OBJECTIVE declara `## Type: feature|refactor` (canónico) o `## Tipo: feature|refactor` (alias legacy ES). Default-on `feature` cuando no se declara — ver §"Resolución del `## Type`". Detalles en `agent-workflow:dev-workflow` §"Convención `## Type`".

## Loop de implementación (flat mode)

```
[take task] → [verify branch] → [minimal change]
                                       ↓
                                   [show diff]
                                       ↓
                              [register DECISION if non-obvious]
                                       ↓
                                  [mark task done]
                                       ↓
                              [next task or checkpoint]
```

### 1. Tomar una tarea

Leer `TASKS.md` y elegir la primera tarea abierta (`- [ ] ...`). Si hay dependencias declaradas, respetarlas.

### 2. Verificar rama (cada vez)

Antes de cualquier Edit/Write/MultiEdit:

```
agent-workflow check-branch --file <path> --strict
```

El hook PreToolUse lo hace automático. Si falla → aplicar `references/branch-verification.md`.

### 3. Cambio mínimo necesario

- Diffs incrementales, nunca todo al final.
- Una preocupación por diff (separar refactor de feature).
- Respetar convenciones del stack — invocar **`coding-standards`** para revisar.
- Si es UI/formularios → invocar **`frontend-design`** para principios.
- Si es SQL → invocar **`sql-script-organizer`** desde el primer `.sql`. Aplicar el header canónico de 4 líneas (Script/Sesion/Objeto/Alcance), separadores simples y CTEs sobre `DO`/`LOOP` definidos ahí.

### 4. Mostrar diff al usuario

Diff breve (no el archivo completo). Si el cambio fue trivial y obvio, omitir.

### 5. Registrar DECISIONS.md (sólo lo no obvio)

```markdown
## DEC-NNN: <título corto>

Decisión: <qué se decidió>.

Por qué: <motivación + alternativas descartadas>.

Cuándo: <date>.
```

NO registrar:
- Cambios obvios (rename, formatting, fix de typo).
- Decisiones que ya están en docs/decisiones/.
- Comentarios sobre el qué (eso lo dicen los identificadores).

### 6. Marcar tarea cerrada

Editar `TASKS.md`: `- [ ] Foo` → `- [x] Foo`. Atomic.

### 7. Iterar

Si quedan tareas abiertas, volver a paso 1. Cuando todas cerradas, propagar a `agent-workflow:session` para entrar a `validation`.

## Reglas

- **Sin builds/tests automáticos**: respetar `validation_mode` (default `ask`). El usuario decide cuándo validar.
- **Si algo falla** (compilación, test inesperado): aplicar `references/rollback-guide.md` inmediatamente. NO acumular fallos.
- **El hook PreToolUse bloquea Edit/Write si la rama no coincide**: confiá en él, no skippes.
- **No tocar archivos fuera de fuentes declaradas**: si el cambio requiere otro repo, agregarlo primero a `## Fuentes` del AW-PROJECT (sugerencia al usuario).
- **DEPENDENCIES.md**: si introducís una librería/microservicio nuevo al stack, registrarlo. No esperar al cierre.
- **SQL = script + ejecución manual del usuario**: si la tarea toca BD, el cambio se materializa como `.sql` versionado bajo `docs/scripts/` del workspace de la fuente (la skill `sql-script-organizer` define layout y categorías). El loop de implement **nunca ejecuta el script** — ni vía MCP `<mcp-cert>`/`<mcp-prod>`, ni vía `Bash` (psql, cliente DB), ni vía cualquier otro canal. El usuario aplica el script manualmente y confirma; recién ahí la tarea se cierra. Excepción única: el usuario explícitamente delega ejecución, y aún así con confirmación por bloque.

## Phased mode (v2.7+)

Activo cuando TASKS.md tiene ≥2 secciones `## Phase X — Y`. Loop por phase:

```
[planning closure: DESIGN.md producido → S7 design-review → user approves]
        ↓
[detect phases in TASKS.md]
        ↓
   Phase 0 — Mapeo + Contrato
        ↓ todas las tasks de Phase 0 cerradas
   ┌────────────────────────────────────────┐
   │ M6 — phase-gate                        │ ← cierre de cualquier phase
   │ "avanzamos a Phase X+1?"               │
   └────────────────────────────────────────┘
        ↓ user aprueba avanzar
   Phase 1 — Lecturas
        ↓ M6 → Phase 2 — Escritura (sin validaciones)
        ↓ M6 → Phase 3 — Validaciones / Correcciones
        ↓ M6 → Phase 4 — Seguridad (placeholder; skip silencioso si vacía)
        ↓ M6 → Phase 5 — Optimizaciones (opt-in; skip silencioso si no declarada)
        ↓
   propagar a validation lifecycle phase
```

> **M9 retirado v2.8+**: el gate de design review que existía al cerrar Phase 0 (M9 contract-review) se movió a antes de Phase 0 vía S7 design-review, disparado desde `skills/session/SKILL.md` durante el cierre de planning. La validación post-implementación se delega al skill futuro `agent-workflow:review <sessionNNN>`.

### Phases canónicas (v2.7+ — 6 phases)

| Phase | Título | Qué incluye | Outputs típicos |
|---|---|---|---|
| **0** | Mapeo + Contrato | Interfaces FE (services `throw "not impl"`), DTOs BE Sparse (records vacíos), endpoints 501, funciones BD que devuelven mock. **Routing FE↔BE conectado** (la app navega y consume mocks). Cableado e2e sin lógica. | Walking skeleton e2e navegable; click "Ingresar" lleva a home; home consume mocks. |
| **1** | Lecturas | GET endpoints, queries SELECT, listados, combos, filtros, paginación con datos reales. **Solo BE.** El FE ya está integrado desde Phase 0. | Listado funcional con datos reales; sin formularios de edición. |
| **2** | Escritura | POST/PATCH/DELETE funcionales, Sparse DTOs, scripts SQL DDL/DML. **Sin Bean Validation aún** (eso va a Phase 3). | CRUD funcional. Endpoints aceptan input y mutan estado; ante input malformado pueden devolver 500 (esperado, se cubre en Phase 3). |
| **3** | Validaciones / Correcciones | Bean Validation con groups, handler global de errores 400 estructurado, validaciones FE inline, reglas de negocio, cleanup smells, fixes de bugs detectados durante Phases 1-2. | CRUD robusto; input malformado retorna 400 con `field`+`message`; reglas de negocio activas. |
| **4** | Seguridad | **Placeholder con `## Estado: pendiente-spec`**. Bullets canónicos a completar en sesiones analyze propuesta futuras: RBAC, validar caller, no leakear info en logs/errores, secrets handling, CSRF, XSS, SQL injection guard, rate limiting. **Skip silencioso si la sección queda vacía en TASKS.md**. | Cuando la spec exista: hardening explícito documentado por session. Hoy: placeholder. |
| **5** | Optimizaciones | Performance review: queries (planes EXPLAIN, índices), métodos sync vs async, hilos/colas, caching, lazy loading. **Opt-in: skip si TASKS.md no la declara**. | Mejoras concretas medibles; sin fold con `coding-standards` ni `testing-strategy`. |

> **Por qué este orden** (CQRS incremental + Walking Skeleton + separación validación/seguridad/perf): primero validás cableado + routing (Phase 0), después lecturas (Phase 1, sin riesgo de corromper datos), después escritura (Phase 2, riesgo controlado), después blindás contra input malformado (Phase 3), después seguridad (Phase 4, opt-in cuando exista spec), por último optimizás lo que ya es correcto (Phase 5, opt-in). Maps a [Microsoft Learn — CQRS](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs) y [Cockburn — Walking Skeleton](https://codeclimate.com/blog/kickstart-your-next-project-with-a-walking-skeleton).
>
> **Compat v2.0/v2.6**: TASKS.md de sesiones legacy con sólo Phase 0/1/2 (donde Phase 2 contenía validaciones) sigue procesándose tal cual. El loop no fuerza la separación retroactivamente. El modelo de 6 phases aplica a sesiones nuevas.

### Detección

Al iniciar el loop:

```bash
grep -E '^## (Phase|Fase|Sprint|Etapa) [0-9]+( — .+)?$' .workflow/sessions/<folder>/TASKS.md | wc -l
```

Si ≥2 → phased mode. Si <2 → flat mode (compat v1.x).

`Phase` es la forma canónica recomendada. `Fase`, `Sprint` y `Etapa` son sinónimos aceptados sin diferencia funcional — el detector los trata igual. El " — `<title>`" después del número es opcional para tolerar TASKS.md mínimos. Ver apéndice "Convención de naming phased" en `agent-workflow:prompts-catalog`.

### Gates

#### Cierre de Phase 0 → M6 directo (M9 retirado v2.8+)

Cuando TODAS las `- [ ]` de la sección `## Phase 0 — Contrato` (o sus sinónimos `## Fase 0`/`## Sprint 0`/`## Etapa 0`) quedan en `- [x]`:

1. Disparar M6 (phase-gate) directo. M9 fue retirado por DEC-002 de session049 — el design review ya ocurrió antes de Phase 0 vía S7 en planning closure.
2. La validación post-implementación se delega al skill futuro `agent-workflow:review <sessionNNN>` (placeholder DEC-002 de session049, R5 de CONCLUSIONS), que opera sobre sesiones cerradas en lugar de dentro del mismo ciclo de desarrollo.

#### Cierre de Phase X → M6 (phase-gate, mandatorio entre phases)

Cuando TODAS las `- [ ]` de la sección `## Phase X — Y` (o sinónimos `## Fase X`/`## Sprint X`/`## Etapa X`) quedan en `- [x]` y existe la siguiente:

1. **Dispara `AskUserQuestion`** con spec de M6 (`agent-workflow:prompts-catalog#M6`). Header `phase-gate`, 3 opciones (Avanzar / Pausar / Re-iterar) + preview opcional cuando current_phase=0. NUNCA narrar la pregunta en texto plano (ej. "¿Avanzamos al Sprint 2?" en chat es un anti-patrón).
2. Si usuario elige opción 1 ("Avanzar"): tomar primera task de la phase siguiente, continuar loop.
3. Si usuario elige opción 2 ("Pausar"): detener loop. Esperar señal explícita de retomar.
4. Si usuario elige opción 3 ("Re-iterar Phase X"): el AI propone tareas adicionales en la phase actual (con DECISIÓN nueva justificando) o el usuario las añade.

#### Cierre de la última Phase → propagar a validation

Cuando TODAS las phases quedan cerradas, NO disparar M6. Propagar a `validation` directamente (lifecycle universal).

### Reglas adicionales en phased mode

- **No saltar phases**: `implement` siempre toma tareas de la phase actual antes de pasar a la siguiente. Si una task de Phase 1 queda incompleta cuando Phase 0 se cierra, no se avanza — re-abre la task que falta.
- **Promoción mid-session**: si el usuario edita TASKS.md entre tareas para reorganizar phases, `implement` releé al iniciar el siguiente take. Tareas marcadas `[x]` no se reabren automáticamente.
- **Phase 4 placeholder skip silencioso**: si `## Phase 4 — Seguridad` no está en TASKS.md o existe pero sin tasks abiertas (sólo prosa de "pendiente-spec"), `implement` no dispara M6 entre Phase 3→Phase 4; salta a Phase 5 si está declarada o propaga a validation si no.
- **Phase 5 opt-in skip silencioso**: si `## Phase 5 — Optimizaciones` no está en TASKS.md, `implement` propaga a validation tras cerrar la última phase declarada (Phase 3 típicamente). El usuario puede agregar Phase 5 mid-session si descubre la necesidad — `implement` la detecta al releer.
- **Refactor compose**: cuando la sesión es `## Type: refactor` (alias legacy `## Tipo: refactor`), el skill `refactor` genera el TASKS.md phased (con las 6 phases según alcance: Phase 5 típicamente sí porque refactor suele tocar performance) y hace hand-off; `implement` solo ejecuta el loop. Las acciones específicas de refactor (rename legacy, cleanup) las maneja `refactor` con M7/M8 fuera del loop de `implement`.

## Resolución del `## Type` — defensa en profundidad

Tres capas garantizan que `## Type` nunca esté ausente en sesiones nuevas:

**Capa 1 — CLI template inyecta `## Type` siempre (Mit-A)**

`agent-workflow session-create --flow dev` produce `OBJECTIVE.md` con `## Type: <valor>` materializado en posición canónica (línea 3 si no hay `## Origin`, después de `## Origin` si existe). Nunca emite OBJECTIVE.md sin la sección.

**Capa 2 — Heurística decide el valor (Mit-C)**

El CLI analiza `--objetivo` con keywords (de `dev-workflow:97-103`) y elige tipo + confianza. Flag opcional `--type <valor>` para override explícito. Detalles en `agent-workflow-cli` módulo `infer-type.ts`.

**Capa 3 — Default-on en lectura para sesiones legacy/migradas**

`implement` lee OBJECTIVE.md en cada iteración:
- Si tiene `## Type: <valor>` → usar `<valor>`.
- Si tiene `## Tipo: <valor>` (legacy ES) → leer vía alias bilingüe `parseTypeFromObjetivo()` y normalizar a EN.
- Si no tiene ninguno → asumir `feature` y emitir log:
  ```
  [implement] Type no declarado en OBJECTIVE.md → asumiendo 'feature' por default-on. Declarar explícito si querés sobrescribir.
  ```

**Cobertura de casos**:
- Sesiones legacy pre-v2.7: cubierto por Capa 3.
- Sesiones creadas sin `## Type` por bug del template: resuelto por Capa 1.
- Usuario borra `## Type`: cubierto por Capa 3 con log.
- Sesiones migradas desde otro workspace: cubierto por Capa 3.

**Alias bilingüe `## Type` ↔ `## Tipo`**: parser acepta ambas formas; escritura canónica es `## Type`. Convivencia alineada con `OBJETIVO.md` ↔ `OBJECTIVE.md`, `DECISIONES.md` ↔ `DECISIONS.md`. Cero migración forzada de sesiones cerradas.

## Bugfix doctrina (flat mode v2.7+)

Cuando OBJECTIVE declara `## Type: bugfix` (alias legacy `## Tipo`), `implement` cae a flat mode (sin phases) pero aplica una doctrina de 3 pasos canónicos:

1. **Reproducir + diagnosticar**: el AI compone `superpowers:systematic-debugging` (root-cause analysis sistemático) antes de proponer fix. Output: 1 DEC mínima en DECISIONS.md con causa raíz identificada o hipótesis a validar.
2. **Aplicar fix mínimo**: loop flat normal, 1-3 tareas como mucho, sin gates M6 (ni DESIGN.md/S7 — type bugfix los excluye).
3. **Verificación específica del bug**: `testing-strategy` exige test de regresión que reproduce el bug original (criterio de hecho: el test rompe antes del fix y pasa después).

**Skip permitido del paso 1** si el bug es trivialmente obvio (1 line con justificación inline en DECISIONS (legacy: DECISIONES), ej. "typo en regex que rompía parsing — sin causa raíz adicional").

**Fallback si `superpowers:systematic-debugging` no está instalado**: aplicar guideline textual de root-cause documentado en `agent-workflow:dev-workflow` (preguntar "¿qué pasó? ¿qué cambió? ¿cuál es el error exacto? ¿se reproduce?" antes de fix).

**Sin nuevo `## Type: hotfix`**: la urgencia se expresa en el OBJECTIVE ("hotfix prod sangrando") y en saltar Phase 4/5 cuando aplica; no requiere cardinalidad nueva en `## Type`.

## Composición con otras skills

| Skill | Cuándo |
|---|---|
| `coding-standards` | revisar calidad de cada diff (fail fast, logging, naming, security, **reglas FE-BE Sparse DTO/PATCH**) |
| `frontend-design` | layout, formularios, modales, navegación, feedback (UI/UX) |
| `refactor` | sesiones con `## Type: refactor` (alias legacy `## Tipo`). Genera TASKS.md phased y hace hand-off; `implement` ejecuta el loop. M7/M8 los maneja `refactor`. |
| `sql-script-organizer` | tan pronto haya un `.sql` en `scripts/` |
| `sql-rollback-generator` | en paralelo a sql-script-organizer (forward + rollback siempre acoplados) |
| `testing-strategy` | en validation, o cuando el usuario pide tests durante execution |

NO duplicar lógica entre skills — invocar la especializada.

## Checklist de calidad antes de cada diff

- [ ] **Fail fast**: validaciones + early returns al inicio.
- [ ] **Logging**: ERROR/WARN/INFO/DEBUG apropiado, sin datos sensibles.
- [ ] **Seguridad**: sin secrets hardcoded, SQL parametrizado, no XSS/injection.
- [ ] **Naming descriptivo**: no abreviaturas oscuras, no `tmp`/`foo`.
- [ ] **Comentarios sólo para WHY**: el qué lo dice el código.
- [ ] **Convenciones del stack**: invocar `coding-standards` si dudas.
- [ ] **Si es UI**: invocar `frontend-design`.

## Sandbox read-only

Reglas universales en `../session/references/sandbox-readonly-rules.md` (canon v2.1+). En plan mode esta skill describe en el plan file:

- **Tarea elegida** del TASKS.md (cuál tomar, en qué orden) — sin marcarla en progreso.
- **Archivos a editar/crear**: rutas absolutas o relativas + resumen del cambio (no el código completo).
- **Decisión a registrar** en DECISIONS.md si aplica: número DEC-NNN propuesto + 2-3 líneas de "qué" y "por qué".
- **Rama esperada**: comando `git branch --show-current` (read-only) para validar; si no matchea, describir el flujo de `references/branch-verification.md` sin ejecutarlo.
- **Tests a correr post-cambio**: nombre del comando + scope.

NO ejecuta: `Edit`, `Write`, `Bash` con efectos (commits, npm install, mvn package), ni `agent-workflow graduate`/`session-close`/`phase-next`.

## Política de commits

`implement` **nunca** ejecuta `git commit`/`push`/`merge`/`rebase`/`tag` por iniciativa propia, ni siquiera tras completar una tarea. Si el usuario pide explícitamente commitear durante execution, aplicar `agent-workflow:commits-policy` Regla 3 (propose-then-execute universal con `AskUserQuestion` M1) o Regla 5 (bypass si el usuario aporta el mensaje literal). El formato canónico (1 línea, tag `session<CODE>`, sin co-author) lo provee el mensaje sugerido del prompt. La fase `closure` de `agent-workflow:session` ejecuta el mismo flujo M1 auto-disparado por dirty sources.

## Recursos

- `references/branch-verification.md` — flujo cuando la rama no coincide.
- `references/rollback-guide.md` — qué hacer si un cambio falla.
- `coding-standards` — skill hermano para revisar calidad.
- `coding-standards/references/fe-be-integration.md` — reglas Sparse DTO + PATCH + sin fallbacks ocultos.
- `refactor` — skill hermano para refactors phased (Strangler Fig).
- `agent-workflow:prompts-catalog` M6 (phase-gate) — spec literal del gate phased entre phases. S7 (design-review) dispara desde `skills/session/SKILL.md` durante planning closure, no acá.
- `references/design-md-template.md` — template canónico del DESIGN.md producido para sesiones `## Type: feature|refactor`.
- `agent-workflow:session` — lifecycle universal que invoca este skill.
- `agent-workflow:commits-policy` — política controlada de commits cross-plugin.
- shared-contract §14 — fase `execution` del lifecycle universal.
- shared-contract §15 — naming convention de specialty skills.
