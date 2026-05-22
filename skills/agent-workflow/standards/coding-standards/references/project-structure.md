# Estructura de Proyecto Backend

Convenciones de estructura para microservicios Spring Boot del tu ecosistema.

## Paquete base

`com.qtc.[dominio]` → `com.qtc.credito`, `com.qtc.mantenimiento`, `com.qtc.solicitud`

## Estructura de paquetes

Dos variantes en uso (ambas válidas, seguir la del proyecto actual):

```
com.qtc.[dominio].core.controller
com.qtc.[dominio].core.service
com.qtc.[dominio].core.service.impl
com.qtc.[dominio].core.service.generico
com.qtc.[dominio].core.repository
com.qtc.[dominio].core.model
com.qtc.[dominio].core.request
com.qtc.[dominio].core.request.dto
com.qtc.[dominio].core.response
com.qtc.[dominio].core.response.dto
com.qtc.[dominio].core.config
com.qtc.[dominio].core.exception
com.qtc.[dominio].core.common
com.qtc.[dominio].core.util
com.qtc.[dominio].core.feign
com.qtc.[dominio].core.seguridad
com.qtc.[dominio].core.aspect
com.qtc.[dominio].core.advice
```

Variante sin `core`:
```
com.qtc.[dominio].controller
com.qtc.[dominio].service / service.impl
com.qtc.[dominio].repository
com.qtc.[dominio].model
com.qtc.[dominio].dto.request / dto.response
```

## Flujo de capas

```
Controller → Service (interface) → ServiceImpl → Repository → Entity/BD
```

## Entidades JPA

Nombre = tabla sin `tb_` en PascalCase: `tb_credito` → `Credito`, `tb_cliente` → `Cliente`

```java
@Entity
@NoArgsConstructor
@AllArgsConstructor
@Table(name = "tb_credito", schema = "esq_credito")
@Getter
@Setter
public class Credito extends Auditoria implements Serializable {

    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "seq_tb_credito")
    @SequenceGenerator(name = "seq_tb_credito", sequenceName = "seq_tb_credito",
            schema = "esq_credito", allocationSize = 1)
    @Column(name = "id_credito")
    private Long idCredito;
}
```

Reglas:
- Siempre `schema` explícito en `@Table` y `@SequenceGenerator`
- Extender `Auditoria` para campos de auditoría
- `@Getter @Setter` (no `@Data`) en entities
- `@Column(name = "...")` con el nombre exacto de la columna en BD
- Stored procedures: `@NamedStoredProcedureQuery` en la entidad que las invoca

## Clase base Auditoria

`@MappedSuperclass` que provee 5 campos estándar:

```java
@MappedSuperclass
@Data
public abstract class Auditoria {
    @Column(nullable = false, name = "ESTADO")
    protected Integer estado;

    @Column(nullable = false, updatable = false, name = "USUARIO_REGISTRO")
    protected String usuarioRegistro;

    @Column(nullable = false, updatable = false, name = "FECHA_REGISTRO")
    protected Date fechaRegistro;

    @Column(insertable = false, name = "USUARIO_MODIFICACION")
    protected String usuarioModificacion;

    @Column(insertable = false, name = "FECHA_MODIFICACION")
    protected Date fechaModificacion;
}
```

Al insertar: llamar `setCampoSegIns(usuario, fecha)`.
Al actualizar: llamar `setCampoSegUpd(estado, usuario, fecha)`.

## Repositories

```java
@Repository
public interface CreditoRepository extends JpaRepository<Credito, Long> {

    // JPQL
    @Query("SELECT c FROM Credito c WHERE c.solicitud.idSolicitud = :id")
    List<Credito> obtenerPorSolicitud(@Param("id") Long id);

    // Native query con schema explícito
    @Query(value = "SELECT ... FROM esq_credito.tb_credito c "
            + "INNER JOIN esq_seguridad.tb_persona p ON ...",
            nativeQuery = true)
    List<PCreditoDTO> obtenerPorDocumento(@Param("doc") String doc);

    // Stored procedure
    @Procedure(name = "credito.generaCredito")
    Integer generaCredito(@Param("var_usuario") String usuario);
}
```

Native queries siempre con `esq_xxx.tb_xxx` (schema explícito).

## Services

```java
// Interface
public interface CreditoService {
    RespBase<ResponseDTO> generaCredito(ReqBase<ReqCredito> request, String usuario);
}

// Implementación
@AllArgsConstructor
@Service
public class CreditoServiceImpl implements CreditoService {
    private static final Logger LOGGER = LoggerFactory.getLogger(CreditoServiceImpl.class);
    private final CreditoRepository creditoRepository;
    private final ClienteRepository clienteRepository;

    @Transactional
    @Override
    public RespBase<ResponseDTO> generaCredito(ReqBase<ReqCredito> request, String usuario) {
        // ...
    }
}
```

Reglas:
- Constructor injection vía `@AllArgsConstructor` (no `@Autowired`)
- `@Transactional` en métodos de escritura
- Logger SLF4J estático por clase
- Siempre interface + impl

## Wrappers Request/Response

### Request
```java
public class ReqBase<T> {
    private Trace trace;       // traceId para trazabilidad
    @NotNull @Valid
    private T payload;
}
```

### Response
```java
public class RespBase<T> {
    private Trace trace;
    private Status status;     // success + error (code, httpCode, messages)
    private T payload;
}
```

Uso: `return new RespBase<ResponseDTO>().ok(payload);`
Error: `return new RespBase<>().error(response, false, "mensaje");`

## Convención de DTOs

- **`Req` prefix** → Request DTOs: `ReqCredito`, `ReqSituacion` (clases con `@Data`)
- **`P` prefix** → Projection interfaces para native queries: `PCreditoDTO`, `PClienteDTO`
- **`R` prefix** → Response DTOs mapeados: `RCreditoDTO`, `RCronogramaDTO` (clases con mapper)
- **`ResponseDTO`** → DTO genérico con id, data y mensaje

## Comunicación entre microservicios

- Feign clients en paquete `feign`
- Paquete `seguridad` para interceptors de autenticación

## Build

Maven wrapper: `./mvnw` (Linux) o `mvnw.cmd` (Windows). Nunca `mvn` global.
