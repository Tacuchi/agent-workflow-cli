---
name: tools
description: >
  Capacidad de autoría de herramientas y utilidades que el plan crea: scripts, CLIs, helpers,
  configuraciones reutilizables. Produce el código de la herramienta y su documentación en
  docs/tools/. Compuesta por plan-exec-loop cuando una task crea una utilidad nueva (no un
  cambio de producto). No aplica a código de producto — solo a tooling auxiliar.
---

# tools — Tool authoring capability

## Role

`tools` — implementación built-in por defecto. Rebindeable a otra skill (de tercero o `off`) en `.workflow/skills.toml`.

## Purpose

Dar al `plan-exec-loop` la capacidad de crear herramientas y utilidades auxiliares con una estructura consistente: el código de la tool + su documentación en `docs/tools/`. Cubre scripts de automatización, CLIs auxiliares, helpers de CI/CD, configuraciones reutilizables, y cualquier artefacto de tooling que el plan genere como producto de una task.

**Distinciones clave:**

| Tipo | Rol | ¿Quién lo maneja? |
|---|---|---|
| Código de producto (services, controllers, components) | cambio en el repo fuente | `plan-exec-loop` (estilo: convenciones ambientes del host) |
| Tool / utilidad auxiliar creada por el plan | herramienta de soporte | esta skill (`tools`) |
| Script SQL de migración | dato persistente | `sql` + `export-scripts` |

## Composed by

| Loop | Cuándo la compone |
|---|---|
| `plan-exec-loop` | cuando una task del plan crea una herramienta nueva (helper, script CLI, configuración reutilizable) |

## Knowledge

### Tool vs. product code

Una **tool** es cualquier artefacto que el plan crea para soportar el trabajo, no para el usuario final del producto:

- Scripts de seed/fixtures para desarrollo local.
- CLIs auxiliares (`validate-schema.js`, `sync-env.sh`).
- Helpers de CI/CD (scripts de deploy, linters de configuración).
- Configuraciones reutilizables (templates de entorno, fixtures de test).
- Generadores o scaffolders para tareas repetitivas.

Si el artefacto es lógica de negocio del producto → no es una tool, es código de producto.

### Tool anatomy

Cada tool tiene dos partes:

1. **El código** — en el repo fuente apropiado (en su carpeta natural: `scripts/`, `tools/`, `bin/`, etc.).
2. **La doc** — en `docs/tools/NNN-<slug>.md` del workspace (invariant #2: PLAN escribe `docs/tools`).

### docs/tools/NNN-<slug>.md schema

```markdown
# <Nombre de la tool>

> **Tipo**: <script | cli | helper | config-template | generator>
> **Repo**: <alias de la fuente donde vive el código>
> **Path**: <path relativo al repo>
> **Creada en**: <sesion-slug>

## Purpose

[1-2 oraciones: qué hace y cuándo usarla.]

## Usage

```<lenguaje o bash>
<ejemplo de invocación>
```

## Parameters

| Param | Tipo | Requerido | Default | Descripcion |
|---|---|---|---|---|
| `--foo` | string | sí | — | ... |

## Output

[Qué produce: archivos, stdout, efectos secundarios.]

## Dependencies

- <prerequisito 1: binario, env var, servicio>
- <prerequisito 2>

## Examples

```bash
# Caso de uso principal
./scripts/validate-schema.sh --env staging

# Caso edge
./scripts/validate-schema.sh --env staging --dry-run
```

## Notes

[Advertencias, limitaciones, cuándo NO usar.]
```

### Numbering

`docs/tools/` usa numeración secuencial `NNN` (001, 002, ...). Consultar el número siguiente con el filesystem antes de escribir; no asumir el siguiente en base a lo que el loop ya sabe.

### Git-safe authoring (invariant #5)

- Verificar la rama esperada antes de escribir código.
- Proponer el commit; nunca hacer `push`/`--amend`/`--no-verify` autónomamente.
- Si la tool modifica scripts ya existentes: leer el archivo completo primero.

### DB scripts rule (invariant #4)

Si la tool genera o manipula SQL:
- Nunca generar DML/DDL que se ejecute inline — el SQL va a `SCRIPTS.sql` y se entrega vía `export-scripts`.
- Una tool puede generar un archivo `.sql`; no puede ejecutarlo contra la BD.

### Code quality baseline

Al autorar el código de la tool, seguir las convenciones de código **ambientes** del host (auto-descubiertas por su `description`; no es un rol del workflow ni se bindea). Si no hay una skill de estándares aplicable, usar los estándares del lenguaje detectado:
- **Shell**: shellcheck-compatible, variables entre comillas, `set -euo pipefail`.
- **Node/TS**: tipado explícito, sin `any` salvo justificación, error handling explícito.
- **Python**: type hints, docstring en funciones públicas, manejo de excepciones específico.
- **Java**: Javadoc mínimo en clases públicas, excepciones tipadas.

### Self-contained tools

Preferir tools que declaren explícitamente sus dependencias (en doc + en el propio script). Una tool que falla silenciosamente porque le falta un binario es peor que una que no existe.

```bash
# Pattern: check dependencies al inicio
command -v jq >/dev/null 2>&1 || { echo "jq requerido: brew install jq"; exit 1; }
```

## Output

Por cada tool creada:
- **Código**: en el repo fuente, en la carpeta que corresponda (`scripts/`, `tools/`, `bin/`).
- **Doc**: en `docs/tools/NNN-<slug>.md` del workspace.

Writes `docs/tools/` (invariant #2: PLAN es el dueño de esta carpeta). No gradua a ninguna otra carpeta de `docs/`.

## Source

Autoria original (no hay skill equivalente en el bundle viejo). Basado en la descripción del rol en `workflow-roles/README.md` y en el invariant #2 del diseño (`docs/tools/` es del flujo PLAN). Las convenciones de estructura de doc (`## Purpose`, `## Usage`, `## Parameters`, `## Output`, `## Examples`) siguen el patrón de calidad del bundle.
