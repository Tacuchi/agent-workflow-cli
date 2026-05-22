# Patrones de formulario CRUD — editar / nuevo

Principios de diseño para vistas de mantenimiento (editar una entidad existente o crear una nueva). **Agnóstico a framework**: los ejemplos usan HTML con utilities Bootstrap, pero el principio aplica a cualquier stack (Tailwind, Material, Bulma, etc.).

Para el código específico del stack que implementa estos patrones, ver `coding-standards/references/<stack>.md`.

---

## 1. Modelo mental: UX single-slot sobre modelo multi-slot

La BD puede admitir N filas por relación (p. ej. N roles por usuario), pero el **formulario expone 1**. Decisión de diseño explícita: la UI simplifica el modelo para el caso dominante; el modelo flexible queda disponible para otros flujos (p. ej. un asignador multi-rol dedicado).

**Regla:** al guardar con single-slot se "reemplaza" — se desactivan/eliminan las demás filas y queda sólo la seleccionada. La sincronización vive en **una** capa (frontend contra microservicio, o backend al persistir), no en ambas.

Cuándo exponer N (multi-slot) en la UI: sólo cuando el dominio lo exige (p. ej. asignar múltiples responsables a un ticket). Si hay duda, empezar con single-slot y evolucionar.

---

## 2. Layout: 4 cards en 2 columnas, 1 dominio por card

Agrupar los campos del formulario por **dominio lógico**, una card por dominio:

```
┌─────────────────────────────┐ ┌─────────────────────────────┐
│ 👤 Persona                  │ │ 💼 Asignación              │
│   Tipo doc. / Número (RO)   │ │   Negocio / Sucursal        │
│   Nombres / Apellidos       │ │   Rol + hint                │
└─────────────────────────────┘ └─────────────────────────────┘
┌─────────────────────────────┐ ┌─────────────────────────────┐
│ ✉ Contacto                 │ │ 🛡 Acceso                  │
│   Correo / Celular          │ │   Estado / Bloqueado        │
└─────────────────────────────┘ │   [switch] Cambiar clave    │
                                 └─────────────────────────────┘
           [Cancelar]                        [Acción primaria]
```

**Implementación (Bootstrap, framework-first):**

```html
<form class="row g-4">
  <div class="col-12 col-xl-6">
    <div class="border rounded-3 shadow-sm p-3">
      <div class="d-flex align-items-center gap-2 mb-3">
        <span class="section-icon"><i class="fa fa-user"></i></span>
        <h4 class="fw-bold mb-0">Persona</h4>
      </div>
      <!-- campos del dominio -->
    </div>
  </div>
  <!-- más cards... -->
</form>
```

Equivalente Tailwind:

```html
<form class="grid grid-cols-1 xl:grid-cols-2 gap-4">
  <div class="border rounded-lg shadow-sm p-4">
    <div class="flex items-center gap-2 mb-3">
      <span class="section-icon"><i class="fa fa-user"></i></span>
      <h4 class="font-bold m-0">Persona</h4>
    </div>
    <!-- campos -->
  </div>
</form>
```

**Regla:** un dominio por card. Si aparece un 5º dominio, añadir otra card; **no** mezclar dos dominios en una misma card por ahorrar espacio.

**CSS custom justificado:** sólo `.section-icon` (cuadradito 2rem×2rem con tema del proyecto) — el framework no ofrece esta variante como utility. El wrapper de la card **no** amerita custom: `border rounded-3 shadow-sm` lo expresa.

---

## 3. Campos readonly con candado

Los campos que no se editan en esta vista se marcan visual y funcionalmente:

```html
<div class="input-group input-readonly">
  <span class="input-group-text"><i class="fa fa-lock"></i></span>
  <input type="text" class="form-control" value="12345678" readonly>
</div>
```

**Disciplina:** readonly se ve **diferente** a editable — fondo atenuado, candado visible. No basta con el atributo `readonly`; el usuario debe percibir "esto no se toca aquí".

**CSS custom justificado (tema del sistema):**

```css
.input-readonly .input-group-text { background: #f1f3f5; color: #868e96; border-right: 0; }
.input-readonly .form-control     { background-color: #f8f9fa; border-left: 0; }
```

Este tema es específico del sistema de diseño; el framework no lo da. Custom es legítimo.

**[shared-candidato]:** si aparece en 2+ vistas, extraer a un componente `readonly-input` que reciba `icon` y `value`.

---

## 4. Combo dependiente: hints contextuales

Cuando B depende de A (p. ej. sucursal depende de negocio financiero), el UX debe informar al usuario **qué está pasando**:

- Si A no tiene valor: `"Seleccione primero <A>."`
- Si A tiene valor y B está cargando: `"Cargando <B>..."`
- Si A tiene valor y B vino vacío: `"No hay <B> disponibles."`
- Si la decisión de B tiene impacto no obvio (p. ej. rol → permisos): hint **siempre visible** explicando ese impacto.

Implementación (framework-first):

```html
<label for="sel-hijo">Sucursal</label>
<select id="sel-hijo" class="form-select">...</select>
<div class="text-muted small mt-1">{{ hintSucursal }}</div>
```

**Regla:** el hint vive debajo del combo, con tipografía atenuada del framework (`text-muted small` en Bootstrap, `text-sm text-gray-500` en Tailwind). No inventar clase custom.

---

## 5. Switch vs checkbox

Regla de decisión:

- **Switch**: cuando el toggle representa un **modo** (encender/apagar una capacidad: "cambiar contraseña", "activo", "notificaciones por correo").
- **Checkbox**: cuando se **selecciona un ítem** en una lista ("acepto términos", ítems de un multiselect, filtros marcables).

Si dudas: ¿activar esto cambia **cómo se comporta** el sistema? Switch. ¿Es una marca de "sí me aplica"? Checkbox.

**Alineación vertical correcta** (switch crecido a 3em×1.5em):

```html
<div class="form-switch d-flex align-items-center gap-2 ps-0">
  <input type="checkbox" class="form-check-input m-0" role="switch" id="mi-switch">
  <label class="form-check-label mb-0" for="mi-switch">Activo</label>
</div>
```

Claves:

- `d-flex align-items-center gap-2` — alinea verticalmente con el label.
- `ps-0` — anula el padding-left 1.5em default de `.form-check`.
- `input.m-0` y `label.mb-0` — anulan márgenes que desalinean con el switch grande.

**CSS custom mínimo (dimensiones del switch):**

```css
.form-switch .form-check-input { width: 3em; height: 1.5em; cursor: pointer; }
```

El resto es utilities.

**[shared-candidato]:** `switch-aligned` — encapsula el patrón completo con `[label]` y `[(checked)]`.

---

## 6. Campo opcional con switch que colapsa y limpia

Patrón para campos **opcionales en editar** que son **obligatorios en crear** (ejemplo típico: contraseña).

- Un switch "Cambiar contraseña" (desactivado por default en editar).
- Al activar: aparecen los campos de contraseña + confirmación.
- Al desactivar: los campos se **ocultan y se limpian**.
- La validación de igualdad entre contraseña y confirmación corre **sólo** si el switch está activo.

**Regla:** el switch no sólo oculta visualmente — **limpia** los valores del estado del formulario. De lo contrario queda basura en el payload al guardar. La implementación técnica (cómo limpiar el FormGroup, cómo condicionar la validación) vive en `coding-standards/references/angular-typescript.md`.

---

## 7. Estado y bloqueado son dimensiones separadas

Dos conceptos con nombres parecidos pero significado distinto:

- **Estado** (habilitado/deshabilitado a nivel dato): el registro existe pero no se muestra / no se usa. Típico flag `estado` (1/0) o `activo` (Y/N).
- **Bloqueado** (por autenticación): el usuario no puede iniciar sesión — demasiados intentos fallidos, admin lo bloqueó, suspensión temporal. Típico flag `deshabilitado` o `bloqueado`.

Son **ortogonales**: un usuario puede estar `estado=1` (activo) y `bloqueado=Y` (no puede entrar por intentos fallidos).

**Regla UX:** dos combos separados, no un solo campo mezclando semánticas. Nombrar cada uno por su concepto: "Estado" y "Bloqueado" (o "Acceso"), no "Estatus" genérico.

---

## 8. Readonly disciplinado

Los campos que no se editan en la vista actual se marcan **visual + funcionalmente**:

- Visualmente: candado + fondo atenuado (patrón §3).
- Funcionalmente: atributo `readonly` o `disabled` según corresponda (readonly envía el valor en el payload; disabled no).

**Regla:** si el campo es inmutable en esta vista pero editable en otra, documentarlo (hint breve: "Se edita en <otra vista>").

**Anti-patrón:** dejar el campo editable pero confiar en que el backend rechace el cambio. El usuario pierde tiempo escribiendo y recibe error.

---

## 9. Placeholder con formato esperado

Campos libres (teléfono, documento, código) deben mostrar el formato esperado en el placeholder:

- `+51 ...` para teléfono.
- `DNI 8 dígitos` para documento.
- `ABC-1234` para códigos con formato.

No usar placeholder como label (degrada accesibilidad al tipear). El `<label>` + `placeholder` + hint muted forman la tríada completa.

---

## 10. Reutilización antes que duplicación (shared/)

**Regla transversal:** antes de codear cualquier pieza visual del formulario, revisar `shared/` (o el directorio de componentes comunes del proyecto) si ya existe.

Patrones candidatos a ser compartidos:

- `readonly-input` — input con candado + fondo atenuado (§3).
- `section-card` — wrapper con section-title + icono + contenido (§2).
- `switch-aligned` — switch alineado con label (§5).
- `combo-hint` — select + hint muted debajo (§4).
- `primary-button-spinner` — botón de acción con estado de loading.

**Heurística:** si un patrón aparece en 2 mantenimientos distintos, o se proyecta a repetirse, **proponer extracción explícita como diff aislado** antes de inline-ar el código nuevo. No mezclar la extracción con el feature — dos commits separados.

**Para el asistente:** al implementar una sección de este skill en código, primero `grep`/`glob` por nombres similares en `shared/`; si existe, usar; si no, preguntar al usuario si vale extraerlo antes de codear inline.

---

## 11. Framework-first CSS (~90/10)

**Regla transversal:** ~90 % del styling se expresa con **utilities del framework** (Bootstrap, Tailwind, Angular Material, etc.). Sólo ~10 % amerita CSS custom.

### Framework gana para:

- Spacing (`p-3`, `m-4`, `gap-2`).
- Flex / Grid (`d-flex`, `row g-4`, `grid grid-cols-2`).
- Tipografía general (`fw-bold`, `text-muted`, `small`).
- Colores semánticos del sistema (`text-danger`, `bg-light`).
- Breakpoints responsivos (`col-12 col-xl-6`, `xl:grid-cols-2`).
- Estados hover/focus/disabled que el framework ya cubre.

### Custom justificado cuando:

- (a) Hay un **tema específico** del proyecto que el framework no expresa: colores del candado readonly, dimensiones custom de switch (3em×1.5em), tipografía del logo.
- (b) La **combinación de utilities se repite 5+ veces** y amerita una clase semántica para DRY: p. ej. `.card-domain { @apply border rounded-lg shadow-sm p-4; }` (cuando el framework lo permite).
- (c) El framework **no tiene la variante exacta** y sobrescribirlo con `!important` es peor.

### Anti-patrones:

- Reescribir `.my-card { border: 1px solid; padding: 1rem; box-shadow: ... }` cuando `border rounded-3 shadow-sm p-3` lo resuelve.
- Crear `.my-flex { display: flex; align-items: center; gap: 0.5rem }` en vez de usar `d-flex align-items-center gap-2`.
- Copiar el tema del framework en variables custom "para tenerlo local".

### Criterio práctico para el asistente

Antes de escribir una regla CSS custom, preguntarse: **"¿hay utility que lo haga?"**.

- Sí → utility.
- No → ¿el tema aplicará a 3+ lugares?
  - Sí → clase semántica con comentario breve explicando la razón.
  - No → inline con utilities y punto.

---

## 12. Checklist de replicación

Al aplicar estos patrones a un mantenimiento nuevo (p. ej. `admin/producto`, `admin/sucursal`):

- [ ] Identificar los 3-4 dominios del formulario y agrupar en cards.
- [ ] Layout de cards con utilities del framework (`row g-4` + `col-12 col-xl-6` o equivalente).
- [ ] Marcar readonly los campos que no se editan aquí (candado + `readonly`/`disabled`).
- [ ] Combo dependiente: mostrar hint contextual ("seleccione primero X", "cargando", "sin resultados").
- [ ] Si el modelo permite N pero UX requiere 1: implementar single-slot (una capa, no dos).
- [ ] Toggles no triviales → switch alineado con utilities.
- [ ] Campo opcional en edición → switch que colapsa **y** limpia.
- [ ] Estado y bloqueado (si aplica) en combos separados.
- [ ] Placeholder con formato esperado en campos libres.
- [ ] **Antes de codear:** `grep` en `shared/` por componentes ya existentes.
- [ ] **Antes de escribir CSS:** revisar utilities del framework.
- [ ] Si se crea CSS custom, dejar **comentario breve** con la razón (tema / DRY / framework gap).
- [ ] Errores del backend se propagan al usuario (toast/mensaje), nunca silenciados.
