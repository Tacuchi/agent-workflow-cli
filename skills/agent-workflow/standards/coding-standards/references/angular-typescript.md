# Angular / TypeScript — Convenciones detalladas

## Inyección de servicios

Los proyectos actuales usan constructor injection con `private`:

```typescript
@Injectable({ providedIn: 'root' })
export class SolicitudService {
  constructor(private apiService: ApiService) {}
}

@Component({ ... })
export class MiComponente {
  constructor(
    private solicitudService: SolicitudService,
    private router: Router
  ) {}
}
```

> **Nota**: `inject()` es válido en Angular 14+ y preferible en proyectos nuevos, pero seguir la convención del proyecto actual.

## NgModules

Los proyectos usan NgModules con routing modules separados:

```typescript
@NgModule({
  declarations: [AppComponent],
  imports: [
    BrowserModule,
    AppRoutingModule,
    ComponentsModule,
    SharedModule,
    ToastrModule.forRoot(),
    BrowserAnimationsModule
  ],
  bootstrap: [AppComponent]
})
export class AppModule {}
```

> **Nota**: Standalone components son válidos en Angular 15+ pero los proyectos actuales no los usan. No migrar a standalone a menos que el usuario lo pida.

## Async pipe en templates

Preferir async pipe sobre subscribe manual para datos del template:

```html
<div *ngIf="solicitudes$ | async as solicitudes">
  <app-tabla [data]="solicitudes"></app-tabla>
</div>
```

```typescript
solicitudes$ = this.solicitudService.listar();
```

## Tipos estrictos

Evitar `any`. Usar interfaces en `@data/interfaces/`:

```typescript
// Interfaces que espejean el backend
export interface IResponsePayload<T> {
  trace: Trace;
  status: Status;
  payload: T;
}

export interface ResponseDTO {
  identificador: number;
  cuerpo: string;
  mensaje: string;
}

// Incorrecto
const data: any = response.body;  // NO
```

## Estructura de proyecto

Ver `references/frontend-structure.md` para la arquitectura completa `@data`/`@presentation`.

## PATCH + Sparse DTO unificado (qtc-dev v2.6+)

Para mantenimientos CRUD seguir las reglas de `references/fe-be-integration.md`:

- **Interface única** `<Feature>SaveRequest` para create + edit con campos opcionales (`?` o `| null`).
- **POST** envía todos los required cargados; **PATCH** envía solo los campos modificados (resto omitido).
- ApiService expone `patch<T>(url, body)` paralelo a `post<T>(url, body)`.

```typescript
export interface CategoriaSaveRequest {
  nombre?: string | null;
  descripcion?: string | null;
  activo?: boolean | null;
  ordenVisual?: number | null;
}

@Injectable({ providedIn: 'root' })
export class CategoriasService {
  constructor(private apiService: ApiService) {}

  create(req: CategoriaSaveRequest): Observable<IResponsePayload<CategoriaResponse>> {
    return this.apiService.post(`${env.API_ADMIN}v1/categorias`, req);
  }

  edit(id: number, cambios: CategoriaSaveRequest): Observable<IResponsePayload<CategoriaResponse>> {
    return this.apiService.patch(`${env.API_ADMIN}v1/categorias/${id}`, cambios);
  }
}
```

En el componente de edición, construir el payload diff con solo los campos que cambiaron:

```typescript
guardar(): void {
  const original = this.categoriaOriginal;
  const form = this.form.value;
  const cambios: CategoriaSaveRequest = {};
  if (form.nombre !== original.nombre) cambios.nombre = form.nombre;
  if (form.descripcion !== original.descripcion) cambios.descripcion = form.descripcion;
  if (form.activo !== original.activo) cambios.activo = form.activo;
  if (form.ordenVisual !== original.ordenVisual) cambios.ordenVisual = form.ordenVisual;

  if (Object.keys(cambios).length === 0) return; // nada cambió

  this.servicio.edit(original.id, cambios).subscribe({
    next: (res) => this.toast.success('Guardado'),
    error: (err) => this.errorHandler.handle(err) // R4 — no silenciar
  });
}
```

**Anti-pattern**: enviar `form.value` completo en PATCH equivale a PUT y rompe la semántica sparse. Detalles + casos edge: `references/fe-be-integration.md`.

## Services y API

Todas las llamadas HTTP pasan por `ApiService` (wrapper central en `@data/services/`):

```typescript
@Injectable({ providedIn: 'root' })
export class SolicitudService {
  constructor(private apiService: ApiService) {}

  generaSolicitud(solicitud: Solicitud): Observable<IResponsePayload<ResponseDTO>> {
    const request = armarPayload<any>(solicitud);
    const url = `${env.API_PRESTAMO}v1/solicitud`;
    return this.apiService.post(url, request);
  }

  getOfertas(idSolicitud: number): Observable<IResponsePayload<IPayloadListG<Oferta>>> {
    const params = requestFilter({ idSolicitud });
    const url = `${env.API_PRESTAMO}v1/solicitud/listar-ofertas?${params}`;
    return this.apiService.get(url);
  }
}
```

No usar `HttpClient` directamente en services de presentación.

## Environments

URLs de API se configuran en environment files:

```typescript
export const environment = {
  production: false,
  API_PRESTAMO: '',
  API_SOLICITUD: '',
  API_IDENTIDAD: '',
  API_MOTOR: '',
};
```

Archivos: `environment.ts`, `environment.dev.ts`, `environment.prod.ts`

## Build y verificación

- Build producción: `npm run build:prod` (equivale a `ng build -c=production`)
- Build desarrollo: `npm run build:dev` (equivale a `ng build -c=development`)
- Serve local: `npm run start:dev`
- Tests: `ng test --watch=false`
- Estilos: SCSS
- UI: Angular Material + Bootstrap

## Formularios reactivos

Patrones al trabajar con `FormGroup` / `FormControl` en mantenimientos CRUD. Para los principios de UX (cuándo usar switch vs checkbox, layout de cards, hints en combos), ver skill `frontend-design`.

### Combo dependiente con carga diferida

Cuando el valor del combo B depende del valor del combo A, suscribirse a `valueChanges` de A en `ngOnInit`:

```typescript
this.formMantenimiento.get('idPadre')?.valueChanges.subscribe((valor) => {
  this.formMantenimiento.get('idHijo')?.setValue('');
  if (valor) {
    this.listarHijos(String(valor));
  } else {
    this.lstHijos = [];
  }
});
```

Al editar, la **precarga inicial** debe setear padre e hijo **sin** disparar el listener (para no perder el valor de hijo que viene del backend):

```typescript
this.formMantenimiento.patchValue({
  idPadre: data.idPadre != null ? String(data.idPadre) : '',
  idHijo:  data.idHijo  != null ? String(data.idHijo)  : ''
}, { emitEvent: false });

if (data.idPadre) {
  this.listarHijos(String(data.idPadre));
}
```

### Normalización de tipos en controles compartidos

Componentes custom tipo `search-select` o equivalentes suelen comparar opciones con `===`. Si las opciones tienen `value: "1"` (string) pero el DTO trae `1` (number), la opción **no matchea** y el combo queda vacío.

Regla: normalizar consistentemente en el `patchValue`. La forma que expone el componente UI manda:

```typescript
this.formMantenimiento.patchValue({
  idRol: data.idRol != null ? String(data.idRol) : ''
}, { emitEvent: false });
```

Aplicar la misma regla a todos los campos tipo id. Documentar la decisión si no es obvia.

### Sincronizaciones secuenciales con `concat`

Cuando N operaciones HTTP deben correr **en orden estricto** (evitar race conditions contra restricciones de unicidad del backend), usar `concat` de RxJS, no paralelo:

```typescript
import { concat, of } from 'rxjs';
import { toArray } from 'rxjs/operators';

const ops = [
  ...paraDesactivar.map(r => this.servicio.desactivar(r.id)),
  ...(nuevoRequerido ? [this.servicio.asignar(nuevo)] : [])
];
return ops.length ? concat(...ops).pipe(toArray()) : of([]);
```

Orden: primero desactivar los sobrantes, luego asignar el nuevo. Nunca paralelo en estos casos.

### Switch Bootstrap alineado

Patrón de clases para que el switch (3em×1.5em) quede alineado verticalmente con su label:

```html
<div class="form-switch d-flex align-items-center gap-2 ps-0 mb-0">
  <input type="checkbox" class="form-check-input m-0" role="switch" id="mi-switch"
         [checked]="activo" (change)="toggle($event)">
  <label class="form-check-label mb-0" for="mi-switch">Texto del switch</label>
</div>
```

Claves: `d-flex align-items-center gap-2` (alinea), `ps-0` (anula padding-left 1.5em default de `.form-check`), `input.m-0` y `label.mb-0` (anulan márgenes que desalinean con el switch grande).

Para la decisión UX **cuándo usar switch vs checkbox**, ver skill `frontend-design` (`references/form-patterns.md` §5).
