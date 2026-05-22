---
name: coding-standards
description: Estándares de código por stack (Java/Spring, Angular, Node) — fail-fast, logging por nivel, seguridad (no secrets, SQL parametrizado), naming descriptivo, manejo de errores, validación de input, reglas FE-BE (Sparse DTO unificado, PATCH semantics, sin fallbacks ocultos). Activar al implementar, revisar o refactorizar, o ante NL como buenas prácticas/código limpio/cómo valido este input. Referencia transversal sin dependencia de sesiones.
version: 0.4.0
---

> **Profile parametrization**: lee `mcp_databases[] + examples_path` de `profile.json` (resuelto vía cascade 5 capas). Ver [`references/profile-parametrization.md`](../../references/profile-parametrization.md) para el contrato completo y comportamiento por defecto cuando el profile está vacío.

# Coding Standards

Estándares de código aplicables durante la implementación. Consultar la referencia del stack correspondiente para detalles.

## Principios generales

- **SOLID** — Single Responsibility, Open/Closed, Liskov, Interface Segregation, Dependency Inversion
- **Fail fast** — Validar y retornar errores al inicio del método (early returns, evitar nesting)
- **Nombres descriptivos** — El código habla por sí mismo; comentarios solo para el "por qué"
- **Métodos pequeños** — Una sola responsabilidad por método/función
- **Composición sobre herencia**
- **Reutilización antes que duplicación (DRY)** — antes de crear un componente, función o clase nueva, revisar si ya existe en `shared/` (frontend) o el paquete `common/`/`util/` (backend). Si un patrón aparece 2-3 veces, proponer extracción. Aplica transversalmente; para detalles de componentes frontend y `shared/`, ver skill `frontend-design` + `references/frontend-structure.md`.

## Estándares por stack

### Java / Spring Boot
Constructor Injection (sin Field Injection), `@Transactional(readOnly=true)` para lecturas, Java records para DTOs Request/Response, Jakarta Validation para inputs. Ver `references/java-spring.md`.

### Angular / TypeScript
Constructor injection, NgModules, `async` pipe en templates, evitar `any`. Arquitectura `@data`/`@presentation`. Ver `references/angular-typescript.md` y `references/frontend-structure.md`.

## Integración FE-BE (flow=dev v2.6+)

Aplica a sesiones `flow=dev` con `## Type: feature|refactor` y a refactors guiados por `agent-workflow:refactor`. Reglas canónicas en `references/fe-be-integration.md`:

- **R1 — Sparse DTO unificado**: mismo DTO `<Feature>SaveRequest` para create + edit, todos los campos nullable. `null` = "no tocar".
- **R2 — PATCH para edit**: `@PatchMapping` en BE, `http.patch()` en FE. POST queda solo para create. PUT no se usa salvo replace total justificado.
- **R3 — FE envía solo cambios**: payload diff entre `formValue` y entidad original.
- **R4 — Sin fallbacks que oculten errores**: prohibido `catchError(() => of([]))` en FE; prohibido try/catch con fallback al método legacy en BE durante migraciones. Usar feature flags explícitas si se necesita rollout gradual.
- **R5 — Validación BE con Bean Validation + groups**: `@NotNull(groups = OnCreate.class)` para distinguir reglas POST vs PATCH cuando comparten DTO.
- **R6 — DB stub-first**: funciones/SP nuevas arrancan en Phase 0 devolviendo mock (`RETURN '[]'::jsonb`); implementación real recién en Phase 1/2.

## Seguridad

- **Nunca** exponer secrets, API keys o credenciales en código
- **Nunca** logear datos sensibles (contraseñas, tokens, datos personales)
- **Siempre** parametrizar queries SQL (nunca concatenar strings)
- **BD vía MCP** — `<mcp-cert>` (pruebas) y `<mcp-prod>` (producción) son READONLY. Modificaciones a BD solo mediante scripts SQL versionados en `docs/scripts/` del workspace de la fuente; el usuario es quien aplica el script (no el AI), nunca ejecución directa via MCP, Bash, psql ni cualquier otro canal. Excepción única: el usuario explícitamente pide "ejecutalo vos contra cert" — aún así, confirmación por bloque y no asumir autorización ampliada

## Manejo de errores HTTP

- **Nunca silenciar errores HTTP con `catchError(() => of([]))` ni equivalentes.** Los errores del backend se propagan al usuario vía toast/mensaje; solo así detectamos regresiones durante guardado, sincronizaciones y creaciones. Si hace falta lógica de reintento, usar operadores RxJS explícitos (`retry`, `retryWhen`), no silenciar.

## Logging

- `ERROR` — Fallos que requieren atención inmediata
- `WARN` — Situaciones inesperadas pero manejadas
- `INFO` — Eventos de negocio relevantes (inicio/fin de procesos)
- `DEBUG` — Detalle técnico para diagnóstico

## Git y ramas

Política de commits: ver `agent-workflow:commits-policy` (canónico).

### Estrategia de ramas
- **`certificacion`** — Rama principal/producción. Base para crear feature branches.
- **`desarrollo`** — Rama QA. Solo para probar features desplegados. Se sincroniza desde `certificacion`. No se usa como base.
- **Feature branches** — Siempre desde `certificacion`, PR hacia `certificacion`.

### Prefijo opcional Conventional Commits

Si la sesión/equipo lo prefiere, se puede combinar con el formato canónico:

- `feat(session<NNN>):` nueva funcionalidad
- `fix(session<NNN>):` corrección de bug
- `docs(session<NNN>):` documentación
- `chore(session<NNN>):` mantenimiento, dependencias
- `refactor(session<NNN>):` reestructuración sin cambio funcional

Ramas: `feature/`, `fix/`, `hotfix/` + descripción-kebab-case.

## Sandbox read-only

Canon universal en `../session/references/sandbox-readonly-rules.md`. Esta skill es read-only por diseño — carga estándares de código por stack y reglas FE-BE, no edita ni ejecuta nada.

En plan mode: describir en el plan file qué reglas se aplicarían al edit/refactor propuesto (fail-fast, FE-BE R1-R6, MCP READONLY, SQL parametrizado) y listar los refs relevantes (Java/Spring, Angular/TypeScript, fe-be-integration). NO ejecuta `Write`, `Edit`, `MultiEdit`, `Bash` con efectos colaterales, ni queries MCP mutantes.

Compatible con plan mode sin restricciones adicionales.

## Recursos adicionales

### Archivos de referencia
- **`references/fe-be-integration.md`** — Reglas FE-BE (Sparse DTO unificado, PATCH, sin fallbacks ocultos, Bean Validation con groups, DB stub-first). Aplica a `## Type: feature|refactor`.
- **`references/java-spring.md`** — Convenciones Java/Spring Boot (inyección, records, transacciones, validación) + PATCH+Sparse DTO con records.
- **`references/angular-typescript.md`** — Convenciones Angular/TypeScript (constructor injection, NgModules, ApiService) + PATCH client + interfaces sparse.
- **`references/frontend-structure.md`** — Arquitectura `@data`/`@presentation`, ApiService, interfaces espejeo backend, environments, build
- **`references/database-conventions.md`** — Nomenclatura BD: esquemas `esq_`, tablas `tb_`, columnas, sequences, funciones `fn_`/`sp_`, patrón maestra-detalle, auditoría, estilo de scripts SQL (transacciones, CTE, comentarios, idempotencia)
- **`references/project-structure.md`** — Estructura de paquetes backend, capas Entity→Repository→Service→Controller, wrappers `ReqBase`/`RespBase`, convención DTOs `P`/`R`/`Req`
- **`../frontend-design/`** — Principios de diseño UX para formularios de mantenimiento (agnóstico a framework) + reutilización de componentes y framework-first CSS. Consultar en paralelo con `angular-typescript.md` cuando el trabajo es frontend de mantenimiento.

### Skills de base de datos
Cuando el stack involucra BD y se escriben scripts SQL:
- **`sql-script-organizer`** — Organiza scripts en 4 categorías, aplica estilo y genera bundle listo para producción
- **`sql-rollback-generator`** — Genera rollback acoplado por script y bundle global de reversión
