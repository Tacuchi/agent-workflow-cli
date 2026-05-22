# Patrones de listado CRUD

Principios de diseño para vistas de listado de mantenimiento (tabla/grid con filtros, paginación y acciones por fila). Agnóstico a framework; los ejemplos usan utilities Bootstrap.

Para el código de stack (data-table, pagination, stores con signals), ver `coding-standards/references/<stack>.md`.

---

## 1. Estructura de la vista

La vista de listado se compone de 4 bloques verticales:

```
┌──────────────────────────────────────────────────────────┐
│  Título + descripción                [+ Nuevo]           │  ← header
├──────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────┐  │
│  │ Filtros (texto / select / multi-select / fechas)   │  │  ← filter card
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────┐  │
│  │  Tabla con columnas + acciones por fila            │  │  ← data-table
│  │  Paginación integrada                              │  │     (+ pagination)
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

Orden vertical fijo: **header → filtros → tabla + paginación**. No intercalar.

---

## 2. Header con título, descripción y acción primaria

```html
<div class="mb-4">
  <div class="d-flex justify-content-between align-items-center flex-wrap gap-3">
    <div>
      <h2 class="fw-bold mb-1">Usuarios</h2>
      <p class="text-muted mb-0">Administra los usuarios del sistema.</p>
    </div>
    <button class="btn btn-primary">
      <i class="fa fa-plus me-1"></i> Nuevo usuario
    </button>
  </div>
</div>
```

**Reglas:**

- `h2 fw-bold` para el título, `p text-muted` para la descripción (una línea).
- Acción primaria top-right con `btn btn-primary` + icono `fa fa-plus` + label "Nuevo <entidad>" / "Crear <entidad>".
- `flex-wrap gap-3` — en mobile el botón cae debajo del título sin solaparse.
- Label de acción: singular de la entidad, capitalizado ("Nuevo usuario", "Crear sucursal", "Nueva campaña").

**[shared-candidato] `page-header`** — se repite en 6+ vistas; amerita extracción con slots `[title]`, `[subtitle]`, `[action]`.

---

## 3. Filter card

```html
<div class="card mb-4">
  <div class="card-body">
    <form class="row g-3 align-items-end">
      <div class="col-12 col-md-4">
        <label class="form-label">Nombre</label>
        <input type="text" class="form-control" placeholder="Buscar por nombre...">
      </div>
      <div class="col-12 col-md-4">
        <label class="form-label">Estado</label>
        <select class="form-select">...</select>
      </div>
      <div class="col-12 col-md-4">
        <button class="btn btn-primary w-100"><i class="fa fa-search me-1"></i>Buscar</button>
      </div>
    </form>
  </div>
</div>
```

**Reglas:**

- Contenedor: `card mb-4` → `card-body` → `form.row g-3 align-items-end`.
- Cada filtro en `col-12 col-md-X` (X = 3, 4, 6 según densidad). Label obligatorio (`form-label`).
- `align-items-end` alinea verticalmente inputs y botón al baseline del último elemento.
- **Submit automático preferido**: disparar búsqueda al cambiar valor del filtro (debounce 250-400ms en texto libre). Botón "Buscar" explícito sólo si el filtro es costoso (multi-select grande, rango de fechas amplio).
- **No colapsar en mobile** — los filtros quedan apilados `col-12` en pantallas pequeñas. Un acordeón/drawer se justifica sólo si hay >6 filtros.

**Patrones a evitar:**

- `ngModel` directo acoplado a propiedades del componente en vez de un FormGroup reactivo (dificulta reset y observación). El camino recomendado del stack vive en `coding-standards/references/angular-typescript.md`.

**[shared-candidato] `filter-panel`** — wrapper con `card + card-body + row g-3 align-items-end` y content projection para cada filtro.

---

## 4. Tabla con columnas dinámicas

Usar el componente shared `data-table` (existe en `@presentation/shared/components/data-table/`) en lugar de `<table>` HTML directo.

**Contrato del componente:**

- `[data]` — array del store/signal con los items.
- `[columns]` — array `TableColumn[]` con `{ key, header, template? }`.
- `[pageSize]`, `[pageSizeOptions]`, `[pageIndex]`, `[totalItems]`.
- `[emptyMessage]` — texto cuando no hay resultados.
- `(pageChange)` — emite cambio de página/size.

Las **columnas se definen en código** (no inline en HTML), con templates referenciados por `ViewChild` para acciones y badges:

```html
<app-data-table
  [data]="store.items()"
  [columns]="columns"
  [pageSize]="pageSize"
  [pageIndex]="pageIndex"
  [totalItems]="store.total()"
  emptyMessage="No se encontraron resultados"
  (pageChange)="onPageChange($event)">
</app-data-table>
```

**Tabla interna:** `table table-striped table-hover` (defaults del data-table). Header con `font-weight: 600`. Alineaciones con utilities (`text-start`, `text-center`, `text-end`).

**Patrones a evitar:**

- Paginación manual con `slice()` sobre un array en memoria en el componente (observado en el módulo de campañas). El camino correcto es paginación server-side vía `data-table` + `pagination` y un store que llama al endpoint.

---

## 5. Acciones por fila

Columna final con `key: 'acciones'` (o `'options'`), header vacío o "Acciones", ancho mínimo. Dentro del template:

```html
<div class="d-flex gap-1">
  <button class="btn btn-sm btn-light text-primary" ngbTooltip="Editar">
    <i class="fa fa-pen"></i>
  </button>
  <button class="btn btn-sm btn-light text-primary" ngbTooltip="Duplicar">
    <i class="fa fa-copy"></i>
  </button>
  <button class="btn btn-sm btn-light text-danger" ngbTooltip="Eliminar">
    <i class="fa fa-trash"></i>
  </button>
</div>
```

**Reglas:**

- Íconos sin texto (compact). Tooltip en cada botón (`ngbTooltip`, `matTooltip` o equivalente).
- `btn btn-sm btn-light` + color del texto según severidad (`text-primary` neutro, `text-danger` destructivo, `text-warning` cuidado).
- `d-flex gap-1` — separación mínima entre íconos.
- Máximo 3-4 acciones por fila. Si hay más, colapsar en menú kebab.
- Operación destructiva → **confirmación** (ver `feedback-toasts-patterns.md` §7).
- Si la fila es clickeable (abre detalle), usar `$event.stopPropagation()` en cada botón de acción para que no se dispare la navegación al click del botón.

---

## 6. Paginación

Usar el componente shared `pagination` dentro del `data-table` (o como hermano si la tabla es custom).

**Reglas:**

- Tamaños de página estándar: `[10, 25, 50, 100]` para listados grandes; `[5, 10, 20]` para listados pequeños/poco densos.
- Mostrar "X - Y de Z items" cerca del selector de tamaño.
- Botones first/last cuando `totalItems > pageSize * 5` (evita click repetido).
- **URL sincronizada:** opcional. Si se activa, guardar `page`, `pageSize` y filtros clave en query params para que recargar la página mantenga el estado. Si no, estado en el store local.

---

## 7. Empty states

Cuando `data.length === 0`, la tabla muestra una fila única con `colspan` de todas las columnas y el texto de `emptyMessage`:

```html
<tr>
  <td [attr.colspan]="columns.length" class="text-center text-muted py-4">
    {{ emptyMessage }}
  </td>
</tr>
```

**Reglas:**

- Texto alineado al centro, `text-muted`, padding vertical generoso (`py-4`).
- Mensaje específico ("No se encontraron usuarios con esos filtros") > genérico ("Sin datos").
- Si la lista es vacía **porque nunca se cargó** (antes de aplicar filtros), considerar un empty state más rico con icono + botón "Crear el primero".

**[shared-candidato] `empty-state`** — componente reutilizable con `[icon]`, `[message]`, `[actionLabel]`, `[actionClick]`. Observado duplicado en 5+ vistas con clases custom divergentes (`.empty-state`, `.empty-permissions`, `.empty-transfer`, `.empty-roles`) — unificar.

---

## 8. Loading

**Page-level loading** (recomendado para navegación y carga inicial):

- Overlay global manejado por un servicio centralizado que se muestra con `show()` y oculta con `hide()`.
- Regla de pareo: cada `show()` debe tener un `hide()` correspondiente, tanto en éxito como en error.

**Inline loading** (opcional, para refresh interno de la tabla sin bloquear el resto de la UI):

- Spinner pequeño en el botón "Buscar" mientras el filtro vuela.
- `disabled` en los controles durante la carga.

**Regla:** no mezclar overlay global + spinner inline en la misma acción. Elegir uno según el contexto (carga inicial vs refresh de resultados).

---

## 9. Badges de estado

Para columnas tipo "Estado" con valor categórico (Activo/Inactivo, pendiente/aprobado):

```html
<span class="status-badge" [class.status-active]="activo" [class.status-inactive]="!activo">
  {{ activo ? 'Activo' : 'Inactivo' }}
</span>
```

**Reglas:**

- Pill (`border-radius` redondeado), tipografía `font-size: 0.75rem`, padding `0.25rem 0.5rem`.
- Colores semánticos: verde (activo/aprobado), rojo (inactivo/rechazado), gris (neutro), amarillo (pendiente).
- **Colores unificados en todo el proyecto** (evitar `#365314` aquí y `#2e7d32` allá). Definir una vez, reutilizar.

**[shared-candidato] `status-badge`** — componente con `[status]: 'active'|'inactive'|'pending'|'neutral'` y `[label]`. Observado duplicado en 4+ vistas con colores levemente divergentes — unificar.

---

## 10. Decisiones implícitas en el codebase

Estas decisiones son las **recomendadas hacia adelante** (observadas en la mayoría del módulo admin):

- **FormGroup reactivo** para filtros (permite `valueChanges` + `reset()`, no ad-hoc sobre propiedades). Detalles técnicos: `coding-standards/references/angular-typescript.md`.
- **Store con signals** para estado del listado (items, total, pageIndex, filtros). Alternativas ad-hoc con propiedades en el componente son legado.
- **`data-table` + `pagination` shared** son la única forma de tabla paginada soportada. Paginación manual con `slice` es legado.
- **`NgbModal`** para cualquier diálogo de edición rápida (ver `modal-patterns.md`). `MatDialog` es legado.

---

## 11. Checklist de replicación

Al crear un listado nuevo (p. ej. `admin/nueva-entidad/lista`):

- [ ] Header: `h2 fw-bold` + `text-muted` descripción + botón "Nuevo <entidad>" top-right.
- [ ] Filter card con `card mb-4` + `row g-3 align-items-end`, 1 filtro por `col-12 col-md-X`.
- [ ] FormGroup reactivo para los filtros; submit automático con debounce en texto libre.
- [ ] `data-table` con `TableColumn[]` definido en código + `ViewChild` para templates de acciones.
- [ ] `pagination` integrada con tamaños `[10, 25, 50, 100]`.
- [ ] Columna de acciones: íconos con tooltip, `d-flex gap-1`, 3-4 máximo.
- [ ] `emptyMessage` específico; considerar `empty-state` rico si el listado nace vacío.
- [ ] Loading global paired `show()`/`hide()`.
- [ ] Badges de estado con el `status-badge` (o su equivalente inline, colores unificados).
- [ ] Revisar `shared/` antes de crear cualquier subcomponente nuevo (sección 10 de `form-patterns.md`).
- [ ] Estilo con utilities del framework; custom sólo para tema — ver `form-patterns.md` §11.
