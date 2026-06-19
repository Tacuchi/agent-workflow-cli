---
name: testing
description: >
  Estrategia y ejecución de pruebas: selecciona niveles (unit / integration / e2e),
  resuelve comandos por stack detectado, guía la convención de nombres y estructura de tests.
  Pregunta al humano antes de ejecutar; nunca lanza el test runner sin confirmación explícita.
  Compuesta por plan-exec-loop y quick-loop durante la fase de validación de cambios.
---

# testing — Test strategy and execution capability

## Role

`testing` — implementación built-in por defecto. Rebindeable a otra skill (de tercero o `off`) en `.workflow/skills.toml`.

## Purpose

Dar a los loops la capacidad de razonar sobre tests: qué nivel aplicar, con qué comando, con qué convención. **No ejecuta tests de forma autónoma** — primero pregunta al humano si quiere que el loop los corra, o si los correrá manualmente, o si no hacen falta en esta sesión.

## Composed by

| Loop | Cuándo la compone |
|---|---|
| `plan-exec-loop` | durante validation de cada task ejecutada |
| `quick-loop` | cuando el cambio quick requiere verificación |

## Knowledge

### Execution rule

Por defecto, **no ejecutar pruebas automáticamente**. Antes de correr cualquier test runner:

```
AskUserQuestion:
  "¿Correr los tests?"
  [a] Sí, el loop los ejecuta
  [b] Los corro yo manualmente
  [c] No hace falta en esta sesión
```

Solo saltear la pregunta si el workspace declara `Validation mode: auto` en `.workflow/config.toml`.

### Test levels

Tres niveles universales (adaptados al stack detectado):

| Nivel | Alcance | Cuándo usarlo |
|---|---|---|
| **a) Unit** | Lógica aislada (servicios, utils, mappers) | Fix puntual, lógica sin dependencias externas |
| **b) Integration** | Unit + capa de API/controladores | Endpoint nuevo o modificado |
| **c) Full** | Integration + contexto completo + e2e | Feature completa, flujo crítico, integración entre capas |

### Stack resolution

El stack se detecta por archivos de manifest presentes en el workspace. Precedencia: si el bloque `WORKSPACE → Stack` declara override de build/wrapper, usarlo.

#### Spring Boot (Maven)

| Nivel | Framework | Comando |
|---|---|---|
| a) Unit | JUnit 5 + Mockito | `./mvnw test -Dtest=ClaseTest` |
| b) Integration | + MockMvc | `./mvnw test` |
| c) Full | + @SpringBootTest | `./mvnw verify` |

> Windows: `mvnw.cmd` en lugar de `./mvnw`.

#### Spring Boot (Gradle)

| Nivel | Comando |
|---|---|
| a) Unit | `./gradlew test --tests ClaseTest` |
| b) Integration | `./gradlew test` |
| c) Full | `./gradlew integrationTest` (o `check`) |

#### Angular

| Nivel | Framework | Comando |
|---|---|---|
| a) Unit | Jasmine + Karma (o Jest) | `ng test --watch=false` |
| b) Integration | + TestBed + ComponentFixture | `ng test --watch=false` |
| c) Full | + Cypress/Playwright si configurado | `npm run e2e` |

#### Node / TypeScript genérico

| Nivel | Comando |
|---|---|
| a) Unit | `npm test` (script `test` en `package.json`) |
| b) Integration | `npm test` con suites de integración |
| c) Full | `npm run test:e2e` o según config |

#### Resolución automática

1. `mvnw` / `mvnw.cmd` → Maven wrapper.
2. `gradlew` → Gradle wrapper.
3. `angular.json` → `ng test`.
4. `package.json` con script `test` → `npm test`.
5. Si hay override en `WORKSPACE → Stack` → usarlo.

### Naming conventions

**Java:** clase `[Objetivo]Test.java`, método `[metodo]_[escenario]_[resultado]`. Estructura Arrange-Act-Assert.

```java
@Test
void enviar_conEmailValido_retornaExito() {
    // Arrange
    var request = new NotificacionRequest("user@example.com", "Asunto", "template", Map.of());
    when(emailProvider.send(any())).thenReturn(true);
    // Act
    var resultado = service.enviar(request);
    // Assert
    assertThat(resultado).isTrue();
}
```

**Angular / TypeScript:** archivo `[nombre].spec.ts`, bloques `describe` / `it`. Usar `TestBed` para componentes.

```typescript
describe('AuthService', () => {
  it('should return token on login', () => {
    // ...
  });
});
```

### Level selection prompt (to show the human)

Adaptar al stack resuelto. Ejemplo para Spring Boot:

```
¿Qué nivel de pruebas aplicamos?
  a) Unitarios       — JUnit 5 + Mockito (rápido, aislado)
  b) Integración     — + MockMvc controllers
  c) Completo        — + @SpringBootTest (contexto Spring completo)
```

El humano puede cambiar de nivel en cualquier momento o decidir no ejecutar desde el loop.

### Execution and logging

1. Confirmar que el humano quiere ejecución desde el loop (ver "Execution rule").
2. Ejecutar el comando resuelto según stack y nivel.
3. Registrar resultado en `TEST_LOG.md` **solo si** el humano pidió registro formal o la ejecución fue desde el loop.
4. Si el humano ya validó manualmente, no repetir; anotar una línea breve si aporta trazabilidad.
5. Si hay fallos y el humano quiere continuar: corregir y re-ejecutar.

### TestBuilder pattern (Java)

Para construir fixtures reutilizables sin acoplar los tests al constructor de producción:

```java
public class NotificacionTestBuilder {
    private String destinatario = "test@example.com";
    private String estado = "PENDIENTE";

    public static NotificacionTestBuilder builder() { return new NotificacionTestBuilder(); }

    public NotificacionTestBuilder destinatario(String val) { this.destinatario = val; return this; }
    public NotificacionTestBuilder estado(String val) { this.estado = val; return this; }

    public Notificacion build() {
        var e = new Notificacion();
        e.setDestinatario(destinatario);
        e.setEstado(estado);
        return e;
    }
}
```

## Output

No produce artefactos de forma autónoma. Cuando el humano confirma ejecución:
- Corre el comando resuelto y reporta el resultado inline.
- Escribe `TEST_LOG.md` en la sesión activa solo si fue pedido explícitamente.

No gradua a `docs/` (invariant #1).

## Source

Reciclado de `agent-workflow/standards/testing-strategy/` del bundle viejo (v0.1.0). Se conserva: los tres niveles (a/b/c), la regla de confirmación antes de ejecutar, la resolución de stack por manifest, los naming conventions, la tabla de comandos por framework. Se descarta: la referencia al bloque `AW-PROJECT → Stack` (reemplazado por `WORKSPACE → Stack`), el `TEST_LOG.md` obligatorio, el sandbox-readonly-rules legacy, referencias a `plan mode` del sistema anterior.
