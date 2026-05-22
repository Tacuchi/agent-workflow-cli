# Consolidación cross-session (release) y modo por tema

Detalles del comportamiento de `sql-script-organizer` cuando es invocado por `release` (cross-session) o por `release-scripts` (por tema). El SKILL.md tiene el resumen; este archivo tiene el procedimiento completo.

## Modo consolidación cross-session (delegado por `release`)

Produce un bundle único que abarca múltiples sesiones en `docs/release/NNN-release-YYYY-MM-DD/scripts/`.

### Entrada

Lista de bundles fuente en orden cronológico de sesión:
- Sesiones cerradas: `docs/scripts/NNN-sessionXXX-*/` (ya graduados).
- Sesiones abiertas: `.workflow/sessions/sessionXXX-*/scripts/bundle/` o `scripts/` flat (organizar antes).

### Proceso

1. **Validar organización** de cada bundle fuente. Si flat, aplicar el proceso estándar de las 4 categorías antes.
2. **Crear estructura destino** con `01-ddl-tablas/`, `02-ddl-funciones/`, `03-migracion/`, `04-inserts/`, `rollback/`.
3. **Copiar scripts preservando orden**:
   - Sesiones cronológicas (session001 → session002 → …).
   - Dentro de cada sesión, orden 01→02→03→04.
   - Renumerar `NNN` continuo dentro de la categoría.
   - Header de origen:
     ```sql
     -- Origen: sessionXXX-nombre · docs/scripts/NNN-sessionXXX-nombre/03-migracion/001-xyz.sql
     -- Consolidado en release NNN (YYYY-MM-DD)
     ```
   - El `.rollback.sql` viaja con su forward.
4. **No fusionar** scripts distintos en un único archivo.
5. **Resolver conflictos cross-sesión**: documentar en `scripts/README.md` si una migración depende de algo reemplazado.
6. **Generar `scripts/README.md`** con:
   - Secuencia de ejecución lineal.
   - Tabla "script en release | sesión origen | script original".
   - Listado de irreversibles.
7. **Delegar a `sql-rollback-generator`** para el rollback global.

### Qué NO hacer

- Modificar scripts originales en `docs/scripts/NNN-sessionXXX-*/` — son memoria permanente.
- Mezclar sentencias de scripts distintos.
- Renombrar categorías — siempre 01→02→03→04.
- Saltar sesiones sin registrarlo.

### Layout del bundle consolidado

```
docs/release/NNN-release-YYYY-MM-DD/scripts/
├── README.md                          (mapeo sesión → script + secuencia)
├── 01-ddl-tablas/
│   ├── 001-crea-tb-x.sql              (origen: session001)
│   ├── 001-crea-tb-x.rollback.sql
│   ├── 002-crea-tb-y.sql              (origen: session003)
│   └── 002-crea-tb-y.rollback.sql
├── 02-ddl-funciones/
│   └── ...
├── 03-migracion/
│   ├── 000-backup-tb-x.sql            (origen: session001)
│   ├── 001-migra-col-z.sql
│   ├── 001-migra-col-z.rollback.sql
│   └── ...
├── 04-inserts/
│   └── ...
└── rollback/
    └── 00-rollback-release.sql        (sql-rollback-generator)
```

### Confirmación

Si el usuario no confirmó producir el bundle consolidado, NO crear la carpeta. Referenciar bundles graduados por sesión y listar ejecución lineal.

## Modo por tema consolidado (delegado por `release-scripts`)

Reutiliza la clasificación 01→04 pero la aplica **dentro de cada tema** y **consolida** todos los scripts de una misma `(tema, categoría)` en un único `.sql`.

### Layout destino

```
docs/release/NNN-release-YYYY-MM-DD/scripts-por-tema/
└── tema-<slug>/
    ├── 01-ddl-tablas.sql              (consolidado, BEGIN/COMMIT único)
    ├── 01-ddl-tablas.rollback.sql     (consolidado inverso)
    ├── 02-ddl-funciones.sql
    ├── 02-ddl-funciones.rollback.sql
    ├── 03-migracion.sql
    ├── 03-migracion.rollback.sql
    ├── 04-inserts.sql
    ├── 04-inserts.rollback.sql
    └── rollback-tema-<slug>.sql       (revierte el tema completo)
```

### Qué cambia respecto al modo estándar

- **Consolidación**: N scripts de `(tema, categoría)` se concatenan en un único archivo. Eliminar `BEGIN;`/`COMMIT;` de cada uno; añadir `BEGIN;` único al inicio y `COMMIT;` al final. Transacción atómica por categoría del tema.
- **Trazabilidad**: separador `-- === [i/N] <nombre-original> ===` + ruta canónica.
- **Sin subcarpetas por categoría**: el nombre de archivo ya indica la categoría.
- **Categorías vacías** no se crean.
- **Scripts fuente preservados opt** con `--keep-parts` → `parts/<categoria>/*.sql`.
- **Orden cross-tema**: en `ORDER.md` (resuelto por `release-scripts`).

### Qué NO cambia

- Las 4 categorías y sus patrones.
- Las reglas de estilo SQL.
- El bundle plano sigue generándose igual; el modo por-tema es aditivo.

### Formato del archivo consolidado

```sql
-- Tema: <slug>
-- Categoría: 01-ddl-tablas
-- Release: NNN (YYYY-MM-DD)
-- Consolidado: <nombre1>.sql, <nombre2>.sql, …

BEGIN;

-- [1/N] <nombre>.sql (origen: sessionXXX)
<contenido sin BEGIN/COMMIT>

-- [2/N] <nombre>.sql (origen: sessionXXX)
<contenido>

COMMIT;
```

Ver `release-scripts/SKILL.md` y `release-scripts/references/theme-detection.md` para asignación script→tema.
