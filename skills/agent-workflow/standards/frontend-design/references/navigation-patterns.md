# Patrones de navegación

Principios de diseño para navegación en aplicaciones admin: sidebar, toolbar, breadcrumbs, tabs, routing, back navigation. Agnóstico a framework.

Para el código del stack (routing, guards, lazy loading, store sincronizado con `NavigationEnd`), ver `coding-standards/references/<stack>.md`.

---

## 1. Layout admin de 2 zonas

Las aplicaciones admin siguen un layout persistente con 2 zonas fijas alrededor del contenido:

```
┌──────────────────────────────────────────────────────────┐
│  Logo  [≡]     │   Breadcrumbs  |  Sucursal  Usuario  ⎋ │  ← toolbar (top)
├─────────────┬──┴──────────────────────────────────────────┤
│             │                                              │
│  Sidebar    │  Contenido de la vista                       │
│  (menu)     │  (title + action + filters + table/form)     │
│             │                                              │
│             │                                              │
└─────────────┴──────────────────────────────────────────────┘
```

**Reglas:**

- Toolbar fija en el top; sidebar fija a la izquierda.
- El contenido de la vista se renderiza en el área central (`<router-outlet>`).
- Sidebar colapsable: en desktop ocupa ~240 px expandida / ~60 px colapsada (solo íconos).
- En mobile: sidebar se convierte en drawer overlay (`position: fixed` + backdrop).

---

## 2. Sidebar

**Comportamiento:**

- **Colapsable** con toggle desde la toolbar. Estado persistente (store + opcional localStorage) para que sobreviva a navegación entre páginas.
- **Ítems dinámicos** leídos de un catálogo central (no hardcoded por app). El catálogo expone qué ve cada usuario según su rol.
- **Ítem activo destacado** con clase `.active` + color de fondo o borde lateral. Sincronizado con la ruta actual vía evento del router (`NavigationEnd` en Angular).

**Estructura de cada ítem:**

```html
<a class="sidebar-item" [class.active]="isActive" [title]="!sidebarOpen ? label : null">
  <span class="sidebar-icon"><i class="fa fa-users"></i></span>
  <span class="sidebar-label" *ngIf="sidebarOpen">{{ label }}</span>
</a>
```

**Reglas:**

- Ícono a la izquierda, label a la derecha. Label se oculta en colapsado; tooltip (`title`) lo sustituye.
- Máximo 1 nivel de anidación visible; si el menú crece, agrupar por secciones con separador.
- Ítems ordenados por frecuencia de uso del rol dominante (no alfabéticamente).
- Pie opcional con "Volver al home" o enlace al cambio de app.

---

## 3. Toolbar (top bar)

3 zonas horizontales:

| Zona | Contenido |
|------|-----------|
| Izquierda | Logo + botón toggle del sidebar. |
| Centro | Breadcrumbs (opcional — ver §5). |
| Derecha (desktop) | Contexto (sucursal si es cambiable) + nombre usuario + avatar + logout. |
| Derecha (mobile) | Solo avatar; al tap abre drawer con las opciones. |

**Reglas:**

- Logo siempre navegable al home (click → ruta raíz).
- El **contexto** (sucursal activa, periodo contable, etc.) vive en la toolbar cuando es relevante al trabajo en curso y puede cambiarse globalmente.
- **Avatar = iniciales** (primeras 2 letras del nombre, upper) si no hay foto. Badge redondo con color consistente por usuario.
- Logout como enlace `⎋` o "Salir" — nunca oculto en un sub-menú innecesario.

---

## 4. Título de página + acción primaria (page header)

Cada vista del área de contenido abre con un header consistente:

```html
<div class="mb-4">
  <div class="d-flex justify-content-between align-items-center flex-wrap gap-3">
    <div>
      <h2 class="fw-bold mb-1">Título de la vista</h2>
      <p class="text-muted mb-0">Descripción de una línea.</p>
    </div>
    <button class="btn btn-primary">Acción primaria</button>
  </div>
</div>
```

**Reglas:**

- `h2 fw-bold` para el título, `p text-muted` para la descripción de una sola línea.
- Acción primaria top-right; si no hay, el header queda sin botón (no forzar uno).
- `flex-wrap gap-3` para que el botón baje en mobile sin solaparse.

**[shared-candidato] `page-header`** — se repite en 6+ vistas; amerita extracción con slots `[title]`, `[subtitle]`, `[action]`. Ver también `list-patterns.md` §2 y `form-patterns.md` §2.

---

## 5. Breadcrumbs

**Cuándo activarlos:**

- Jerarquía de navegación es profunda (3+ niveles) y la ruta es relevante al usuario.
- La URL no es suficientemente descriptiva (IDs en vez de nombres).

**Cuándo omitirlos:**

- App de 2 niveles (home → sección). El título de la vista ya indica dónde está el usuario.
- Admin plano (todos los módulos al mismo nivel bajo `/admin`). El sidebar ya es la navegación principal.

**Estructura cuando existen:**

```html
<nav class="breadcrumbs">
  <a routerLink="/admin">Administración</a>
  <span class="separator">›</span>
  <a routerLink="/admin/usuario">Usuarios</a>
  <span class="separator">›</span>
  <span class="current">Editar</span>
</nav>
```

**Reglas:**

- Separador visual (`›`, `/`, `>`). Tipografía pequeña (`small`) + color atenuado para los links intermedios.
- Último ítem (la vista actual) no es link; se destaca en negrita o color del texto base.
- Derivados del router (no escritos a mano por vista) — para que nunca queden desincronizados con la URL real.

---

## 6. Tabs dentro de una sección

Cuando un módulo tiene 2-3 sub-vistas relacionadas (p. ej. "Sucursales" + "Carga masiva", o "Roles" + "Permisos"), usar tabs en vez de ítems separados del sidebar.

```html
<ul class="nav nav-tabs mb-4 px-2 bg-white rounded-top">
  <li class="nav-item">
    <a class="nav-link" routerLink="./roles" routerLinkActive="active">Roles</a>
  </li>
  <li class="nav-item">
    <a class="nav-link" routerLink="./permisos" routerLinkActive="active">Permisos</a>
  </li>
</ul>
<router-outlet></router-outlet>
```

**Reglas:**

- **Tabs con routing** (`routerLink` + `routerLinkActive`) — cada tab es una URL propia, bookmarkeable y con back button funcional.
- Evitar tabs con estado local (`[tab]="currentTab"` sin routing) cuando las sub-vistas son no triviales; el usuario pierde su lugar al recargar.
- Máximo 3-4 tabs por sección. Si hay más, probablemente son módulos independientes que merecen sidebar.

**[shared-candidato]:** el componente shared `nav-tabs` existe pero se usa mezclando los dos enfoques (routing vs state local). Documentar qué enfoque gana (routing) y migrar los que están en state local.

---

## 7. Back navigation

Para vistas que abren desde un listado (p. ej. `admin/usuario` → `admin/usuario/editar/:id`), ofrecer retorno explícito al listado:

- **Opción A (recomendada):** link "← Volver a usuarios" en la parte superior del header, alineado con el título.
- **Opción B:** botón `Cancelar` en el footer del formulario que navega a la ruta padre.

**Reglas:**

- El back siempre navega a la ruta **explícita** (router a `/admin/usuario`), no `history.back()` (comportamiento impredecible si el usuario llegó por deep link o recarga).
- Usar un helper compartido para resolver la "ruta padre" desde la ruta actual (evita hardcodear). 

**[shared-candidato] `back-button`** — observado reinventado en 3+ lugares (`volverHome()` en sidebar, `irHome()` en header, similar en sucursal). Extraer a un componente o servicio.

---

## 8. Routing: lazy loading y rutas anidadas

Cada módulo admin (usuario, sucursal, producto, accesos, etc.) vive como **módulo Angular lazy-loaded** bajo el layout padre:

```ts
{ path: 'usuario', loadChildren: () => import('./usuario/usuario.module').then(m => m.UsuarioModule) }
```

Cada módulo hijo define sus rutas anidadas (`lista`, `nuevo`, `editar/:id`, sub-tabs, modales con estado en URL si aplica).

**Reglas:**

- El layout admin (`admin-layout.component`) envuelve todas las rutas hijas con `<router-outlet>`, de forma que sidebar y toolbar persistan entre navegaciones.
- Default redirect por módulo: `{ path: '', redirectTo: 'lista' }` para que `/admin/usuario` abra automáticamente el listado.
- Guards a nivel de layout (autenticación, sesión) — no repetir en cada ruta hija.

Detalles técnicos y ejemplo completo del routing: `coding-standards/references/angular-typescript.md` y `coding-standards/references/frontend-structure.md`.

---

## 9. Stack del proyecto

El proyecto usa **Angular + Bootstrap + ng-bootstrap**:

- **Sidebar/toolbar:** componentes dedicados en `@presentation/admin/layout/` (`admin-layout`, `sidebar`, `toolbar`). Consumen `MenuCatalogService` para el catálogo dinámico.
- **Tabs:** usar `nav-tabs` shared con `routerLink` + `routerLinkActive="active"`. La variante state-local existe pero es legado — no replicar.
- **Breadcrumbs:** hay lógica en `AdminStore.breadcrumbs` (computed signal) pero **no se renderiza en la UI actual**. Si se activa, conectar el computed al template en `admin-layout`.
- **wizard-footer** shared existe pero no se usa en admin. Reservado para futuros flujos multi-step.

---

## 10. Checklist de replicación

Al añadir un módulo nuevo bajo admin:

- [ ] Lazy loading como módulo Angular (`loadChildren`).
- [ ] Añadir ítem en el catálogo de menú (`MenuCatalogService`) con nombre, ícono y ruta.
- [ ] Rutas anidadas dentro del módulo: `lista`, `nuevo`, `editar/:id` como mínimo.
- [ ] Default redirect del módulo → `lista`.
- [ ] Page header consistente en cada vista (`h2 fw-bold` + descripción + acción).
- [ ] Si hay sub-vistas relacionadas, tabs con routing (no state local).
- [ ] Back navigation explícito en las vistas de edición.
- [ ] Sidebar/toolbar se heredan del layout padre — no crear otros.
- [ ] Guards de sesión/autenticación a nivel de layout.
- [ ] Revisar `shared/` antes de crear helpers de navegación.
