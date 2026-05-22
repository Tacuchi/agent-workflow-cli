# Estructura de Proyecto Frontend

Convenciones de estructura para aplicaciones Angular del tu ecosistema.

## Versiones en uso

- Angular 15 (pefectivo-front-angular)
- Angular 16 (core-frontend-miscuotas-externo)
- TypeScript 4.9 - 5.1

## Arquitectura `@data` / `@presentation`

```
src/app/
├── @data/                    ← Capa de datos
│   ├── interfaces/           ← Interfaces TypeScript (espejean el backend)
│   ├── services/             ← ApiService central + services de datos
│   ├── guards/               ← Route guards
│   ├── interceptors/         ← HTTP interceptors
│   └── directive/            ← Directivas custom
├── @presentation/            ← Capa de presentación
│   ├── components/           ← Componentes de UI organizados por feature
│   ├── services/             ← Services de negocio/UI que consumen ApiService
│   ├── shared/               ← Componentes y módulos compartidos
│   ├── auth/                 ← Módulo de autenticación (si aplica)
│   ├── home/                 ← Página principal
│   └── pages/                ← Páginas de la aplicación
├── Utils/                    ← Utilidades (armarPayload, requestFilter, etc.)
├── app.module.ts
├── app-routing.module.ts
└── app.component.ts
```

## ApiService — Wrapper HTTP central

Todas las llamadas HTTP pasan por `@data/services/api.service.ts`. No usar `HttpClient` directamente en otros services.

```typescript
@Injectable({ providedIn: 'root' })
export class ApiService {
  constructor(
    private toast: ToastService,
    private http: HttpClient,
    private storageService: StorageService
  ) {}

  get(path: string, params?: any): Observable<any> {
    return this.http.get(path, { params }).pipe(
      catchError((error: HttpErrorResponse) => {
        if (error.status === 401) {
          window.location.href = this.storage.url;  // Redirección en 401
        }
        const errorMessage = error?.error?.status?.error?.messages?.[0] ?? 'Error inesperado';
        this.toast.showToast(errorMessage, 'danger');
        return this.formatErrors(error);
      })
    );
  }

  post(path: string, body: any): Observable<any> { /* mismo patrón */ }
  put(path: string, body: object = {}): Observable<any> { /* mismo patrón */ }
  patch(path: string, body: object = {}): Observable<any> { /* mismo patrón */ }
  delete(path: string): Observable<any> { /* mismo patrón */ }
}
```

## Interfaces — Espejeo del backend

En `@data/interfaces/` se definen interfaces que reflejan las estructuras del backend:

```typescript
// generics.ts — Equivale a RespBase<T> del backend
export interface IResponsePayload<T> {
  trace: Trace;
  status: Status;
  payload: T;
}

export interface IPayloadListG<T> {
  count: number;
  total: number;
  items: T[];
}

export interface ResponseDTO {
  identificador: number;
  cuerpo: string;
  mensaje: string;
}
```

Cada entidad de negocio tiene su propia interface: `solicitud.ts`, `credito.ts`, `cliente.ts`, `oferta.ts`, etc.

## Services de presentación

En `@presentation/services/` se crean services que consumen `ApiService`:

```typescript
@Injectable({ providedIn: 'root' })
export class SolicitudService {
  constructor(private apiService: ApiService) {}

  generaSolicitud(solicitud: Solicitud): Observable<IResponsePayload<ResponseDTO>> {
    const request = armarPayload<any>(solicitud);
    const url = `${env.API_PRESTAMO}v1/solicitud`;
    return this.apiService.post(url, request);
  }
}
```

Patrón: URL desde environment + payload armado con `armarPayload()` de `Utils/`.

## Utilidades

`Utils/utils.ts` provee funciones compartidas:
- `armarPayload<T>(data)` — Envuelve datos en la estructura `ReqBase` con trace
- `requestFilter(params)` — Convierte un objeto a query string

## Environments

Tres archivos de configuración con URLs de API:

- `environment.ts` — Base (vacío)
- `environment.dev.ts` — Desarrollo/certificación
- `environment.prod.ts` — Producción

```typescript
export const environment = {
  production: false,
  API_PRESTAMO: 'https://api-cert.example.com/',
  API_SOLICITUD: 'https://api-solicitud-cert.example.com/',
  API_IDENTIDAD: '',
  API_MOTOR: '',
};
```

## Dependencias comunes

- **Angular Material** — Componentes UI (`@angular/material`, `@angular/cdk`)
- **Bootstrap** — Grid y utilidades CSS
- **ngx-toastr** — Notificaciones toast
- **RxJS** — Programación reactiva
- **moment** — Manejo de fechas
- **STOMP/SockJS** — WebSockets para notificaciones en tiempo real

## Componentes compartidos (`shared/`)

Convención: todo patrón que aparezca en **2+ vistas** vive en `@presentation/shared/` (o `@shared/` según convención del proyecto).

**Heurística de extracción:** al empezar una vista nueva, escanear `shared/` antes de codear. Si un patrón recurrente aún no está en `shared/`, proponer **extracción explícita con un diff aislado** — no mezclar con el feature nuevo (dos commits separados).

**Candidatos típicos:**

- `readonly-input` — input + candado + fondo atenuado.
- `section-card` — wrapper con section-title + icono + contenido.
- `switch-aligned` — switch con label alineado verticalmente.
- `combo-hint` — select + hint muted debajo.
- `primary-button-spinner` — botón de acción con estado de loading.

**Regla para el asistente:** al implementar un patrón del skill `frontend-design` en código, primero `grep`/`glob` por nombres similares en `shared/`; si existe, usar; si no, preguntar al usuario si vale extraerlo antes de inline-ar.

## Framework-first CSS

Aplicar el principio ~90/10 documentado en `frontend-design` (§11): utilities del framework primero, CSS custom sólo cuando el framework no da la variante o la combinación se repite 5+ veces y amerita una clase semántica.

En este monorepo: **SCSS + Bootstrap + Angular Material**. Regla práctica:

- **Spacing / flex / grid / tipografía / colores semánticos** → utilities Bootstrap (`p-3`, `d-flex align-items-center gap-2`, `text-muted small`, `fw-bold`, `text-danger`).
- **Componentes complejos** (autocomplete, datepicker, dialog) → Angular Material.
- **SCSS custom** reservado para **tema**: colores del sistema (en secciones específicas), dimensiones custom de switch (3em×1.5em), tema de readonly (fondo atenuado con candado).

**Anti-patrón:** reescribir `.my-card { border: 1px solid; padding: 1rem; box-shadow: ... }` cuando `border rounded-3 shadow-sm p-3` lo resuelve.

**Criterio práctico:** antes de escribir una regla CSS custom, revisar utilities del framework. Si no existe la utility, evaluar si el tema aplicará a 3+ lugares antes de crear clase.

## Build

- Producción: `npm run build:prod` → `ng build -c=production`
- Desarrollo: `npm run build:dev` → `ng build -c=development`
- Serve local: `npm run start:dev` → `ng serve -c=development`
- Tests: `ng test --watch=false`
- Estilos: SCSS
