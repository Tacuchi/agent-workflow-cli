---
name: frontend-design
description: "Principios de diseño UX para interfaces CRUD agnósticos al framework (HTML/CSS/UX, sin código Angular/React/Vue). Cubre formularios, listados, modales, navegación y feedback. Reglas de reutilización shared/ y framework-first CSS. Activar al diseñar o implementar mantenimientos CRUD. Para código del stack consultar coding-standards. Referencia transversal sin dependencia de sesiones."
version: 0.2.0
---

# Frontend Design

Principios de diseño UX para interfaces CRUD de mantenimiento: formularios, listados, modales, navegación y feedback. Contenido **agnóstico a framework** — sólo principios HTML/CSS/UX, sin código Angular/React/Vue. Para el código específico del stack, ver `coding-standards/references/<stack>.md`.

## Qué cubre

Cinco `references/*.md`, cada uno prescriptivo (qué sí hacer) con un checklist de replicación al final:

- **`references/form-patterns.md`** — formularios editar/nuevo. Modelo mental single-slot, layout de 4 cards por dominio, readonly con candado, combos dependientes con hints, switch vs checkbox, campo opcional con switch que colapsa, estado vs bloqueado, placeholders con formato. Incluye los dos principios transversales de reutilización (`shared/`) y framework-first CSS (~90/10).

- **`references/list-patterns.md`** — vistas de listado. Estructura header + filter card + data-table + pagination, acciones por fila (iconos + tooltips), empty states, loading global, badges de estado. FormBuilder reactivo preferido sobre `ngModel` directo.

- **`references/modal-patterns.md`** — diálogos. Cuándo modal vs vista dedicada, layout (header/body/footer), tamaños categóricos (sm/md/lg), formularios dentro del modal, footer con cancelar + primario + loading state, convención de payload `{ saved: true, data }`, confirmación destructiva. NgbModal recomendado; MatDialog es legado.

- **`references/navigation-patterns.md`** — layout de app admin. Sidebar colapsable desde catálogo dinámico, toolbar con contexto (sucursal/usuario/logout), page header con título + descripción + acción primaria, tabs con routing, breadcrumbs, back navigation, lazy loading por módulo.

- **`references/feedback-toasts-patterns.md`** — toasts (4 tipos: success/info/warning/danger), loading global vs inline, validación inline de formularios, empty states, errores HTTP (regla: nunca silenciar con `catchError → []`), confirmación destructiva, skeletons.

## Qué NO cubre

Código de framework específico. Para:

- **Angular/TypeScript** (`valueChanges`, `patchValue({emitEvent:false})`, async pipe, normalización de tipos, `concat` vs paralelo, FormBuilder): `coding-standards/references/angular-typescript.md`.
- **Java/Spring** (sincronización single-slot preservando fila coincidente, fallback cross-tabla, filtros `estado=1` en query): `coding-standards/references/java-spring.md`.
- **Estructura de proyecto frontend** (`@data`/`@presentation`, `shared/`, `ApiService`): `coding-standards/references/frontend-structure.md`.
- **Seguridad, logging, git, errores HTTP**: `coding-standards/SKILL.md`.

## Cuándo se activa

Auto-trigger por contexto, como `coding-standards`. Señales típicas:

- El usuario menciona mantenimientos, editar/nuevo, cards, layout, combo dependiente, switch, readonly, listado, filtros, paginación, tabla, modal, confirmación, sidebar, toolbar, breadcrumbs, toast, loading, empty state, validación.
- El trabajo consiste en diseñar o implementar una vista CRUD nueva (lista, form, modal, navegación) o replicar el patrón a otra entidad.
- El usuario pregunta por el patrón de un elemento visual ("¿cómo alineo el switch?", "¿uso checkbox o switch aquí?", "¿hay componente reutilizable?").
- El usuario discute reutilización o framework-first CSS ("¿hay componente en shared?", "prefiero utilities Bootstrap").

No depende de sesiones activas.

## Convenciones comunes a los refs

- **Principios prescriptivos** (lo que sí hacer). Alternativas legadas se mencionan en 1 línea como "no replicar" sin secciones dedicadas.
- **`[shared-candidato]`** marca componentes compartidos pendientes de extracción — listado consolidado en `references/form-patterns.md` §10 y distribuido donde aparece cada candidato.
- **Checklist de replicación** al final de cada ref, enumerando los pasos para aplicar los patrones a una vista nueva.
- **Notas de stack** ("En el proyecto usa X; Y es legado, no replicar") donde las inconsistencias del codebase requieren postura.

## Sandbox read-only

Canon universal en `../session/references/sandbox-readonly-rules.md`. Esta skill es read-only por diseño — carga principios de UX/UI para mantenimientos CRUD (form patterns, listings, modales, navegación, feedback), no edita ni genera código.

En plan mode: describir en el plan file qué refs aplicarían al contexto (form-patterns, list-patterns, modal-patterns, etc.) y los componentes `[shared-candidato]` que el caso justificaría extraer. NO ejecuta `Write`, `Edit`, `MultiEdit`, ni `Bash` con efectos colaterales.

Compatible con plan mode sin restricciones adicionales.

## Roadmap

Los 5 refs cubren el alcance actual tras análisis dirigido del frontend `core-frontend-miscuotas/admin`. Si aparecen dominios nuevos (p. ej. wizards multi-step activos, upload flows complejos, dashboards) con suficiente repetición en el codebase, se añaden como refs adicionales siguiendo el mismo proceso: analizar → generalizar → documentar.
