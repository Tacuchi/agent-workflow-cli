# Niveles de test — Referencia completa

## Backend (Spring Boot / Java)

### Nivel a) Unitarios — Ejemplo completo

```java
@ExtendWith(MockitoExtension.class)
class NotificacionServiceTest {

    @Mock
    private EmailProvider emailProvider;

    @Mock
    private NotificacionRepository repository;

    private NotificacionService service;

    @BeforeEach
    void setUp() {
        // Constructor Injection (mismo patrón que producción)
        service = new NotificacionService(emailProvider, repository);
    }

    @Test
    void enviar_conEmailValido_retornaExito() {
        // Arrange — record como DTO
        var request = new NotificacionRequest("user@example.com", "Aprobación", "aprobacion", Map.of());
        when(emailProvider.send(any())).thenReturn(true);

        // Act
        var resultado = service.enviar(request);

        // Assert
        assertThat(resultado).isTrue();
        verify(emailProvider).send(any());
    }

    @Test
    void enviar_sinDestinatario_lanzaBadRequest() {
        var request = new NotificacionRequest(null, "Asunto", "template", Map.of());

        assertThatThrownBy(() -> service.enviar(request))
            .isInstanceOf(BadRequestException.class)
            .hasMessageContaining("destinatario");
    }

    @Test
    void enviar_proveedorFalla_registraError() {
        var request = new NotificacionRequest("user@example.com", "Asunto", "template", Map.of());
        when(emailProvider.send(any())).thenThrow(new RuntimeException("SMTP error"));

        var resultado = service.enviar(request);

        assertThat(resultado).isFalse();
        verify(repository).guardarLog(any());
    }
}
```

Ejecutar con: `./mvnw test -Dtest=NotificacionServiceTest` (Windows: `mvnw.cmd test`)

### Nivel b) Unitarios + API — Ejemplo MockMvc

```java
@WebMvcTest(NotificacionController.class)
class NotificacionControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private NotificacionService service;

    @Test
    void enviar_conDatosValidos_retorna200() throws Exception {
        when(service.enviar(any())).thenReturn(true);

        // Request body usa record NotificacionRequest
        mockMvc.perform(post("/api/v1/notificaciones/enviar")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"destinatario\":\"user@example.com\",\"asunto\":\"Test\",\"templateId\":\"aprobacion\"}"))
            .andExpect(status().isOk());
    }

    @Test
    void enviar_sinBody_retorna400() throws Exception {
        mockMvc.perform(post("/api/v1/notificaciones/enviar")
                .contentType(MediaType.APPLICATION_JSON))
            .andExpect(status().isBadRequest());
    }
}
```

Ejecutar con: `./mvnw test`

### Nivel c) Completo — Ejemplo @SpringBootTest

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc
@Transactional
class NotificacionIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private NotificacionRepository repository;

    @Test
    void flujoCompleto_enviarYRegistrar_persisteLog() throws Exception {
        mockMvc.perform(post("/api/v1/notificaciones/enviar")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"destinatario\":\"user@example.com\",\"asunto\":\"Test\"}"))
            .andExpect(status().isOk());

        var logs = repository.findByDestinatario("user@example.com");
        assertThat(logs).isNotEmpty();
    }
}
```

Ejecutar con: `./mvnw verify`

## Frontend (Angular)

### Nivel a) Unitarios — Service aislado

```typescript
describe('AuthService', () => {
  let service: AuthService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [AuthService]
    });
    service = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('should return token on login', () => {
    service.login('admin', 'pass').subscribe(res => {
      expect(res.token).toBeTruthy();
    });

    const req = httpMock.expectOne('/api/auth/login');
    req.flush({ token: 'abc123' });
  });

  it('should handle login error', () => {
    service.login('bad', 'creds').subscribe({
      error: err => expect(err.status).toBe(401)
    });

    const req = httpMock.expectOne('/api/auth/login');
    req.flush('Unauthorized', { status: 401, statusText: 'Unauthorized' });
  });
});
```

Ejecutar con: `ng test --watch=false`

### Nivel b) Unitarios + Componentes — TestBed

```typescript
describe('FiltrosComponent', () => {
  let component: FiltrosComponent;
  let fixture: ComponentFixture<FiltrosComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FiltrosComponent, NoopAnimationsModule]
    }).compileComponents();
    fixture = TestBed.createComponent(FiltrosComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should render date inputs', () => {
    const compiled = fixture.nativeElement;
    expect(compiled.querySelector('input[type="date"]')).toBeTruthy();
  });

  it('should emit on filter apply', () => {
    spyOn(component.filtroChanged, 'emit');
    component.filtroForm.patchValue({ estado: 'ACTIVO' });
    component.aplicarFiltro();
    expect(component.filtroChanged.emit).toHaveBeenCalledWith(
      jasmine.objectContaining({ estado: 'ACTIVO' })
    );
  });
});
```

## TestBuilder — Patrón (Java)

```java
public class NotificacionTestBuilder {
    private Long id = 1L;
    private String destinatario = "test@example.com";
    private String asunto = "Test";
    private String estado = "PENDIENTE";
    private LocalDateTime fechaCreacion = LocalDateTime.now();

    public static NotificacionTestBuilder builder() {
        return new NotificacionTestBuilder();
    }

    public NotificacionTestBuilder destinatario(String val) {
        this.destinatario = val;
        return this;
    }

    public NotificacionTestBuilder estado(String val) {
        this.estado = val;
        return this;
    }

    public Notificacion build() {
        var entity = new Notificacion();
        entity.setId(id);
        entity.setDestinatario(destinatario);
        entity.setAsunto(asunto);
        entity.setEstado(estado);
        entity.setFechaCreacion(fechaCreacion);
        return entity;
    }
}
```

## Resumen de comandos por stack

### Spring Boot (Maven wrapper)
- Nivel a: `./mvnw test -Dtest=ClaseTest`
- Nivel b: `./mvnw test`
- Nivel c: `./mvnw verify`
- Windows: usar `mvnw.cmd` en lugar de `./mvnw`

### Angular
- Nivel a/b: `ng test --watch=false`
- Nivel c: `npm run e2e` (si configurado)

### Gradle
- Nivel a: `./gradlew test --tests ClaseTest`
- Nivel b: `./gradlew test`
- Nivel c: `./gradlew integrationTest` (o `check`)
