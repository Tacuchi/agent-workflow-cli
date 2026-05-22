# Patrones de feedback: toasts, alerts, loading, empty, errores

Principios de diseño para feedback al usuario: notificaciones transitorias, estados de carga, formularios con validación, estados vacíos, confirmación de acciones destructivas y propagación de errores HTTP. Agnóstico a framework.

Para el código del stack (`ToastService`, `LoadingService`, operadores RxJS para errores), ver `coding-standards/references/<stack>.md`.

---

## 1. Toasts: notificaciones transitorias

El toast es la forma por defecto de feedback tras una acción del usuario que tiene un resultado global (guardado exitoso, error de backend, confirmación no bloqueante).

**Cuatro tipos con títulos en español:**

| Tipo | Título mostrado | Uso típico |
|------|-----------------|------------|
| `success` | "Correcto" | Guardado, creación o actualización exitosa. |
| `info` | "Información" | Acciones informativas no críticas (p. ej. "copiado al portapapeles"). |
| `warning` | "Advertencia" | Validación fallida en client, límite de plan alcanzado, estado que requiere atención sin bloquear. |
| `danger` | "Error" | Errores HTTP, errores de negocio no capturables inline. |

**Reglas:**

- **Duración:** default del framework (~5 s). No extender arbitrariamente — si el mensaje es importante, va como alert inline, no toast.
- **Posición:** esquina superior-derecha (o top-center en mobile).
- **Singularidad:** evitar apilar varios toasts por una sola acción. Si la operación produce N mensajes, consolidarlos en uno o usar una alerta inline.
- **Mensajes específicos:** "Usuario guardado correctamente" > "Operación exitosa". "No se pudo cargar el listado" > "Error".

**Stack del proyecto:** `ToastService` wrapper de `ngx-toastr` centralizado. Ver detalles técnicos en `coding-standards/references/angular-typescript.md` (signature de `showToast(msg, type)` y guard de singleness).

---

## 2. Cuándo disparar cada tipo

**`success`:**

- Después de guardar/crear/actualizar exitoso.
- Después de completar un wizard.
- Después de copiar o exportar algo.

**`warning`:**

- Usuario intenta enviar formulario con errores de validación (siempre en conjunto con `markAllAsTouched()` — ver §4).
- Acción parcialmente exitosa ("Se eliminaron 3 de 5 elementos").
- Conflicto resuelto automáticamente por default.

**`danger`:**

- HTTP 4xx/5xx no silenciable (propagar al usuario, ver `coding-standards/SKILL.md` §Manejo de errores HTTP).
- Error de negocio devuelto por la API (`status.error.messages`).
- Operación crítica que falló (p. ej. sincronización de rol post-creación de usuario).

**`info`:**

- Feedback no crítico: "Se copió al portapapeles", "Sesión se cerrará en 5 minutos".
- Eventos de sistema con los que el usuario debe contar.

**Regla transversal:** nunca silenciar errores HTTP con `catchError → []`. Los errores **siempre** se propagan al usuario vía toast (u otro mecanismo explícito). Ver `coding-standards/SKILL.md` §Manejo de errores HTTP.

---

## 3. Loading: feedback de operaciones async

Dos niveles de loading, usar según contexto:

### 3.1 Page-level loading (recomendado para cargas de navegación)

Overlay global que cubre la aplicación mientras se resuelve una operación costosa (carga inicial de un listado, guardado de formulario que navega a otra vista).

**Reglas:**

- Mostrado/ocultado por un servicio centralizado (`LoadingService.show()` / `.hide()`).
- **Paired siempre:** cada `show()` tiene un `hide()` correspondiente en **next y error paths**. Nunca dejar el overlay colgado.
- El overlay se renderiza en la raíz de la app (no por vista), de forma que cubre sidebar, toolbar y contenido.
- Opcional: icono o mensaje breve centrado ("Cargando...") para evitar pantalla en blanco si la request tarda.

### 3.2 Inline loading (para operaciones localizadas)

Spinner embebido en el control que dispara la operación — no bloquea el resto de la UI.

**Patrones:**

- **Botón primario durante guardado:** spinner dentro del botón + texto cambiado a gerundio + `disabled` en ambos botones del footer:
  ```html
  <button class="btn btn-primary" [disabled]="saving">
    <span *ngIf="saving" class="spinner-border spinner-border-sm me-1"></span>
    {{ saving ? 'Guardando...' : 'Guardar' }}
  </button>
  ```
- **Tabla durante refresh:** overlay semitransparente sobre el `data-table` + spinner centrado, dejando filas visibles atrás con `opacity: 0.5`.

**Regla:** no mezclar overlay global + spinner inline para la misma acción. Elegir uno según el contexto:

- Acción que navega / es bloqueante → page-level.
- Acción en su vista, resultado en la misma vista → inline.

---

## 4. Validación inline de formularios

El usuario debe saber qué campo tiene problema **antes** de intentar guardar, y qué hacer si lo intenta con errores.

**Patrón:**

```html
<label class="form-label">Código</label>
<input type="text" class="form-control" formControlName="codigo"
       [class.is-invalid]="form.controls.codigo.touched && form.controls.codigo.invalid">
<div class="invalid-message"
     *ngIf="form.controls.codigo.touched && form.controls.codigo.invalid">
  Ingresa un código válido con formato <code>modulo.accion</code>.
</div>
```

**Reglas:**

- Mensaje de error **debajo del campo**, específico al problema ("formato `modulo.accion`" > "valor inválido").
- Se muestra sólo cuando el control está `touched` (el usuario ya pasó por el campo). No mostrar errores al entrar a la vista.
- Color del texto del error: semánticamente `danger` (rojo del framework). Tipografía pequeña (`small` o equivalente).
- Al intentar guardar con `form.invalid`: `markAllAsTouched()` + toast `warning` "Completa los campos obligatorios del formulario" — esto revela **todos** los errores a la vez y guía al usuario a arreglarlos.

**Clase `.invalid-message`:** CSS custom justificado (color del texto + tipografía) si el framework no ofrece la variante. Si Bootstrap 5 está disponible, preferir `invalid-feedback` (utility nativa) + `is-invalid` en el input.

---

## 5. Empty states

Cuando una lista, tabla o sección no tiene datos, mostrar un empty state claro en lugar de un área vacía.

**Variantes:**

### 5.1 Lista vacía tras filtro

El usuario buscó y no hubo resultados — el estado es temporal y dependiente de los filtros:

```html
<tr>
  <td [attr.colspan]="columns.length" class="text-center text-muted py-4">
    No se encontraron resultados con los filtros aplicados.
  </td>
</tr>
```

### 5.2 Lista vacía inicial (nunca hubo datos)

La entidad todavía no se creó — invitar a crear el primero:

```html
<div class="empty-state text-center py-5">
  <i class="fa fa-inbox fa-3x text-muted mb-3"></i>
  <h5>Aún no hay sucursales</h5>
  <p class="text-muted">Crea la primera para empezar.</p>
  <button class="btn btn-primary">+ Nueva sucursal</button>
</div>
```

**Reglas:**

- Mensaje **específico** al dominio ("No se encontraron usuarios" > "Sin datos").
- En empty inicial (5.2): ícono grande + título + descripción + call-to-action.
- En empty filtrado (5.1): sólo texto — el usuario sabe qué hizo para llegar acá.
- Evitar empty states alarmistas ("¡Atención! No hay datos"). El vacío es normal, no un error.

**[shared-candidato] `empty-state`** — componente reutilizable con `[icon]`, `[title]`, `[message]`, `[actionLabel]`, `[actionClick]`. Observado hoy duplicado en 5+ vistas con clases custom divergentes (`.empty-state`, `.empty-permissions`, `.empty-transfer`, `.empty-roles`, `.empty-roles`). Unificar.

---

## 6. Errores HTTP: propagación al usuario

**Regla fundamental (de `coding-standards/SKILL.md` §Manejo de errores HTTP):** nunca silenciar. Todos los errores HTTP llegan al usuario de alguna forma.

**Dos caminos según contexto:**

### 6.1 Errores que bloquean el flujo actual

La request falló y el usuario no puede continuar con lo que estaba haciendo (p. ej. guardar devolvió 500).

- Mostrar como **toast `danger`** con mensaje específico del backend (`status.error.messages[0]`) o genérico si no viene ("No se pudo guardar. Intenta de nuevo.").
- No cerrar el formulario / modal — el usuario debe poder reintentar o corregir.

### 6.2 Errores que afectan carga de sección (no bloquean toda la app)

La carga inicial de un sub-listado falló pero el resto de la vista funciona.

- Mostrar como **alerta inline** (`alert alert-warning` o equivalente) dentro del área afectada:
  ```html
  <div class="alert alert-warning py-2" *ngIf="store.error()">
    {{ store.error() }}
  </div>
  ```
- Incluir opción de reintento si tiene sentido.

**Recomendación:** para errores de guardado/sincronización/creación → **toast** (camino 6.1). Para errores de carga de lista/árbol/catálogo que se pueden mostrar inline → **alerta en el área** (camino 6.2). No hacer ambas cosas para el mismo error.

---

## 7. Confirmación de acciones destructivas

Antes de eliminar, desactivar o archivar, mostrar un diálogo de confirmación con contexto (ver `modal-patterns.md` §7):

- Tamaño `sm` o `md`.
- Título con pregunta clara.
- Body con impacto explícito (qué se elimina, si es reversible).
- Botón destructivo (color danger) con verbo específico ("Eliminar", "Desactivar"), no "Sí".
- Cancelar a la izquierda (default seguro).

**[shared-candidato] `confirm-dialog`** — componente reutilizable. Observado hoy como tres caminos distintos (`window.confirm()` del browser, `Swal.fire()` de SweetAlert2, modales ad-hoc por componente). Unificar en uno.

**Post-acción:**

- Éxito → toast `success` ("Elemento eliminado") + refresh del listado.
- Fallo → toast `danger` con razón + el elemento sigue en el listado (no removerlo optimistamente si la operación falló).

---

## 8. Skeletons, placeholders y animaciones de carga

Para experiencias de carga más cuidadas:

- **Skeleton rows** en tablas: filas con bloques grises que "laten" (shimmer animation) mientras cargan los datos reales. Ideal para listados con muchos ítems.
- **Placeholder de card**: rectángulo con líneas grises en lugar del contenido real.

**Regla:** los skeletons son un **nice-to-have**. Si el loading global cubre la operación adecuadamente, no complicarse. Reservar para listas donde el usuario espera >500 ms y el área vacía se siente rota.

---

## 9. Decisiones implícitas (recomendadas hacia adelante)

- **Toast para errores que bloquean** el flujo del usuario; alerta inline para errores de sección.
- **Loading global** para navegación y carga inicial; inline para refresh en la misma vista.
- **Validación doble:** inline en cada campo + toast warning al intentar guardar con `form.invalid`.
- **SweetAlert2 es legado** para confirmación. El camino a futuro es el `confirm-dialog` shared cuando se extraiga.
- **`window.confirm()` nunca** — rompe la consistencia visual.

---

## 10. Checklist de replicación

En cualquier vista nueva que dispare operaciones asíncronas:

- [ ] Loading global paired `show()`/`hide()` en next y error.
- [ ] Toast `success` al completar guardar/crear/eliminar exitosamente.
- [ ] Toast `danger` para errores HTTP que bloquean el flujo.
- [ ] Alerta inline para errores de carga de sección que no bloquean toda la app.
- [ ] Validación inline en cada campo del formulario + toast `warning` al intentar guardar inválido.
- [ ] Empty state con mensaje específico; empty inicial con CTA a "Crear el primero".
- [ ] Confirmación para acciones destructivas (verbo específico, color danger, reverseButtons).
- [ ] Nunca silenciar errores con `catchError(() => of([]))`.
- [ ] Revisar `shared/` antes de crear un nuevo toast/loading/empty custom.
