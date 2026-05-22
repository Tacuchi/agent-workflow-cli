---
name: refactor
description: "Orquesta el rebuild de un feature existente al estándar nuevo (Sparse DTO unificado, PATCH, sin fallbacks, phased Phase 0-5) usando migración Strangler Fig. Activado automáticamente cuando una sesión flow=dev declara `## Type: refactor` en OBJECTIVE.md (alias legacy `## Tipo`). Compone con agent-workflow:analyze-investigate (discovery legacy) y agent-workflow:implement (ejecución phased). Produce REFACTOR.md como artefacto canónico. v1.1+ alinea el TASKS.md generado a las 6 phases del modelo extendido."
version: 1.3.1
---

> **Profile parametrization**: lee `examples_path` de `profile.json` (resuelto vía cascade 5 capas). Ver [`references/profile-parametrization.md`](../../references/profile-parametrization.md) para el contrato completo y comportamiento por defecto cuando el profile está vacío.

# Refactor — qtc v2.8+

Skill de especialidad **dev**: orquesta refactors feature-completos siguiendo Strangler Fig (Fowler) — análisis legacy → rebuild paralelo desde cero → cleanup.

> **Modelo de artefactos (DEC-003)**: REFACTOR.md vive en la sesión (`.workflow/sessions/<folder>/REFACTOR.md`) y **no se gradúa con kind dedicado** — los kinds graduables son `decision|manual|script|especificacion|conclusion|release`. Si el REFACTOR.md amerita preservarse fuera de la sesión, el camino es:
>
> - Curarlo manualmente como `manual` (`docs/manuales/`) si describe cómo se reorganiza el módulo.
> - O como `especificacion` (`docs/especificaciones/`) si describe el contrato del módulo nuevo.
> - O dejarlo en la sesión cerrada (consultable vía `.workflow/sessions/<folder>/REFACTOR.md`).

## Cuándo se invoca

- **Composición desde `agent-workflow:session`** (lo más común): cuando una sesión `flow=dev` declara `## Type: refactor` en OBJECTIVE.md y entra a `execution`.
- **NL del usuario**: "refactorizá X al nuevo estándar", "rebuild de Y siguiendo phased", "migrá Z a Sparse DTO".
- **Standalone vía `/agent-workflow:use`**: produce REFACTOR.md exploratorio sin tocar paths (modo `status: discovery` permanente).

NO se activa automáticamente fuera de `## Type: refactor`. Para refactors triviales (1 archivo) seguir flat mode con `## Type: chore`.

## Pre-requisitos

1. **Sesión activa** con `## Type: refactor` en OBJECTIVE.md (excepto modo standalone).
2. **Feature target identificable**: path o nombre del módulo legacy en el Brief del OBJECTIVE.
3. **Ramas verificadas**: `agent-workflow sources` consistente; aplicar `branch-verification.md` si difiere.
4. **Stack detectado**: `agent-workflow stack` para conocer convenciones de la fuente.

## Loop (overview)

```
[discovery]                                       (paso 1, T2.1)
  ↓ compone agent-workflow:analyze-investigate
[REFACTOR.md draft]                               (paso 2)
  ↓ user review
[M7 — refactor-legacy-detected]                   (paso 3)
  ↓ rename Strangler
[<feature>-legacy/ + <feature>/ vacía]            (paso 4)
  ↓
[generar TASKS.md phased]                         (paso 5)
  ↓
[hand off → agent-workflow:implement (Phase 0/1/2)]      (paso 6)
  ↓ con S7 (pre-Phase 0, design review desde planning closure) y M6 (entre phases)
[validación e2e usuario]                          (paso 7)
  ↓
[M8 — refactor-cleanup]                           (paso 8)
  ↓ delete <feature>-legacy/
[REFACTOR.md ## Estado: completed]
```

## Composición

| Skill | Cuándo | Rol |
|---|---|---|
| `agent-workflow:analyze-investigate` | paso 1 | Lee paths legacy, traza endpoints, valida contra BD (read-only via MCP <mcp-cert>), produce evidencia para REFACTOR.md "Análisis legacy". |
| `agent-workflow:implement` | paso 6 | Toma TASKS.md phased y ejecuta el loop con gate M6 entre phases. S7 design-review fue disparado antes desde planning closure. |
| `agent-workflow:coding-standards` | transversal | Reglas FE-BE, fail-fast, no fallbacks ocultos. |
| `agent-workflow:sql-script-organizer` + `sql-rollback-generator` | paso 6 | Cuando el rebuild incluye DDL/funciones/migraciones de BD. |

## Loop detallado (8 pasos)

> Detalle paso a paso en `references/strangler-checklist.md`. Esta sección resume las acciones del AI por paso.

### Paso 1 — Discovery

- **Input**: OBJECTIVE.md con Brief que identifica feature target (path o nombre).
- **Acción del AI**:
  1. Compone `agent-workflow:analyze-investigate` con scope = paths legacy.
  2. Lee módulos FE, paquetes BE, funciones BD relacionadas (read-only).
  3. Identifica endpoints actuales, DTOs, validaciones, reglas de negocio, accesos.
  4. Detecta smells (DTOs duplicados Create/Update, PUT en lugar de PATCH, fallbacks que ocultan errores, lógica replicada FE+BE).
- **Output**: Evidencia parcial en memoria; aún no escribe archivos.

### Paso 2 — REFACTOR.md draft

- **Acción del AI**:
  1. Crea `.workflow/sessions/<folder>/REFACTOR.md` siguiendo `references/refactor-md-template.md`.
  2. Rellena "Análisis legacy" con la evidencia del paso 1.
  3. Rellena "Diseño nuevo" aplicando reglas FE-BE (Sparse DTO unificado, PATCH, no fallbacks).
  4. Rellena "Plan de migración" (12 pasos) y "Estado" inicial (`status: discovery`).
- **Espera review del usuario**. Si pide cambios, itera. Si aprueba → paso 3.

### Paso 3 — M7 (refactor-legacy-detected)

- **Acción del AI**:
  1. Dispara `AskUserQuestion` con spec de M7 (`agent-workflow:prompts-catalog#M7`): rename + AI imports / rename + IDE imports / solo análisis / Other custom.
  2. Si "solo análisis" o cancela → REFACTOR.md queda en `status: discovery`. La sesión puede cerrar acá como artefacto exploratorio.
  3. Si elige rename → paso 4.

### Paso 4 — Rename Strangler

- **Acción del AI** (con confirmación por archivo si la opción A "AI actualiza imports"):
  1. `git mv <fe-path>/<feature>/ <fe-path>/<feature>-legacy/` (vía Bash).
  2. Si BE: rename de paquete `<feature>` → `<feature>_legacy` (en stack Java/Spring esto es `git mv` + actualización de declaraciones `package`).
  3. Si opción A: la AI escanea `*.ts`/`*.java` con grep y actualiza `import`/`package` en lote, mostrando diff por archivo antes de aplicar.
  4. Si opción B: la AI deja imports rotos para que el usuario migre vía IDE refactor.
  5. **NO renombra funciones/SP de BD**: la BD es estado; las funciones nuevas se crean en paralelo durante Phase 0/1/2.
- **Output**: REFACTOR.md → `status: legacy-marked`.

### Paso 5 — Crear `<feature>/` vacía

- **Acción del AI**:
  1. FE: crea `src/.../<feature>/` con `*.module.ts`, `*.routing.module.ts`, service stub, component stub. Solo skeleton.
  2. BE: crea paquete `<feature>` con `<Feature>Controller`, `<Feature>Service`, `<Feature>SaveRequest` (record con campos nullable, sin lógica).
- **Output**: paths nuevos vacíos listos para Phase 0 stub.

### Paso 6 — Generar TASKS.md phased + hand off a `implement`

- **Acción del AI**:
  1. Genera `TASKS.md` con las 6 secciones canónicas (modelo v2.7+):
     - `## Phase 0 — Mapeo + Contrato`: stubs FE, DTOs BE Sparse, endpoints 501, funciones BD mock, **routing FE↔BE conectado a mocks**.
     - `## Phase 1 — Lecturas`: GET, listados, combos, filtros con datos reales.
     - `## Phase 2 — Escritura`: POST/PATCH/DELETE funcionales sin Bean Validation; scripts SQL DDL/DML.
     - `## Phase 3 — Validaciones / Correcciones`: Bean Validation con groups, handler global, validaciones FE inline, reglas de negocio, cleanup smells.
     - `## Phase 4 — Seguridad`: placeholder con `## Estado: pendiente-spec` por default; agregar tareas concretas si la sesión analyze de seguridad ya produjo CONCLUSIONS.md (legacy: CONCLUSIONES.md) de modalidad=technical.
     - `## Phase 5 — Optimizaciones`: típicamente **sí se incluye en refactors** porque suelen tocar performance (queries con joins, listados grandes, índices). Skip sólo si el alcance del refactor es puramente de doctrina (cambio de DTO, rename, etc.).
  2. Hand-off a `agent-workflow:implement` que toma el control del loop con gate M6 entre phases (skip silencioso para Phase 4 vacía y Phase 5 opt-in). S7 design-review fue disparado antes desde planning closure (v2.8+ — reemplazó a M9).
  3. REFACTOR.md → `status: implementing`, `phase: 0`. Se actualiza al cerrar cada phase (`phase: 1`, `phase: 2`, `phase: 3`, `phase: 4` si aplica, `phase: 5` si aplica, `phase: done`).
- **Output**: implement asume el control. `refactor` queda en hold hasta paso 7.

### Paso 7 — Validación e2e por usuario

- **Trigger**: `implement` cierra la última phase declarada del refactor (típicamente Phase 5; Phase 3 si optimizaciones no aplica) sin más tasks abiertas.
- **Acción del AI**: marca REFACTOR.md → `status: validating`. Notifica al usuario.
- **Acción del usuario**:
  1. Levanta FE + BE en local.
  2. Aplica scripts SQL contra cert (manual; el AI no los ejecuta).
  3. Prueba: create, list, filter, edit (sparse), delete.
  4. Verifica que validaciones (Phase 3) responden 400 estructurado ante input malformado.
  5. **Si Phase 3 incluyó cleanup smells**: confirmar que los smells canónicos del análisis legacy quedaron resueltos.
  6. Compara contra el comportamiento legacy si está disponible.
  7. Confirma: "validado, todo funciona" → REFACTOR.md `status: completed` (legacy_purged: false aún).

### Paso 8 — M8 (refactor-cleanup)

- **Acción del AI**:
  1. Verifica que `status: completed`. Si no, error informativo y aborta.
  2. Dispara `AskUserQuestion` con spec de M8 (`agent-workflow:prompts-catalog#M8`): eliminar / mantener temporalmente / cancelar / Other.
  3. Si "eliminar":
     - `git rm -r <fe-path>/<feature>-legacy/`.
     - `git rm -r <be-path>/<feature>_legacy/` si aplica al stack.
     - BD: si hay funciones legacy paralelas, **genera script SQL** bajo `.workflow/sessions/<sessionNNN>/scripts/cleanup-<feature>.sql` con `DROP FUNCTION IF EXISTS ...`. El bundle final se arma vía `/agent-workflow:release` (kind=`script` → `docs/scripts/`). **NO ejecuta el script**; el usuario lo aplica.
     - REFACTOR.md → `legacy_purged: true`.
  4. Si "mantener": REFACTOR.md → `legacy_purged: false` con TODO en sección Estado. Cleanup queda para sesión follow-up.
  5. Si "cancelar": no toca nada. Closure no completa hasta resolver.

## Política de commits

Política canónica: ver `agent-workflow:commits-policy` (Regla 3 propose-then-execute universal). Cualquier commit durante el refactor — closure auto-disparado o solicitud explícita del usuario — pasa por el flujo M1.

Excepción específica de `refactor`: el rename del paso 4 (`git mv`) se ejecuta porque es una mutación de filesystem que altera el árbol antes de que las edits fluyan. El AI lo reporta inmediatamente al usuario y deja el `git status` visible.

## Política de SQL

Igual que el resto de agent-workflow: **scripts versionados, no ejecución directa**. Los scripts BD (forwards en Phase 1/2 y cleanup en paso 8) se materializan bajo `docs/scripts/<sessionNNN>/` siguiendo `agent-workflow:sql-script-organizer`. El usuario los aplica manualmente contra cert/prod.

## Standalone mode

Cuando el usuario invoca `/agent-workflow:use` y describe un refactor sin sesión activa:

1. El skill `refactor` se activa con `status: discovery` permanente.
2. Produce `REFACTOR.md` en el CWD (no en `.workflow/sessions/`).
3. **No ejecuta paso 3-8**: solo análisis y diseño. M7/M8 quedan deshabilitados.
4. El usuario puede usar el REFACTOR.md como input para una sesión `/agent-workflow:session create` con `## Type: refactor` posteriormente.

## Errores y rollback

| Situación | Acción |
|---|---|
| Phase 1 falla (lecturas no funcionan) | Re-iterar Phase 1 con M6 opción 3. Legacy sigue intacto. |
| Phase 2 falla (mutaciones rompen) | Re-iterar Phase 2 con DECISIÓN nueva en DECISIONS.md (legacy: DECISIONES.md). Legacy sigue intacto. |
| Validación e2e descubre regresión | Pausar, registrar DECISIÓN, decidir: seguir o rollback. NO disparar M8. |
| Usuario abandona el refactor | REFACTOR.md mantiene `status: implementing|validating`. Legacy sigue intacto. La sesión se puede retomar más tarde. |
| `git mv` falla (paths con conflictos) | Reportar al usuario, abortar paso 4. NO continuar con paso 5. |

**Nunca** se borra el legacy hasta que M8 se confirme con `## Estado: completed` + validación e2e explícita del usuario. Garantía Strangler Fig: rollback siempre posible.

## Reglas

- **No commits autónomos**: ver §"Política de commits" arriba.
- **No SQL contra BD**: el rebuild materializa scripts en `docs/scripts/` del workspace de la fuente. El usuario los aplica manualmente.
- **No tocar paths fuera de la fuente declarada**: si el rebuild requiere otra fuente, agregarla primero a `## Fuentes` del AW-PROJECT.
- **Validación e2e es mandatoria**: M8 (cleanup) NO se dispara hasta que el usuario confirme `status: validating → validated`.

## Sandbox read-only

Reglas universales en `../session/references/sandbox-readonly-rules.md`. En plan mode esta skill describe en el plan file:

- **Discovery target**: paths legacy, endpoints actuales, stack detectado.
- **Plan de rename**: paths antes/después, archivos con imports a migrar.
- **TASKS.md phased que se generaría**: secciones Phase 0/1/2 sin ejecutar.
- **Rama esperada**: `git branch --show-current` (read-only).

NO ejecuta: `git mv`, `Edit`, `Write`, `Bash` con efectos, ni hand-off a `implement`.

## Recursos

- `references/refactor-md-template.md` — Template REFACTOR.md (estructura canónica).
- `references/strangler-checklist.md` — 12 pasos de migración con checkboxes.
- `agent-workflow:prompts-catalog` M7 (refactor-legacy-detected), M8 (refactor-cleanup).
- `agent-workflow:commits-policy` — política controlada de commits.
- `agent-workflow:coding-standards/references/fe-be-integration.md` — reglas Sparse DTO/PATCH/no-fallbacks.
- `agent-workflow:analyze-investigate` — skill de discovery read-only invocada en paso 1.
