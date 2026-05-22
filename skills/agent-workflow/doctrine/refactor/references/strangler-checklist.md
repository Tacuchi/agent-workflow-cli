# Strangler Fig — checklist de 12 pasos para refactor

Pasos canónicos del skill `agent-workflow:refactor`. Reflejan Strangler Fig (Fowler) adaptado al stack agent-workflow con flujo phased y prompts M7/M8/M6 + S7 (pre-Phase 0). M9 retirado en v2.8+ por DEC-002 de session049 — reemplazado por S7 desde planning closure.

## Discovery (paso 1-2)

### 1. Análisis legacy

Compone con `agent-workflow:analyze-investigate`. Outputs en REFACTOR.md sección "Análisis legacy":

- Paths FE / BE / DB.
- Endpoints actuales (verbo, path, DTOs).
- DTOs (counts, redundancias).
- Validaciones y reglas de negocio detectadas en el código.
- Accesos / roles.
- Smells (DTOs duplicados, fallbacks que ocultan errores, PUT en lugar de PATCH, etc.).

### 2. REFACTOR.md draft

AI redacta sección "Análisis legacy" + "Diseño nuevo" + "Plan de migración" (1-12) + "Estado" inicial (`status: discovery`).

Usuario revisa el draft. Si aprueba → paso 3. Si pide cambios, AI itera.

## Marcar legacy (paso 3-5)

### 3. M7 — refactor-legacy-detected

Prompt al usuario con 3 opciones (rename + AI imports / rename + IDE imports / solo análisis). Spec literal en `agent-workflow:prompts-catalog#M7`.

### 4. Rename Strangler

- FE: `git mv <repo>/src/.../<feature>/ <repo>/src/.../<feature>-legacy/`.
- BE (Spring/Java): renombrar paquete `<feature>` → `<feature>_legacy`, actualizar imports si la opción A fue elegida.
- BD: **NO** se renombran funciones/SP — la BD es estado, no código. Las funciones nuevas se crean en paralelo durante Phase 0/1/2 con nombres canónicos.

### 5. Crear `<feature>/` vacía

- FE: crear `src/.../<feature>/` con módulo skeleton (NgModule vacío + service stub).
- BE: crear paquete `<feature>` con controller stub + DTOs vacíos (Sparse DTO).

REFACTOR.md → `status: legacy-marked`.

## Generar TASKS.md phased (paso 6)

### 6. Hand off a `implement`

`refactor` genera TASKS.md con secciones canónicas:

```markdown
## Phase 0 — Contrato
- [ ] Interfaces FE: `<Feature>Service` con métodos `list/save/delete` que arrojan "not impl"
- [ ] DTOs BE: record `<Feature>SaveRequest` (Sparse, campos nullable)
- [ ] Endpoints BE: `@PatchMapping` que devuelven 501
- [ ] Funciones BD: `fn_<feature>_listar` que devuelve mock `[]::jsonb`
- [ ] Cableado: FE llama BE → 501 capturado por handler → toast informativo

## Phase 1 — Lecturas
- [ ] GET /api/<feature> con paginación + filtros
- [ ] FE listado con grilla, combos, search
- [ ] Funciones BD reales para SELECT
- [ ] Tests unitarios de queries (si aplica)

## Phase 2 — Mutaciones
- [ ] POST /api/<feature> (create con Sparse DTO)
- [ ] PATCH /api/<feature>/{id} (edit sparse, null = no tocar)
- [ ] DELETE /api/<feature>/{id}
- [ ] FE formularios con validación
- [ ] Scripts SQL: DDL/DML reales bajo `docs/scripts/`
- [ ] Tests e2e si aplica
```

`implement` toma TASKS.md y ejecuta el loop con M6 (phase-gate Phase 1→2). S7 (design-review) fue disparado antes de Phase 0 desde planning closure de `skills/session/SKILL.md` (v2.8+ — reemplazó a M9 que disparaba post-stub).

REFACTOR.md → `status: implementing`, `phase: 0`.

## Validación (paso 7-8)

### 7. Validación e2e

Cuando `implement` cierra Phase 2, REFACTOR.md → `status: validating`.

El usuario:
- Levanta FE + BE en local.
- Ejecuta scripts SQL contra cert.
- Prueba flujos: create, list, filter, edit (sparse), delete.
- Compara contra el comportamiento legacy si está disponible.

Confirma con la AI: "validado, todo funciona".

REFACTOR.md → `status: completed` (pero `legacy_purged: false` aún).

### 8. M8 — refactor-cleanup

Prompt al usuario con 3 opciones (eliminar / mantener / cancelar). Spec literal en `agent-workflow:prompts-catalog#M8`.

Si elige eliminar:
- `git rm -r <repo>/src/.../<feature>-legacy/` (FE).
- `git rm -r <package>_legacy/` (BE) si aplica.
- BD: si hay funciones legacy paralelas que deben removerse, generar script SQL bajo `.workflow/sessions/<sessionNNN>/scripts/cleanup-<feature>.sql` con `DROP FUNCTION IF EXISTS ...`. El bundle final se arma vía `/agent-workflow:release` (kind=`script`). **El AI NO ejecuta el script** — el usuario lo aplica.

REFACTOR.md → `legacy_purged: true`.

## Closure

REFACTOR.md vive en la sesión (`.workflow/sessions/<folder>/REFACTOR.md`) y **no se gradúa con kind dedicado** (DEC-003). Si el documento amerita preservarse fuera de la sesión, el usuario lo cura como `manual` o `especificacion`. La sesión cierra siguiendo el flujo estándar (commits via M1, compact, session-close).

## Errores y rollback

| Situación | Acción |
|---|---|
| Phase 1 falla, lecturas no funcionan | Re-iterar Phase 1 (M6 opción 3) sin tocar legacy. Legacy sigue funcionando como referencia. |
| Phase 2 falla, mutaciones rompen | Re-iterar Phase 2 con DECISION nueva en DECISIONS.md. Legacy sigue intacto. |
| Validación e2e descubre regresión grave | Pausar refactor, abrir DECISIÓN documentando, decidir si seguir o rollback. NO disparar M8 cleanup. |
| Usuario abandona el refactor a mitad de camino | REFACTOR.md mantiene `status: implementing` o `validating`; legacy sigue intacto. La sesión se puede retomar más tarde. |

**Nunca** se borra el legacy hasta que M8 se confirme con `## Estado: completed` + validación e2e explícita del usuario. Esto garantiza que el rollback siempre es posible (Strangler Fig: "transform → coexist → eliminate").
