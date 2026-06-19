---
name: coding-standards
description: >-
  Coding standards capability — built-in default for the `coding-standards` role.
  Stack-agnostic principles (SOLID, fail-fast, descriptive names, small methods,
  reuse over duplication) plus per-stack conventions (Java/Spring, Angular/TypeScript,
  Node), security (no secrets in code or logs, parametrized SQL, DB read-only via MCP),
  HTTP error handling (never silence errors), logging levels, and FE-BE integration
  rules (unified sparse DTO, PATCH for edit, no hidden fallbacks). Use when a loop
  implements, reviews or refactors code.
---

# coding-standards — Coding standards capability

## Role

`coding-standards` — built-in default. Rebindable in `.workflow/skills.toml` (third-party skill or `off`).

## Purpose

Aportar los estándares de código que la IA aplica al **implementar, revisar o refactorizar**. Read-only por diseño: carga reglas, no edita ni ejecuta nada por sí misma — el loop consumidor materializa el código.

## Composed by

- **`plan-exec-loop`** — al implementar/refactorizar las tasks del plan.
- **`quick-loop`** — al implementar el atajo liviano.

## Knowledge

### Principios generales

- **SOLID** — Single Responsibility, Open/Closed, Liskov, Interface Segregation, Dependency Inversion.
- **Fail fast** — validar y retornar al inicio del método (early returns, evitar nesting).
- **Nombres descriptivos** — el código habla por sí mismo; comentarios solo para el "por qué".
- **Métodos pequeños** — una sola responsabilidad por función.
- **Composición sobre herencia**.
- **Reutilización antes que duplicación (DRY)** — antes de crear componente/función/clase, revisar si ya existe en `shared/` (frontend) o `common/`/`util/` (backend). Si un patrón aparece 2-3 veces, proponer extracción.

### Estándares por stack

- **Java / Spring Boot**: Constructor Injection (sin Field Injection), `@Transactional(readOnly=true)` para lecturas, Java records para DTOs Request/Response, Jakarta Validation para inputs.
- **Angular / TypeScript**: constructor injection, `async` pipe en templates, evitar `any`, FormBuilder reactivo sobre `ngModel` directo, arquitectura `@data`/`@presentation`, normalización de tipos.
- **Node / otros**: mismos principios generales; aplicar las convenciones idiomáticas del proyecto detectado.

### Integración FE-BE (cuando el cambio cruza frontend y backend)

- **R1 — Sparse DTO unificado**: mismo DTO `<Feature>SaveRequest` para create + edit, todos los campos nullable. `null` = "no tocar".
- **R2 — PATCH para edit**: `@PatchMapping` en BE, `http.patch()` en FE. POST solo para create. PUT solo si replace total justificado.
- **R3 — FE envía solo cambios**: payload diff entre `formValue` y entidad original.
- **R4 — Sin fallbacks que oculten errores**: prohibido `catchError(() => of([]))` en FE; prohibido try/catch con fallback al método legacy en BE durante migraciones. Usar feature flags explícitas para rollout gradual.
- **R5 — Validación BE con Bean Validation + groups**: `@NotNull(groups = OnCreate.class)` para distinguir reglas POST vs PATCH cuando comparten DTO.
- **R6 — DB stub-first**: funciones/SP nuevas arrancan devolviendo mock (`RETURN '[]'::jsonb`); implementación real en una fase posterior.

### Seguridad

- **Nunca** exponer secrets, API keys ni credenciales en código.
- **Nunca** logear datos sensibles (contraseñas, tokens, datos personales).
- **Siempre** parametrizar queries SQL (nunca concatenar strings).
- **BD vía MCP es READONLY**. Modificaciones a BD solo como scripts SQL versionados (ver rol `sql`); las aplica el **usuario**, nunca la IA — ni por MCP, ni `Bash`, ni `psql`, ni driver. (Invariante 4.)

### Manejo de errores HTTP

- **Nunca** silenciar errores HTTP con `catchError(() => of([]))` ni equivalentes. Los errores del backend se propagan al usuario (toast/mensaje) para detectar regresiones en guardado/sincronización/creación. Para reintentos usar operadores explícitos (`retry`, `retryWhen`), no silenciar.

### Logging

- `ERROR` — fallos que requieren atención inmediata.
- `WARN` — situaciones inesperadas pero manejadas.
- `INFO` — eventos de negocio relevantes (inicio/fin de procesos).
- `DEBUG` — detalle técnico para diagnóstico.

### Convenciones de BD (nomenclatura)

Esquemas `esq_`, tablas `tb_`, sequences `seq_`, funciones `fn_`/procedimientos `sp_`, patrón maestra-detalle, auditoría en `esq_audit`. Para autoría de scripts SQL (estilo, header, categorías, rollback) usar el rol **`sql`**.

## Output

Ninguno propio. La skill aporta reglas; el código lo escribe el loop. Cuando el cambio toca BD, delega la autoría de scripts al rol `sql`. Nunca exporta a `docs/` (invariante 1).

## Source

Reciclada de `standards/coding-standards/` (SKILL.md + references Java/Spring, Angular/TypeScript, fe-be-integration, database-conventions, frontend-structure, project-structure). Los principios UX de mantenimientos CRUD (formularios, listados, modales) viven en el rol `ui-spec`/`ui-design`; la autoría de scripts SQL en el rol `sql`. Se descarta la dependencia de `profile.json` y de comandos CLI de la doctrina vieja.
