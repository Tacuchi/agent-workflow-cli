# Test runner output corpus

Extractos normalizados de los formatos de consola de los ejecutores, sin colores.
Las rutas, tiempos, nombres de ejemplo y datos de máquina se normalizaron; no son
pruebas de ejecución de los proyectos de origen ni logs completos de este host.
Los tests consumen los archivos de forma independiente del catálogo de patrones.

## Sources

- Vitest 2.1.9: `packages/vitest/src/node/reporters/base.ts` (`printTaskErrors`,
  `reportTestSummary`) y salida local de esta suite.
  https://github.com/vitest-dev/vitest/blob/v2.1.9/packages/vitest/src/node/reporters/base.ts
- Jest 29.7: snapshots de `SummaryReporter`, formato de `DefaultReporter` y
  diagnóstico `Test suite failed to run`.
  https://github.com/jestjs/jest/blob/v29.7.0/packages/jest-reporters/src/__tests__/__snapshots__/SummaryReporter.test.js.snap
- Karma 6.4.4: `server.js` (literal `Found N load error[s]`),
  `reporters/progress.js` y `reporters/base.js` (progreso por navegador).
  https://github.com/karma-runner/karma/blob/v6.4.4/lib/server.js
  https://github.com/karma-runner/karma/blob/v6.4.4/lib/reporters/progress.js
- pytest 8.3.4: `terminal.py`, `report_collect` y `summary_stats`; modo normal y quiet.
  https://github.com/pytest-dev/pytest/blob/8.3.4/src/_pytest/terminal.py
- Maven Surefire: consola y resumen de errores del plugin.
  https://maven.apache.org/surefire/maven-surefire-plugin/examples/logging.html
  https://maven.apache.org/surefire/maven-surefire-plugin/examples/newerrorsummary.html
- Gradle: tareas Java y salida de `Test`. `NO-SOURCE` sólo es evidencia de cero
  pruebas en las tareas de ejecución reconocidas, nunca en `compileTestJava` ni
  `processTestResources`.
  https://docs.gradle.org/current/userguide/java_testing.html
  https://docs.gradle.org/current/userguide/java_plugin.html#sec:java_tasks
