# FE-BE Integration — reglas transversales

> Anchor: `agent-workflow:fe-be-integration`. Reglas canónicas para la integración Frontend ↔ Backend en proyectos agent-workflow a partir de qtc-dev v2.6 (session013) — actualizado en v2.7 (session015) para reflejar el modelo phased extendido Phase 0-5. Aplica a sesiones `flow=dev` con `## Type: feature|refactor` y a refactors guiados por el skill `agent-workflow:refactor`.
>
> Origen: session013-dev-flujo-feature-refactor-phased + session015-dev-aplicar-flujo-fases-extendido. Prior art: [JSON Merge Patch RFC 7396](https://datatracker.ietf.org/doc/html/rfc7396), [Walking Skeleton — Cockburn](https://codeclimate.com/blog/kickstart-your-next-project-with-a-walking-skeleton), [CQRS — Microsoft Learn](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs).

## Resumen ejecutivo

| Regla | Qué aplicar | Por qué |
|---|---|---|
| **R1 — Sparse DTO unificado** | Mismo DTO para create + edit, todos los campos nullable. `null` = "no tocar". | Reduce duplicación, hace explícita la intención del FE, simplifica el BE. |
| **R2 — PATCH para edit** | `@PatchMapping` en BE, `http.patch()` en FE. POST queda solo para create. | Semántica HTTP correcta. PATCH = mutación parcial; PUT = reemplazo total. |
| **R3 — FE envía solo cambios** | El FE construye el payload con campos modificados; el resto se omite o queda `null`. | Reduce payload, evita race conditions con campos no editados. |
| **R4 — Sin fallbacks que oculten errores** | Prohibido `catchError(() => of([]))` en FE. Prohibido `try/catch` que retorne mock en BE durante migraciones. | Los errores deben fallar ruidosamente para detectarse en cert antes de prod. |
| **R5 — Validación en BE con Bean Validation** | DTOs con `@NotNull`/`@Size`/etc. Errores → 400 estructurado con `field` y `message`. | El FE muestra el error sin lógica adicional. |
| **R6 — DB stub-first** | Funciones/SP nuevas arrancan en Phase 0 devolviendo mock. Implementación real en Phase 1/2. | Separación de cableado vs lógica; permite testear el contrato antes de comprometer SQL. |

## R1 — Sparse DTO unificado

### Patrón

Un único DTO `<Feature>SaveRequest` que sirve para POST (create) y PATCH (edit). Todos los campos son nullable. Convención:

- En **POST** (create): el FE envía todos los campos requeridos; los opcionales pueden venir `null`.
- En **PATCH** (edit): el FE envía solo los campos que cambian; el resto omitido o `null` significa "no tocar".

### Tradeoff aceptado

**No se puede setear un campo a `null` intencionalmente.** Si el dominio requiere "limpiar a null" un campo (ej. fecha de baja → null), modelarlo como:
- Endpoint dedicado (`POST /api/<feature>/{id}/limpiar-fecha-baja`) para semántica clara.
- O bien, campo separado `clearFechaBaja: boolean` en el DTO.

Esto es deliberado: optar por simplicidad sobre completitud (vs. JSON Patch RFC 6902 que sí permite operaciones explícitas pero añade complejidad).

### Ejemplo Java/Spring

```java
public record CategoriaSaveRequest(
    @Size(max = 100) String nombre,
    @Size(max = 500) String descripcion,
    Boolean activo,
    Integer ordenVisual
) {}

@RestController
@RequestMapping("/api/categorias")
@RequiredArgsConstructor
public class CategoriasController {

    private final CategoriasService service;

    @PostMapping
    public ResponseEntity<CategoriaResponse> create(
        @Valid @RequestBody CategoriaSaveRequest req
    ) {
        return ResponseEntity.ok(service.create(req));
    }

    @PatchMapping("/{id}")
    public ResponseEntity<CategoriaResponse> edit(
        @PathVariable Long id,
        @Valid @RequestBody CategoriaSaveRequest req
    ) {
        return ResponseEntity.ok(service.patch(id, req));
    }
}
```

En el service, el método `patch(id, req)` ignora campos `null` del request:

```java
@Transactional
public CategoriaResponse patch(Long id, CategoriaSaveRequest req) {
    Categoria entity = repo.findById(id).orElseThrow(NotFoundException::new);
    if (req.nombre() != null) entity.setNombre(req.nombre());
    if (req.descripcion() != null) entity.setDescripcion(req.descripcion());
    if (req.activo() != null) entity.setActivo(req.activo());
    if (req.ordenVisual() != null) entity.setOrdenVisual(req.ordenVisual());
    return mapper.toResponse(repo.save(entity));
}
```

### Ejemplo Angular/TypeScript

```typescript
export interface CategoriaSaveRequest {
  nombre?: string | null;
  descripcion?: string | null;
  activo?: boolean | null;
  ordenVisual?: number | null;
}

@Injectable({ providedIn: 'root' })
export class CategoriasApiService {
  private readonly base = `${environment.apiUrl}/api/categorias`;

  constructor(private http: HttpClient) {}

  create(req: CategoriaSaveRequest): Observable<CategoriaResponse> {
    return this.http.post<CategoriaResponse>(this.base, req);
  }

  edit(id: number, cambios: CategoriaSaveRequest): Observable<CategoriaResponse> {
    return this.http.patch<CategoriaResponse>(`${this.base}/${id}`, cambios);
  }
}
```

En el componente de edit, el FE construye el payload solo con cambios:

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

  this.api.edit(original.id, cambios).subscribe({
    next: (res) => this.toast.success('Guardado'),
    error: (err) => this.errorHandler.handle(err) // R4: no silenciar
  });
}
```

## R2 — PATCH para edit

| Verbo | Cuándo | DTO | Idempotente |
|---|---|---|---|
| `POST /api/<feature>` | Crear nueva entidad | `<Feature>SaveRequest` (todos los required cargados) | No |
| `GET /api/<feature>` y `GET /api/<feature>/{id}` | Listar / obtener | — | Sí |
| `PATCH /api/<feature>/{id}` | Editar parcial | `<Feature>SaveRequest` (solo campos cambiados) | No (orden importa si dos PATCHes pisan el mismo campo) |
| `DELETE /api/<feature>/{id}` | Eliminar | — | Sí |

**No usar `PUT`** salvo casos excepcionales (replace total con todos los campos). El default es PATCH.

## R3 — FE envía solo cambios

Reduce payload y evita pisar campos no editados. Implementación: FE compara `formValue` con `entidadOriginal` y arma diff. Ver ejemplo en R1.

**Anti-pattern**: enviar todo el formulario incluyendo campos no editados — equivale a PUT y rompe la semántica de PATCH sparse.

## R4 — Sin fallbacks que oculten errores

### Prohibido en FE

```typescript
// ❌ NO HACER: silencia errores HTTP
this.api.list().pipe(
  catchError(() => of([])) // <-- usuario nunca ve el error
).subscribe(items => this.items = items);
```

```typescript
// ✅ HACER: propagar al usuario via toast/handler
this.api.list().subscribe({
  next: (items) => this.items = items,
  error: (err) => this.errorHandler.handle(err)
});
```

### Prohibido en BE durante migraciones

```java
// ❌ NO HACER: fallback al método legacy oculta bugs
public List<Categoria> listar() {
    try {
        return nuevoListarConSparse();
    } catch (Exception e) {
        log.warn("Nuevo método falló, usando legacy", e);
        return legacyListar(); // <-- usuario nunca se entera
    }
}
```

```java
// ✅ HACER: dejar que el nuevo método falle ruidosamente
public List<Categoria> listar() {
    return nuevoListarConSparse();
}
```

Si necesitás rollout gradual, usá feature flag explícita:

```java
public List<Categoria> listar() {
    if (featureFlags.isEnabled("categorias-sparse-dto")) {
        return nuevoListarConSparse();
    }
    return legacyListar();
}
```

La feature flag es **explícita y observable** (vs. fallback silencioso).

## R5 — Validación en BE con Bean Validation

> **Phase 3 marker (v2.7+)**: Bean Validation se materializa en **Phase 3 — Validaciones / Correcciones**, no en Phase 2 — Escritura. Phase 2 produce endpoints funcionales que mutan estado pero pueden devolver 500 ante input malformado. Phase 3 agrega `@NotNull`/`@Size`/etc. + handler global 400 estructurado. Trade-off aceptado: temporalmente el código de Phase 2 no es robusto contra input malformado; el usuario debe ser consciente de no testear edge cases hasta cerrar Phase 3.

```java
public record CategoriaSaveRequest(
    @NotNull(message = "El nombre es obligatorio")
    @Size(min = 1, max = 100, message = "Entre 1 y 100 caracteres")
    String nombre,

    @Size(max = 500)
    String descripcion,

    @NotNull
    Boolean activo,

    @PositiveOrZero(message = "Debe ser ≥0")
    Integer ordenVisual
) {}
```

Handler global devuelve estructura uniforme:

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ValidationErrorResponse> onValidation(MethodArgumentNotValidException ex) {
        var fields = ex.getBindingResult().getFieldErrors().stream()
            .map(fe -> new FieldError(fe.getField(), fe.getDefaultMessage()))
            .toList();
        return ResponseEntity.badRequest().body(new ValidationErrorResponse(fields));
    }
}

public record ValidationErrorResponse(List<FieldError> errors) {}
public record FieldError(String field, String message) {}
```

El FE recibe 400 con estructura predecible y muestra los errores junto a cada campo.

**Limitación con Sparse DTO**: `@NotNull` en el DTO unificado **NO se valida en PATCH**, porque PATCH permite enviar campos `null`. Soluciones:

- **Validation groups**: `@NotNull(groups = OnCreate.class)` y aplicar grupo distinto en POST vs PATCH.
- **DTO separado solo para POST**: `<Feature>CreateRequest extends <Feature>SaveRequest` con campos requeridos no-null. Aceptable cuando el escenario lo justifica.

Documentar la decisión en DECISIONS.md de la sesión.

## R6 — DB stub-first

> **Flujo phased v2.7+**: Phase 0 mock → Phase 1 query real → Phase 3 validaciones de input/integridad referencial. El stub en Phase 0 permite probar el cableado e2e + routing sin comprometer SQL real.

En Phase 0 (contrato), funciones/SP nuevas devuelven mock:

```sql
-- Phase 0: stub
CREATE OR REPLACE FUNCTION fn_categorias_listar(
    p_filtro TEXT DEFAULT NULL,
    p_pagina INT DEFAULT 1,
    p_tamanio INT DEFAULT 20
) RETURNS JSONB AS $$
BEGIN
    -- TODO Phase 1: implementar query real con filtro y paginación
    RETURN '[]'::jsonb;
END;
$$ LANGUAGE plpgsql STABLE;
```

```sql
-- Phase 1: implementación real
CREATE OR REPLACE FUNCTION fn_categorias_listar(
    p_filtro TEXT DEFAULT NULL,
    p_pagina INT DEFAULT 1,
    p_tamanio INT DEFAULT 20
) RETURNS JSONB AS $$
WITH base AS (
    SELECT id, nombre, descripcion, activo, orden_visual
    FROM esq_admin.tb_categorias
    WHERE p_filtro IS NULL OR nombre ILIKE '%' || p_filtro || '%'
)
SELECT COALESCE(jsonb_agg(row_to_json(base)), '[]'::jsonb)
FROM base
ORDER BY orden_visual
OFFSET (p_pagina - 1) * p_tamanio
LIMIT p_tamanio;
$$ LANGUAGE sql STABLE;
```

Reglas de `agent-workflow:coding-standards/references/database-conventions.md` siguen aplicando (header de 4 líneas, idempotencia, schema explícito, BEGIN/COMMIT en scripts).

## Refs

- `agent-workflow:coding-standards/references/java-spring.md` — convenciones Spring Boot (Constructor Injection, @Transactional, records).
- `agent-workflow:coding-standards/references/angular-typescript.md` — convenciones Angular (HttpClient, ApiService, environments).
- `agent-workflow:coding-standards/references/database-conventions.md` — convenciones BD agent-workflow (schemas, naming, scripts).
- `agent-workflow:implement/SKILL.md` — phased mode (Phase 0/1/2 + gate M6 entre phases; S7 design-review antes de Phase 0 desde planning closure).
- `agent-workflow:refactor/SKILL.md` — Strangler Fig para refactors completos.
- `agent-workflow:prompts-catalog#M6,S7` — gates phased (S7 design-review antes de Phase 0; M6 entre phases). M9 retirado v2.8+.
- [JSON Merge Patch RFC 7396](https://datatracker.ietf.org/doc/html/rfc7396) — spec del comportamiento PATCH sparse (agent-workflow usa **convención simple sparse** en lugar del Content-Type RFC 7396, pero la semántica conceptual es idéntica salvo el caso "set to null intencional").
- [JSON Patch RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902) — alternativa con array de operaciones; descartada por complejidad.
