---
name: testing-strategy
description: Skill de referencia para la estrategia de testing (selección de niveles unit/integración/e2e, comandos de ejecución por stack). Invocado internamente por el skill session durante la Fase 4 (validación). No se activa por lenguaje natural.
version: 0.1.0
---

# Testing Strategy

Gestión de niveles de prueba flexibles dentro de sesiones de desarrollo. El usuario elige el nivel en cualquier momento y puede cambiarlo durante la sesión. Los niveles se adaptan al stack detectado del proyecto.

## Regla de ejecución

Por defecto, no ejecutar pruebas automáticamente. Primero preguntar si:
- el usuario quiere que el plugin las ejecute
- el usuario las correrá manualmente
- no hace falta correrlas en esta sesión

(Salvo `Validation mode: auto` en `~/.workflow/user-config.md`.)

## Niveles de prueba — Backend (Spring Boot / Java)

### Nivel a) Unitarios
- **Framework:** JUnit 5 + Mockito
- **Alcance:** Lógica de negocio aislada (services, utils, mappers)
- **Cuándo usarlo:** Fix rápido, cambio puntual, lógica sin dependencias externas
- **Comando:** `./mvnw test -Dtest=ClaseTest` (Windows: `mvnw.cmd test`)

### Nivel b) Unitarios + API
- **Framework:** JUnit 5 + Mockito + MockMvc
- **Alcance:** Nivel a) + Controllers (endpoints REST)
- **Cuándo usarlo:** Endpoint nuevo o modificado
- **Comando:** `./mvnw test`

### Nivel c) Completo
- **Framework:** JUnit 5 + Mockito + MockMvc + @SpringBootTest
- **Alcance:** Nivel b) + Tests de integración con contexto Spring completo
- **Cuándo usarlo:** Feature completa, flujo crítico, integración entre capas
- **Comando:** `./mvnw verify`

## Niveles de prueba — Frontend (Angular)

### Nivel a) Unitarios
- **Framework:** Jasmine + Karma (o Jest según config)
- **Alcance:** Services, pipes, utils aislados
- **Comando:** `ng test --watch=false`

### Nivel b) Unitarios + Componentes
- **Framework:** Jasmine + TestBed + ComponentFixture
- **Alcance:** Nivel a) + componentes con template rendering
- **Comando:** `ng test --watch=false`

### Nivel c) Completo
- **Framework:** Nivel b) + tests e2e (Cypress/Playwright si está configurado)
- **Alcance:** Flujos completos de usuario
- **Comando:** `npm run e2e` o según configuración del proyecto

## Selección de nivel

Preguntar al usuario solo cuando realmente se vaya a validar desde el plugin. Adaptar las opciones al stack:

**Backend:**
```
¿Qué nivel de pruebas aplicamos?
  a) Unitarios — JUnit 5 + Mockito (rápido)
  b) Unitarios + API — + MockMvc controllers
  c) Completo — + @SpringBootTest integración
```

**Frontend:**
```
¿Qué nivel de pruebas aplicamos?
  a) Unitarios — Services y pipes aislados
  b) Unitarios + Componentes — + TestBed rendering
  c) Completo — + e2e si está configurado
```

El usuario puede cambiar de nivel en cualquier momento o decidir no ejecutar pruebas desde el plugin.

## Convenciones de nomenclatura

**Java:** Clase `[Objetivo]Test.java`, método `[metodo]_[escenario]_[resultado]`. Estructura Arrange-Act-Assert.
**Angular:** Archivo `[nombre].spec.ts`, bloques `describe`/`it`. Usar TestBed para componentes.

Para ejemplos completos de código, consultar `references/test-levels.md`.

## Ejecución y registro

1. Confirmar primero que el usuario quiere ejecución desde el plugin
2. Ejecutar el comando según stack y nivel
3. Registrar en `TEST_LOG.md` solo si el usuario pidió registro formal o la ejecución se hizo desde el plugin
4. Si el usuario ya validó manualmente, no repetir por defecto; anotar una línea breve solo si aporta trazabilidad
5. Si hay fallos y el usuario quiere continuar, corregir y re-ejecutar

## Detección automática de comando

1. `mvnw`/`mvnw.cmd` → `./mvnw test` (nunca `mvn` directo)
2. `gradlew` → `./gradlew test`
3. `angular.json` → `ng test --watch=false`
4. `package.json` con script test → `npm test`
5. Si el bloque `AW-PROJECT → Stack` declara un override de build o wrapper distinto, usarlo.

## Sandbox read-only

Canon universal en `../session/references/sandbox-readonly-rules.md`. Esta skill es read-only por diseño — selecciona niveles de test y resuelve comandos por stack, no ejecuta tests ni edita código fuente.

En plan mode: describir en el plan file qué niveles aplicarían (unit / integración / e2e), el comando resuelto (`./mvnw test`, `ng test --watch=false`, `npm test`, etc.) y los refs de ejemplos por stack. NO ejecuta `Bash` con el test runner, NO escribe TEST_LOG.md ni código de tests por sí misma.

Compatible con plan mode sin restricciones adicionales.

## Recursos adicionales

### Archivos de referencia
- **`references/test-levels.md`** — Ejemplos completos de código por stack y nivel, patrones TestBuilder, resumen de comandos
