# Template REFACTOR.md — agent-workflow:refactor

Artefacto canónico del skill `refactor`. Vive en `.workflow/sessions/sessionNNN-dev-refactor-<slug>/REFACTOR.md` durante la sesión.

> **Modelo de artefactos (DEC-003)**: REFACTOR.md **no se gradúa con kind dedicado**. Vive en la sesión y se consulta desde ahí. Si el documento amerita preservarse, el usuario lo cura manualmente como `manual` (cómo se reorganiza el módulo) o `especificacion` (contrato del módulo nuevo). El destino al graduar respeta `workspace_mode` (DEC-002): hub mode → `<hub>/docs/<categoria>/`; project mode → `<cwd>/docs/<categoria>/`.

## Estructura mínima

```markdown
# Refactor — <feature-name>

## Análisis legacy

### Paths involucrados
- FE: `<repo>/src/<path>`
- BE: `<repo>/<package-path>`
- DB: `<schema>.<tabla>`, funciones `fn_*`, SP `sp_*`

### Endpoints actuales
| Verbo | Path | Acción | DTO request | DTO response |
|---|---|---|---|---|
| GET | `/api/<feature>` | listar | — | `<Feature>Response[]` |
| POST | `/api/<feature>` | crear | `<Feature>CreateRequest` | `<Feature>Response` |
| PUT | `/api/<feature>/{id}` | editar (full) | `<Feature>UpdateRequest` | `<Feature>Response` |
| DELETE | `/api/<feature>/{id}` | eliminar | — | 204 |

### DTOs actuales
- `<Feature>CreateRequest`: <count> campos, todos required
- `<Feature>UpdateRequest`: <count> campos, casi idénticos a Create
- `<Feature>Response`: mapeo entidad

### Validaciones / reglas de negocio
- Regla 1: …
- Regla 2: …

### Accesos / roles
- Permite roles: `admin.x`, `comercial.y`
- Bypass super-admin: sí/no

### Smells detectados (motivación del refactor)
- DTOs Create/Update duplicados (fix: Sparse DTO unificado)
- PUT envía toda la entidad (fix: PATCH sparse)
- `try/catch` que silencia errores (fix: fail-fast)
- Otros: …

## Diseño nuevo

### Paths nuevos
- FE: `<repo>/src/<path>` (mismo nombre, después de rename del legacy)
- BE: `<repo>/<package-path>` (mismo nombre, después de rename del legacy)

### Endpoints nuevos
| Verbo | Path | Acción | DTO | Cambio vs legacy |
|---|---|---|---|---|
| GET | `/api/<feature>` | listar | — / `<Feature>Response[]` | igual |
| POST | `/api/<feature>` | crear | `<Feature>SaveRequest` | DTO unificado |
| PATCH | `/api/<feature>/{id}` | editar sparse | `<Feature>SaveRequest` | PUT → PATCH; sparse |
| DELETE | `/api/<feature>/{id}` | eliminar | — | igual |

### DTOs nuevos (Sparse DTO unificado)
- `<Feature>SaveRequest`: campos nullable, sirve para create + edit. En edit, null = no tocar.
- `<Feature>Response`: ajustado si aplica.

### Reglas FE-BE aplicadas (checklist)
- [ ] Mismo DTO Create/Edit (Sparse).
- [ ] PATCH para edit, sparse object.
- [ ] BE no usa fallbacks que oculten errores; valida con Bean Validation y devuelve 400 estructurado.
- [ ] FE propaga errores HTTP via toast/mensaje (sin `catchError(() => of([]))`).
- [ ] DB: funciones nuevas arrancan en Phase 0 como stub (devuelven mock); implementación real en Phase 1/2.

## Plan de migración (12 pasos Strangler)

1. [ ] Análisis completo (esta sección + sigs.).
2. [ ] M7 confirma estrategia de rename (auto/manual/solo-análisis).
3. [ ] `git mv` FE: `src/.../<feature>/` → `src/.../<feature>-legacy/`.
4. [ ] `git mv` BE: paquete `<feature>` → `<feature>_legacy` (si aplica al stack).
5. [ ] Crear nuevo `<feature>/` en FE + BE desde cero (vacío para Phase 0).
6. [ ] Phase 0 — Contrato: interfaces FE + DTOs BE + endpoints stub + funciones BD mock.
7. [ ] M6 — phase-gate (Phase 0 → 1). [Nota: S7 design-review ya fue disparado antes de Phase 0 desde planning closure, v2.8+ — reemplazó a M9.]
8. [ ] Phase 1 — Lecturas: GET, listados, filtros, combos.
9. [ ] M6 — phase-gate (Phase 1 → 2).
10. [ ] Phase 2 — Mutaciones: POST + PATCH (sparse) + DELETE + scripts BD reales.
11. [ ] Validación e2e por usuario.
12. [ ] M8 — refactor-cleanup: `git rm -r <feature>-legacy/` + REFACTOR.md `legacy_purged: true`.

## Estado

```yaml
status: discovery | legacy-marked | implementing | validating | completed
phase: 0 | 1 | 2 | done
legacy_purged: false | true
created: 2026-MM-DD
last_update: 2026-MM-DD
```

## Refs

- Sesión origen: `.workflow/sessions/sessionNNN-dev-refactor-<slug>/`
- DECISIONS.md de la sesión: decisiones load-bearing del refactor.
- `agent-workflow:prompts-catalog` M7/M8.
- `agent-workflow:coding-standards/references/fe-be-integration.md`.
```

## Notas de uso

- **Tamaño esperado**: 200-400 líneas para un mantenimiento CRUD típico. Si crece más, dividir en sub-features (cada uno con su propia sesión `## Type: refactor`).
- **No prescribir lenguaje natural redundante**: las tablas son densas a propósito. REFACTOR.md vive en la sesión y, si amerita preservarse, se cura manualmente como `manual` o `especificacion` (DEC-003).
- **Cuando standalone (sin sesión)**: el archivo se nombra `REFACTOR-<slug>.md` en el CWD; status queda en `discovery` y no avanza.
