---
name: ui-spec
description: >-
  UI spec authoring — built-in default for the `ui-design` capability. Given a UI
  requirement, author a structured, framework-agnostic screen specification (the
  universal `Screen` model in JSON) plus its readable Markdown render. Knows the
  `Screen` schema, the kind/region vocabulary, the authoring rules, design-system /
  theme / variant handling, and the exact Markdown render format. Use when a loop is
  refining a spec that involves screens, forms, dashboards, modals or any UI surface
  — primarily `spec-refine-loop`. Recycled from the `ui-spec-generator` service.
---

# ui-spec — UI spec authoring

## Role

`ui-design` — this is its **built-in default implementation**. Rebindable in `.workflow/skills.toml` to a third-party skill (installed via skills.sh) or `off`. Resolution: built-in default → `~/.workflow/skills.toml` (global) → `.workflow/skills.toml` (workspace).

## Purpose

Dado un requerimiento de UI, autorar una **especificación de pantalla estructurada** — un modelo universal, agnóstico de framework — más su render Markdown legible. **Reemplaza** al servicio single-shot `ui-spec-generator`: ahora la IA la autora **nativamente**, guiada por esta skill. No hay endpoint que llamar; el saber del servicio vive aquí.

## Composed by

La carga el **`spec-refine-loop`** (ver `../../loops/spec-refine-loop.md`) cuando el requerimiento involucra UI. El loop aporta lo que el servicio viejo no tenía:

- **Pregunta al humano** (design-system, tema, ambigüedades de pantalla) vía `AskUserQuestion`.
- **Itera** gap-driven hasta converger.
- Ofrece **variantes** y **cura** el resultado.

Cualquier loop podría componerla; el caso primario es SPEC. El `Screen` y su Markdown aterrizan como una sección dentro del documento spec (`docs/specs/NNN-spec.md`) — nunca como artefacto suelto (invariante 3: el spec es un documento).

## Knowledge

### Schema (modelo `Screen` — universal, recursivo)

```
Screen {
  name: string             # nombre de la pantalla
  purpose: string          # "tipo" semántico: auth, dashboard, form, list, detail, error, ...
  platform: string         # web (default), mobile, ...
  description?: string
  regions?:   Region[]     # pantallas complejas
  components?: Component[]  # pantallas simples
}                          # usar regions O components, no ambos
Region    { type: string, components: Component[] }
Component { kind: string, role?: string, label?: string, children?: Component[] }  # recursive
```

- `type` (region) ∈ `header · main · footer · sidebar · filters · summary`
- `kind` (component) por categoría:
  - **Contenedores**: `card · panel · modal`
  - **Datos**: `table · list · grid`
  - **Visualización**: `chart · metric · badge · image`
  - **Entrada**: `textInput · select · checkbox · datePicker · toggle`
  - **Acciones**: `button · link · actionGroup`
  - **Navegación**: `navBar · tabs · breadcrumb`
  - **Feedback**: `alert · progress`

JSON serializado en **camelCase**, **claves null omitidas** (no emitir `"description": null`).

### Rules

1. **Conciso** — solo lo esencial. Nada de relleno ni componentes especulativos.
2. Pantalla simple (login, recuperar contraseña, error) → `components` directo, **sin** `regions`.
3. Pantalla compleja (dashboard, mantenimiento CRUD) → `regions` para organizar.
4. `role` es **opcional** — solo si aporta claridad (`role:"logo"`, `role:"primary"`).
5. Límites: **≤100 componentes**, **≤5 niveles** de anidación.
6. Un solo `Screen` por sección; si el requerimiento son varias pantallas, una sección por pantalla.

### Design options (las pregunta el loop al humano)

Estas opciones **guían contenido/labels**; el modelo `Screen` es **agnóstico** de design-system y NO las lleva como campos. Se **anotan en el spec** (encabezado de la sección), no en el JSON:

- **Design system**: `material3 · bootstrap5 · tailwind3 · antDesign · chakraUI · custom`.
- **Tema**: `light · dark · auto`.
- **Idioma**: `es · en · …` (afecta los `label`).
- **Densidad** (opcional): `compact · comfortable · spacious`.
- **maxWidth** (opcional): pixeles, 320–3840 (anotación de layout).

### Variants

Cuando el requerimiento admite más de un layout razonable (ej. tabla vs. grid de cards; tabs vs. acordeón), ofrecer **2-3 variantes** como `Screen` alternativos y pedir al humano que elija. Una sola variante se cura y queda; las descartadas no se persisten.

### Disambiguation

Antes de autorar, resolver ambigüedades con `AskUserQuestion` (lo dispara el loop):

- Pantalla simple o compleja (¿necesita `regions`?).
- Qué acciones primarias/secundarias existen.
- Qué datos muestra (tabla, métricas, ambos).
- Si hay estados (loading, empty, error) que el spec deba enumerar.

Si el humano no responde, asumir el caso más simple coherente con la descripción y anotar el supuesto.

### Examples (few-shot)

```json
// Simple (sin regions)
{"name":"Recuperar Contraseña","purpose":"auth","platform":"web","components":[{"kind":"image","role":"logo"},{"kind":"textInput","label":"Correo electrónico"},{"kind":"button","label":"Enviar enlace"},{"kind":"link","label":"Volver al login"}]}

// Complejo (con regions)
{"name":"Dashboard","purpose":"dashboard","platform":"web","regions":[{"type":"summary","components":[{"kind":"metric","label":"Total"},{"kind":"metric","label":"Pendientes"}]},{"type":"main","components":[{"kind":"table","label":"Registros"}]}]}
```

## Output — sección `## UI spec` dentro del spec (`docs/specs/NNN-spec.md`)

La escribe el loop (no esta skill por sí sola). Encabezar la sección con las opciones de diseño elegidas (design system, tema, idioma) en una línea. Luego dos representaciones:

1. **`Screen` (JSON)** — camelCase, claves null omitidas, en bloque ```json.
2. **Markdown** — render legible (reglas exactas, recicladas del `MarkdownFormatter`):
   - `# {name}`
   - `**Tipo**: {purpose} | **Plataforma**: {platform}`
   - `description` como párrafo aparte (solo si existe).
   - Con `regions`: un `## {Type capitalizado}` por región (capitalizar la primera letra del `type`).
   - Sin `regions`: un `## Componentes`.
   - Cada componente: `- **{label || role || kind}**`, seguido de ` ({kind})` **solo si** había `label` o `role`.
   - `children` indentados **2 espacios por nivel**.

Ejemplo de render para el dashboard de arriba:

```markdown
# Dashboard
**Tipo**: dashboard | **Plataforma**: web

## Summary
- **Total** (metric)
- **Pendientes** (metric)

## Main
- **Registros** (table)
```

## Source

Reciclada de `ui-spec-generator` (Spring Boot/Kotlin). Se **conservan**: el prompt de sistema (vocabulario, kinds, reglas), el esquema `Screen`/`Region`/`Component`, los pocos-shot, el enum de design systems, los constraints (theme/density/maxWidth) y las reglas exactas del `MarkdownFormatter`. Se **descarta**: el transporte HTTP, OpenRouter/Gemini y el modo single-shot — los reemplaza la iteración del `spec-refine-loop`. El endpoint del servicio deja de usarse. También absorbe los principios UX de la vieja skill `standards/frontend-design/` cuando el spec describe mantenimientos CRUD (formularios, listados, modales, navegación, feedback).
