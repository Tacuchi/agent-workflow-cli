# Rollback global de release y por tema

Algoritmos detallados para rollbacks consolidados en modo release. El SKILL.md tiene el resumen; este archivo tiene el procedimiento completo paso a paso.

## Rollback global de release (cross-session)

`docs/release/NNN-release-YYYY-MM-DD/scripts/rollback/00-rollback-release.sql` revierte el release completo.

### Principio

Revertir en **orden inverso absoluto**:
- Sesiones: última → primera (session_N → … → session_1).
- Dentro de cada sesión: 04 → 03 → 02 → 01 (contrario al de ejecución).

### Proceso

1. Recolectar todos los `.rollback.sql` del bundle consolidado.
2. Ordenar inversamente: primero todos los rollbacks de la sesión más reciente (04→01), luego la anterior, etc.
3. Encadenar en un único archivo:

```sql
-- Rollback global del Release NNN (YYYY-MM-DD)
-- Cubre N sesiones desde sessionXXX hasta sessionYYY
BEGIN;

-- sessionYYY-nombre (última)
-- 04-inserts
[contenido en orden inverso]
-- 03-migracion
[contenido en orden inverso]
-- 02-ddl-funciones
[contenido en orden inverso]
-- 01-ddl-tablas
[contenido en orden inverso]

-- sessionXXX-nombre-previo
[misma estructura]

COMMIT;
```

4. Preservar marcas `-- WARNING: IRREVERSIBLE` con contexto (sesión origen).
5. Listar irreversibles al inicio antes del `BEGIN;`:

```sql
-- ADVERTENCIA: Este release contiene [N] operaciones irreversibles:
-- - sessionXXX / 03-migracion/001-*.sql — DROP COLUMN (mitigación: esq_audit.tb_bkp_*_sessionXXX)
-- - sessionYYY / 01-ddl-tablas/002-*.sql — DROP TABLE CASCADE (mitigación: sin respaldo)
-- Revisar docs/release/NNN-informe-release.md sección 4.2 antes de ejecutar.
```

### Qué NO hacer

- Fusionar rollbacks de distintas sesiones sobre la misma tabla — dejar cada bloque independiente.
- Cambiar el orden inverso — puede dejar referencias colgando.
- Ejecutar el rollback desde el plugin. Siempre manual por el usuario.

### Verificación mínima

- Orden inverso absoluto respetado (sesiones descendente, categorías 04→01).
- Operaciones irreversibles listadas al inicio.
- Archivo abre con `BEGIN;` y cierra con `COMMIT;`.
- Cada bloque de sesión delimitado con `-- === sessionXXX ===`.
- Headers de respaldo preservados donde aplica.

## Rollback por tema (delegado por release-scripts)

Tres niveles:

1. **Consolidado por categoría**: `tema-<slug>/<categoria>.rollback.sql` concatena rollbacks de scripts fuente en orden inverso, envuelto en `BEGIN; … COMMIT;`.
2. **Por-tema**: `tema-<slug>/rollback-tema-<slug>.sql` encadena los 4 consolidados (04→03→02→01).
3. **Global del release**: `rollback/00-rollback-release.sql` encadena rollbacks por-tema en orden inverso a `ORDER.md`.

### Generación del consolidado por categoría

1. Recolectar `.rollback.sql` correspondientes al consolidado forward.
2. Ordenar inversamente: último script primero.
3. Eliminar `BEGIN;`/`COMMIT;` de cada rollback individual.
4. Concatenar con separadores `[i/N]`.
5. Envolver en un único `BEGIN; … COMMIT;`.

### Generación del rollback por-tema

```sql
-- Rollback del tema <slug> — Release NNN (revierte 04→01)
BEGIN;

-- 04-inserts
[contenido sin BEGIN/COMMIT]

-- 03-migracion
[contenido sin BEGIN/COMMIT]

-- 02-ddl-funciones
[contenido sin BEGIN/COMMIT]

-- 01-ddl-tablas
[contenido sin BEGIN/COMMIT]

COMMIT;
```

Preservar marcas `-- WARNING: IRREVERSIBLE` y listarlas al inicio.

### Generación del global

1. Tomar `rollback-tema-<slug>.sql` de todos los temas.
2. Ordenar inversamente al de `ORDER.md`.
3. Encadenar inline (no `\i` includes) en un único `BEGIN; … COMMIT;`.
4. Listar irreversibles al inicio agrupadas por tema origen.

### Multi-tema en rollback

Scripts multi-tema se incluyen sólo en el consolidado del tema canónico. Su rollback aparece sólo allí; los demás temas no lo duplican. El global lo incluye una vez.

### Qué NO hacer

- Duplicar contenido entre consolidados.
- Cambiar el orden de categorías dentro del rollback por-tema (siempre 04→03→02→01).
- Generar consolidados de rollback para categorías sin forwards.
- Dejar `BEGIN;`/`COMMIT;` de scripts individuales dentro de los consolidados.

### Verificación mínima

- Cada consolidado forward tiene su rollback consolidado.
- Bloques en orden inverso al forward.
- Cada tema con scripts tiene su `rollback-tema-<slug>.sql`.
- El global encadena en orden inverso a `ORDER.md`.
- Irreversibles listados al inicio del global, agrupados por tema origen.
- Ningún rollback multi-tema duplicado.
- Cada archivo abre con `BEGIN;` y cierra con `COMMIT;` (uno solo por archivo).
