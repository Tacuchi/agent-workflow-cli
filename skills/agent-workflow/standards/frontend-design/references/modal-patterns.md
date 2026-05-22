# Patrones de modales / diálogos

Principios de diseño para modales (diálogos sobre overlay): cuándo usarlos, layout interno, tamaños, formularios dentro, confirmaciones destructivas. Agnóstico a framework.

Para el código de stack (API de apertura/cierre, paso de data, suscripción a resultado), ver `coding-standards/references/<stack>.md`.

---

## 1. Cuándo usar modal vs vista dedicada

**Modal:**

- Edición/creación **simple** (2-5 campos, < 30 s de interacción).
- Selector/buscador (p. ej. seleccionar sucursal entre N).
- Confirmación de acción destructiva.
- Presentación de detalle que no amerita ruta propia.

**Vista dedicada (ruta):**

- Edición **compleja** con múltiples dominios/cards (→ usar `form-patterns.md`).
- Workflow multi-step con navegación.
- Cuando la URL debe ser compartible/bookmarkeable.
- Cuando hay breadcrumbs relevantes.

**Regla:** si la interacción requiere desplazarse mucho verticalmente (scroll interno del modal) o el usuario va a quedarse más de 30 segundos, es una vista dedicada, no un modal.

---

## 2. Layout interno

Todo modal respeta tres zonas con separación visual:

```
┌─────────────────────────────────────────────────┐
│  Título                              [X]        │  ← header
│  Descripción opcional                           │
├─────────────────────────────────────────────────┤
│                                                  │
│  Contenido (form, lista, detalle)               │  ← body
│                                                  │
├─────────────────────────────────────────────────┤
│                         [Cancelar] [Acción]     │  ← footer
└─────────────────────────────────────────────────┘
```

**Implementación (Bootstrap):**

```html
<div class="modal-header">
  <div>
    <h4 class="modal-title fw-bold mb-1">Editar permiso</h4>
    <p class="text-muted mb-0">Actualiza el código y descripción.</p>
  </div>
  <button type="button" class="btn-close" aria-label="Cerrar"></button>
</div>

<div class="modal-body">
  <!-- Contenido -->
</div>

<div class="modal-footer">
  <button type="button" class="btn btn-outline-secondary">Cancelar</button>
  <button type="button" class="btn btn-primary">Guardar</button>
</div>
```

**Reglas:**

- Título en `h4 fw-bold`, descripción opcional en `p text-muted mb-0`.
- Botón `X` de cerrar arriba-derecha, alineado con el título.
- Body con padding default; si el contenido es largo, scroll interno (no empujar header/footer).
- Separadores visuales (border entre header/body/footer) los provee el framework por defecto.

---

## 3. Tamaños

Usar las categorías del framework, no anchos en píxeles:

| Tamaño | Uso típico |
|--------|------------|
| `sm` (~300 px) | Selectores cortos, confirmaciones. |
| `md` (~500 px) | Creación/edición simple con 2-4 campos. |
| `lg` (~800 px) | Formulario con varios dominios en 1 sola vista, tabla de selección. |
| `xl` (~1140 px) | Raramente; si se necesita, suele ser señal de que amerita vista dedicada. |

**Reglas:**

- `centered: true` — modal centrado verticalmente.
- `backdrop: 'static'` — no se cierra al click fuera (evita pérdidas accidentales en formularios).
- Responsive: en mobile el modal se adapta al viewport (no fijar anchos absolutos).

**Patrones a evitar:**

- Anchos fijos en píxeles (`width: '500px'`) — no se adaptan a viewport ni a configuración del usuario. El camino recomendado es usar las categorías del stack; ver `coding-standards/references/<stack>.md`.

---

## 4. Formulario dentro de modal

El modal que contiene un formulario sigue las mismas reglas visuales que un formulario de página (ver `form-patterns.md`) en miniatura:

- Un solo dominio por modal (no 4 cards — eso es vista dedicada).
- Labels siempre visibles (`form-label`), no usar placeholder como label.
- Validación inline debajo del campo con mensaje específico (ver `feedback-toasts-patterns.md` §4).
- Al intentar guardar con `form.invalid`: `markAllAsTouched()` + toast `warning` "Completa los campos obligatorios".
- Campos `readonly` con candado (`form-patterns.md` §3) se mantienen dentro del modal si aplica.

**Ejemplo mínimo:**

```html
<div class="modal-body">
  <form [formGroup]="form" class="row g-3">
    <div class="col-12">
      <label class="form-label">Código</label>
      <input type="text" class="form-control" formControlName="codigo">
      <div class="invalid-message" *ngIf="form.controls.codigo.touched && form.controls.codigo.invalid">
        Ingresa un código válido con formato <code>modulo.accion</code>.
      </div>
    </div>
  </form>
</div>
```

---

## 5. Footer: botones y estados

**Alineación:** `Cancelar` (outline-secondary) a la izquierda, **acción primaria** (`btn-primary`) a la derecha. El framework coloca ambos a la derecha por default; si se quiere espaciado explícito, usar utilities (`justify-content-between`).

**Textos estándar:**

- Izquierda: `Cancelar` siempre.
- Derecha: `Guardar` / `Guardar cambios` / `Continuar` / `Confirmar` según contexto. Usar el verbo más específico disponible.

**Loading state en el botón primario mientras vuela la request:**

```html
<button class="btn btn-primary" [disabled]="saving">
  <span *ngIf="saving" class="spinner-border spinner-border-sm me-1"></span>
  {{ saving ? 'Guardando...' : 'Guardar' }}
</button>
```

**Reglas:**

- `disabled` **en ambos botones** mientras se guarda (cancelar también, para que el usuario no descarte el modal durante la request).
- El spinner inline en el botón es feedback local suficiente — no mostrar overlay global **y** spinner inline a la vez.

---

## 6. Resultado al cerrar

Convención del payload al cerrar el modal con éxito:

```ts
{ saved: true, data: { /* la entidad guardada */ } }
```

El caller inspecciona `saved` para decidir si refrescar la lista. Si el usuario cancela (X, ESC, botón Cancelar), el modal se descarta sin payload.

**Regla:** ser consistente — **todos** los modales del proyecto siguen la misma convención de payload. Detalles técnicos de la API de cierre viven en `coding-standards/references/<stack>.md`.

---

## 7. Confirmación de acciones destructivas

Antes de eliminar, desactivar, archivar — **siempre** una confirmación explícita:

```
┌─────────────────────────────────────┐
│  ⚠ ¿Eliminar este elemento?         │
│                                      │
│  El elemento 'XYZ' se eliminará.    │
│  Esta acción no se puede deshacer.  │
│                                      │
│              [Cancelar] [Eliminar]  │
└─────────────────────────────────────┘
```

**Reglas:**

- Tamaño `sm` o `md` (confirmación es corta).
- Título con icono de advertencia + pregunta clara en 1 línea.
- Body con 1-2 líneas explicando el impacto (qué se elimina, si es reversible).
- Botón primario es la acción **destructiva** con color de peligro (`btn-danger`), no `btn-primary`.
- Label del botón destructivo: "Eliminar" / "Desactivar" — nunca "Sí" o "OK".
- `reverseButtons` si el framework lo permite, para que Cancelar quede a la izquierda (default seguro).

**[shared-candidato] `confirm-dialog`** — componente reutilizable con `[title]`, `[message]`, `[confirmLabel]`, `[cancelLabel]`, `[severity]: 'danger'|'warning'|'info'`. Observado hoy como tres caminos distintos (`window.confirm()` del browser, `Swal.fire()` de SweetAlert2, y modales ad-hoc) — unificar en uno solo.

---

## 8. Stack del proyecto

El proyecto usa **Angular + Bootstrap**. En este contexto:

- **Recomendado:** `NgbModal` de ng-bootstrap para todos los modales nuevos (admin lo usa consistentemente).
- **Legado:** `MatDialog` de Angular Material existe en módulos antiguos (`pages/` de contabilidad, identidad, seguros). **No crear nuevo código con MatDialog.** Cuando se toque uno existente por bugfix, respetar su API local.
- **Nunca:** modales artesanales con `.modal` + overlay custom CSS. Un módulo lo hace (campañas) y es deuda técnica; no replicar.

El detalle de cómo abrir/cerrar cada uno (signature de `.open()`, paso de `data`, suscripción a `.result` o `.afterClosed`) vive en `coding-standards/references/angular-typescript.md`.

---

## 9. Checklist de replicación

Al crear un modal nuevo:

- [ ] Evaluar si es modal o vista dedicada (regla: < 30 s de interacción, 1 dominio).
- [ ] Librería `NgbModal` (no `MatDialog` para código nuevo).
- [ ] Tamaño por categoría (`sm`/`md`/`lg`), no pixels.
- [ ] `centered: true` + `backdrop: 'static'`.
- [ ] Header con `h4 fw-bold` + descripción opcional + `btn-close`.
- [ ] Body con padding default; scroll interno si el contenido crece.
- [ ] Footer: Cancelar izq + acción primaria der; loading en el primario.
- [ ] Si el modal tiene formulario, aplicar reglas de `form-patterns.md`.
- [ ] Convención de resultado: `{ saved: true, data }` o `undefined` en cancelación.
- [ ] Para confirmación destructiva: usar `confirm-dialog` (si existe) o replicar el patrón §7 hasta que se extraiga.
- [ ] Revisar `shared/` antes de crear helpers o subcomponentes propios.
