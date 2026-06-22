---
name: ui-spec
description: >-
  UI spec authoring — built-in default for the `ui-design` capability. Given a UI
  requirement, author a structured, framework-agnostic screen specification as
  **Markdown** (single output format). Knows the conceptual screen structure, the
  kind/region vocabulary, the authoring rules, design-system / theme / variant
  handling, and the exact Markdown render format. Use when a loop is refining a spec
  that involves screens, forms, dashboards, modals or any UI surface — primarily
  `spec-refine-loop`. Recycled from the `ui-spec-generator` service.
---

# ui-spec — UI spec authoring

## Role

`ui-design` — this is its **built-in default implementation**. Rebindable in `.workflow/skills.toml` to a third-party skill (installed via skills.sh) or `off`. Resolution: built-in default → `~/.workflow/skills.toml` (global) → `.workflow/skills.toml` (workspace).

## Purpose

Dado un requerimiento de UI, autorar una **descripción estructurada en Markdown** de las pantallas y sus componentes — descriptiva (qué hay y para qué) y estructurada (regiones → componentes, con vocabulario consistente), agnóstica de framework. **Reemplaza** al servicio single-shot `ui-spec-generator`: ahora la IA la autora **nativamente**, guiada por esta skill. No hay endpoint que llamar; el saber del servicio vive aquí. **Salida en un solo formato: Markdown** (sin representación JSON paralela).

## Composed by

La carga el **`spec-refine-loop`** (ver `../../loops/spec-refine-loop/SKILL.md`) al resolver el gap **UI sin especificar** (cuando el requerimiento involucra UI). El loop aporta lo que el servicio viejo no tenía:

- **Pregunta al humano** (design-system, tema, ambigüedades de pantalla) vía *structured-choice* (capacidad del arnés — ver `../../harness/SKILL.md`). En **Claude Code** es `AskUserQuestion` (máx 4 preguntas/llamada → **≤3 preguntas de contenido + 1 control `flow`**); en un arnés sin elección estructurada, degrada a **markdown numerado**.
- **Itera** gap-driven hasta converger.
- Ofrece **variantes** y **cura** el resultado.

Cualquier loop podría componerla; el caso primario es SPEC. La descripción Markdown aterriza como una sección dentro del documento spec (`docs/specs/NNN-spec-<slug>.md`) — nunca como artefacto suelto (invariante 3: el spec es un documento).

## Knowledge

### Estructura conceptual (universal, recursiva)

Una **pantalla** tiene: `nombre`, `tipo` (propósito semántico: auth, dashboard, form, list, detail, error, …), `plataforma` (web por default, mobile, …), `descripción` opcional, y **o bien regiones** (pantalla compleja) **o bien componentes** directos (pantalla simple) — **no ambos**.

- Una **región** agrupa componentes y tiene un `type`.
- Un **componente** tiene un `kind`, y opcionalmente `role`, `label` y `children` (anidables, recursivos).

Es un modelo conceptual para guiar la autoría; **no se serializa a JSON** — la única salida es el render Markdown (ver Output).

- `type` (región) ∈ `header · main · footer · sidebar · filters · summary`
- `kind` (componente) por categoría:
  - **Contenedores**: `card · panel · modal`
  - **Datos**: `table · list · grid`
  - **Visualización**: `chart · metric · badge · image`
  - **Entrada**: `textInput · select · checkbox · datePicker · toggle`
  - **Acciones**: `button · link · actionGroup`
  - **Navegación**: `navBar · tabs · breadcrumb`
  - **Feedback**: `alert · progress`

### Rules

1. **Conciso** — solo lo esencial. Nada de relleno ni componentes especulativos.
2. Pantalla simple (login, recuperar contraseña, error) → `components` directo, **sin** `regions`.
3. Pantalla compleja (dashboard, mantenimiento CRUD) → `regions` para organizar.
4. `role` es **opcional** — solo si aporta claridad (`role:"logo"`, `role:"primary"`).
5. Límites: **≤100 componentes**, **≤5 niveles** de anidación.
6. Una sola pantalla por bloque `#`; si el requerimiento son varias pantallas, se listan una tras otra (cada una con su `#`).

### Design options (las pregunta el loop al humano)

Estas opciones **guían contenido/labels**; la estructura de la pantalla es **agnóstica** de design-system y NO las lleva como parte del modelo. Se **anotan en el spec** (encabezado de la sección):

- **Design system**: `material3 · bootstrap5 · tailwind3 · antDesign · chakraUI · custom`.
- **Tema**: `light · dark · auto`.
- **Idioma**: `es · en · …` (afecta los `label`).
- **Densidad** (opcional): `compact · comfortable · spacious`.
- **maxWidth** (opcional): pixeles, 320–3840 (anotación de layout).

### Variants

Cuando el requerimiento admite más de un layout razonable (ej. tabla vs. grid de cards; tabs vs. acordeón), ofrecer **2-3 variantes** como pantallas Markdown alternativas y pedir al humano que elija. Una sola variante se cura y queda; las descartadas no se persisten.

### Disambiguation

Antes de autorar, resolver ambigüedades con *structured-choice* (lo dispara el loop; ver `../../harness/SKILL.md`):

- Pantalla simple o compleja (¿necesita `regions`?).
- Qué acciones primarias/secundarias existen.
- Qué datos muestra (tabla, métricas, ambos).
- Si hay estados (loading, empty, error) que el spec deba enumerar.

Si el humano no responde, asumir el caso más simple coherente con la descripción y anotar el supuesto.

### Examples (few-shot)

**Simple (sin regiones)** — "Recuperar Contraseña" (auth, web):

```markdown
# Recuperar Contraseña
**Tipo**: auth | **Plataforma**: web

## Componentes
- **logo** (image)
- **Correo electrónico** (textInput)
- **Enviar enlace** (button)
- **Volver al login** (link)
```

**Complejo (con regiones)** — "Dashboard" (web):

```markdown
# Dashboard
**Tipo**: dashboard | **Plataforma**: web

## Summary
- **Total** (metric)
- **Pendientes** (metric)

## Main
- **Registros** (table)
```

## Output — sección `## UI spec` dentro del spec (`docs/specs/NNN-spec-<slug>.md`)

**Salida en un solo formato: Markdown.** La escribe el loop (no esta skill por sí sola). Encabezar la sección con las opciones de diseño elegidas (design system, tema, idioma) en una línea. Luego el render Markdown, con estas reglas exactas (recicladas del `MarkdownFormatter`):

- `# {nombre}`
- `**Tipo**: {tipo} | **Plataforma**: {plataforma}`
- `descripción` como párrafo aparte (solo si existe).
- Con regiones: un `## {Type capitalizado}` por región (capitalizar la primera letra del `type`).
- Sin regiones: un único `## Componentes`.
- Cada componente: `- **{label || role || kind}**`, seguido de ` ({kind})` **solo si** había `label` o `role`.
- `children` indentados **2 espacios por nivel**.
- Si hay varias pantallas, se listan una tras otra (cada una con su `#`).

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

Reciclada de `ui-spec-generator` (Spring Boot/Kotlin). Se **conservan**: el prompt de sistema (vocabulario, kinds, reglas), la estructura conceptual pantalla/región/componente, los pocos-shot (ahora en Markdown), el enum de design systems, los constraints (theme/density/maxWidth) y las reglas exactas del `MarkdownFormatter` (su render era exactamente este). Se **descarta**: la **serialización JSON `Screen`** (segunda representación, ahora innecesaria), el transporte HTTP, OpenRouter/Gemini y el modo single-shot — los reemplaza la iteración del `spec-refine-loop`. El endpoint del servicio deja de usarse. También absorbe los principios UX de la vieja skill `standards/frontend-design/` cuando el spec describe mantenimientos CRUD (formularios, listados, modales, navegación, feedback).
