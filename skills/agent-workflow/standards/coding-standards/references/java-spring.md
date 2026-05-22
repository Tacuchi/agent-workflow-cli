# Java / Spring Boot — Convenciones detalladas

## Inyección de dependencias

Usar Constructor Injection. Nunca Field Injection en código de producción.

```java
// Correcto: Constructor Injection
@Service
@RequiredArgsConstructor
public class NotificacionService {
    private final EmailProvider emailProvider;
    private final NotificacionRepository repository;
}

// Incorrecto: Field Injection
@Service
public class NotificacionService {
    @Autowired  // NO en producción
    private EmailProvider emailProvider;
}
```

## DTOs con Java Records

Usar records para Request y Response. Clases tradicionales para entidades JPA.

```java
// Request DTO — record
public record NotificacionRequest(
    @NotBlank String destinatario,
    @NotBlank String asunto,
    @NotNull String templateId,
    Map<String, Object> variables
) {}

// Response DTO — record
public record NotificacionResponse(
    Long id,
    String destinatario,
    String estado,
    LocalDateTime fechaEnvio
) {}

// Entidad JPA — clase (NO record)
@Entity
@Table(name = "notificaciones")
public class Notificacion {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String destinatario;
    private String estado;
    // getters, setters
}
```

## Transacciones

```java
// Lectura — readOnly para optimización
@Transactional(readOnly = true)
public NotificacionResponse buscarPorId(Long id) { ... }

// Escritura
@Transactional
public NotificacionResponse enviar(NotificacionRequest request) { ... }
```

## Validación con Jakarta

```java
@PostMapping("/notificaciones")
public ResponseEntity<NotificacionResponse> enviar(
        @Valid @RequestBody NotificacionRequest request) {
    return ResponseEntity.ok(service.enviar(request));
}
```

## PATCH + Sparse DTO unificado (qtc-dev v2.6+)

Para mantenimientos CRUD seguir las reglas de `references/fe-be-integration.md`:

- **DTO único** `<Feature>SaveRequest` para POST y PATCH, todos los campos nullable.
- **POST** acepta el DTO con required cargados; **PATCH** acepta el DTO con solo los campos modificados (null = no tocar).
- Validation groups (`OnCreate.class`) cuando se necesita exigir `@NotNull` solo en POST.

```java
public record CategoriaSaveRequest(
    @Size(min = 1, max = 100)
    @NotNull(groups = OnCreate.class)
    String nombre,
    @Size(max = 500) String descripcion,
    @NotNull(groups = OnCreate.class) Boolean activo,
    @PositiveOrZero Integer ordenVisual
) {}

@RestController
@RequestMapping("/api/categorias")
@RequiredArgsConstructor
public class CategoriasController {
    private final CategoriasService service;

    @PostMapping
    public ResponseEntity<CategoriaResponse> create(
        @Validated(OnCreate.class) @RequestBody CategoriaSaveRequest req
    ) { return ResponseEntity.ok(service.create(req)); }

    @PatchMapping("/{id}")
    public ResponseEntity<CategoriaResponse> patch(
        @PathVariable Long id,
        @Valid @RequestBody CategoriaSaveRequest req
    ) { return ResponseEntity.ok(service.patch(id, req)); }
}
```

En el service, el método `patch` ignora campos `null`:

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

Tradeoff aceptado: no se puede setear un campo a `null` intencionalmente (semántica "no tocar"). Para "limpiar a null", usar endpoint dedicado o flag explícita en el DTO. Detalles + ejemplos completos: `references/fe-be-integration.md`.

## Fail fast / Early returns

```java
public NotificacionResponse enviar(NotificacionRequest request) {
    if (request.destinatario().isBlank()) {
        throw new BadRequestException("Destinatario requerido");
    }

    var template = templateRepository.findById(request.templateId())
        .orElseThrow(() -> new NotFoundException("Template no encontrado"));

    // Lógica principal después de validaciones
    return procesarEnvio(request, template);
}
```

## Manejo de errores

```java
@RestControllerAdvice
public class ControllerExceptionHandler {

    @ExceptionHandler(BadRequestException.class)
    public ResponseEntity<ErrorResponse> handleBadRequest(BadRequestException ex) {
        log.warn("Bad request: {}", ex.getMessage());
        return ResponseEntity.badRequest()
            .body(new ErrorResponse(ex.getMessage()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleGeneral(Exception ex) {
        log.error("Error inesperado", ex);
        return ResponseEntity.internalServerError()
            .body(new ErrorResponse("Error interno del servidor"));
    }
}
```

## Estructura de proyecto

Ver `references/project-structure.md` para la estructura completa de paquetes, entidades, repositories, services, wrappers request/response y convención de DTOs del tu ecosistema.

## Queries SQL

- Siempre parametrizar (nunca concatenar strings)
- Usar `@Query` con parámetros nombrados o JPA Criteria
- En native queries, siempre schema explícito: `esq_xxx.tb_xxx`
- Documentar queries complejas en CONSULTASSQL.md de la sesión

```java
// Correcto
@Query("SELECT n FROM Notificacion n WHERE n.destinatario = :email")
List<Notificacion> findByDestinatario(@Param("email") String email);

// Incorrecto — SQL injection
@Query("SELECT n FROM Notificacion n WHERE n.destinatario = '" + email + "'")
```

Ver `references/database-conventions.md` para nomenclatura de tablas, columnas, sequences, funciones y el patrón maestra-detalle.

## Build y verificación

- Compilar: `./mvnw compile` (Windows: `mvnw.cmd compile`)
- Tests: `./mvnw test`
- Verificación completa: `./mvnw verify`
- Nunca usar `mvn` directo — siempre el wrapper del proyecto

## Patrones de sincronización single-slot

Patrones al sincronizar relaciones donde la BD admite N filas pero la UX expone 1 seleccionada. Para la decisión de diseño UX (por qué single-slot), ver skill `frontend-design` (§1).

### Reemplazo preservando fila coincidente

Al guardar con single-slot, **no** "borrar todo e insertar uno" (genera churn en auditoría y consume secuencias innecesariamente). Recorrer las filas existentes, preservar la que coincide con el valor nuevo y eliminar las demás:

```java
List<EntidadRelacion> existentes = repository.findByIdMaestro(maestro.getIdMaestro());
boolean coincide = false;
for (EntidadRelacion e : existentes) {
    if (!coincide && idValorNuevo.equals(e.getIdValor())) {
        coincide = true;                 // preservar UNA fila que coincide
    } else {
        repository.delete(e);            // eliminar sobrantes o cambios
    }
}
if (!coincide) {
    // crear fila nueva con estado=1, fecha_registro, usuario_registro
}
```

### Fallback cross-tabla en GET con autoritativa única

Cuando un campo vive en dos tablas por historia (p. ej. `usuario.celular` y `cliente.celular`), declarar **una tabla autoritativa** y aplicar fallback silencioso a la otra **sólo en el GET**. El UPDATE toca únicamente la autoritativa:

```java
if (dto.getCelular() == null || dto.getCelular().isBlank()) {
    clienteRepository.findByIdPersona(entidad.getIdPersona())
        .ifPresent(c -> dto.setCelular(c.getCelular()));
}
```

Regla: no replicar esta lógica en el frontend; la resolución vive en el GET del backend. Evitar asumir que un campo "personal" vive en la tabla de personas sin verificar — a veces la autoritativa es la tabla de negocio.

### Filtros `estado=1` en query, no en frontend

Queries de catálogo (roles asignables, negocios, sucursales, etc.) filtran activos en la query nativa / JPA. El frontend recibe sólo activos y **no debe re-filtrar**:

```java
@Query("SELECT r FROM Rol r WHERE r.estado = 1 ORDER BY r.nombre")
List<Rol> findAsignables();
```

Si el frontend termina filtrando de nuevo, es indicio de que la query está mal — corregir la query, no el frontend.
