# Theme handling — detección + consolidación + ORDER cross-tema

> **Port adaptado** de `release-scripts/references/theme-detection.md` + `release-scripts/references/order-generation.md` (ambos v2.0.0). DEC-004 de session061: contenido equivalente, paths actualizados al output dir único de export-scripts.

## Activación de la vista `por-tema/`

`por-tema/` se genera **sólo** si se cumple **alguna** de estas condiciones:

1. `--themes slug1,slug2` declarado explícitamente.
2. Al menos una de las sesiones incluidas tiene sección `## Temas` en su `OBJECTIVE.md` (o `OBJETIVO.md` legacy).
3. `--themes infer` declarado (inferencia LLM con confirmación).

Si **ninguna** se cumple: el output dir contiene solo `por-sesion/` + archivos top-level. No se crea sub-carpeta `por-tema/` vacía.

## Formato de `## Temas` en OBJECTIVE

```markdown
## Temas

- `rbac`: gestión de roles y permisos
- `lista-negra-blanca`: filtros de acceso
- `auditoria`: logging de cambios sensibles
```

Reglas:
- Slug kebab-case (`a-z0-9-`).
- Una descripción breve por tema (ayuda a la inferencia cross-session).
- Sin overlapping en una misma sesión salvo necesidad expresa.

## Resolución de temas por sesión

### Paso A — Lectura declarativa

Para cada sesión incluida, leer `OBJECTIVE.md` (fallback bilingual a `OBJETIVO.md`) buscando sección `## Temas`. Si presente: extraer slugs como autoritativos para esa sesión.

### Paso B — Inferencia LLM (si `--themes infer` o falta declarativo en N sesiones)

Para cada sesión sin `## Temas`:

1. Leer OBJECTIVE + nombres de scripts SQL.
2. Inferir temas candidatos (3-5 max) con confidence score 0-1.
3. Proponer al usuario:
   ```
   Sesión session057:
   - Tema candidato: `export-report` (confidence 0.92, scripts: ...)
   - Tema candidato: `lifecycle-extension` (confidence 0.45)
   - ¿Aceptar / editar / declarar uno propio?
   ```
4. Persistir respuesta:
   - Si sesión **activa**: escribir `## Temas` en OBJECTIVE.
   - Si sesión **cerrada**: guardar en `por-tema/themes.inferred.md` del bundle (no toca artefactos cerrados).

### Paso C — Filtro `--themes`

Si `--themes slug1,slug2` declarado: restringir el output `por-tema/` a esos slugs. Scripts cuyo tema no entre en el filtro caen en `por-sesion/` solamente (no aparecen en `por-tema/`).

## Asignación de cada script a su tema

Por cada `.sql` forward de las sesiones incluidas:

1. **Header declarativo**: leer primeras 10 líneas buscando `-- Temas: slug1, slug2`. Si presente: usa esos slugs.
2. **Por nombre**: matchear contra patrones del tema (substring del slug en el filename, ej. `rbac-rol-permiso.sql` → `rbac`).
3. **Por contenido**: leer el SQL y aplicar heurística (qué tabla/función toca, qué módulo de negocio).
4. **Fallback**: si nada matchea, asignar a `tema-general/` con warning en el manifest.

### Multi-tema

Si un script aplica a 2+ temas: copia al primer tema declarado y crea `.link.md` en los demás referenciando el canónico:

```markdown
# Link — script multi-tema

Este script aplica al tema `[secundario]` pero su versión canónica vive en:

- `por-tema/tema-[primario]/03-migracion.sql` (sección [N], script `[nombre-original.sql]`)

Razón: el header declarativo del script lista temas múltiples, y por convención el primero es el canónico.
```

## Consolidación por categoría dentro de cada tema

Para cada tema y cada categoría (01..04):

1. Ordenar scripts fuente por NNN original (cronológico cross-session).
2. Leer cada `.sql`, extraer cuerpo eliminando `BEGIN;` inicial y `COMMIT;` final.
3. Concatenar con separadores `[i/N]` + nombre + ruta canónica.
4. Envolver todo en un único `BEGIN; … COMMIT;`.
5. Escribir `por-tema/tema-<slug>/<categoria>.sql`.
6. Consolidar `.rollback.sql` en orden inverso.

### Header del consolidado

**Uno solo** al inicio del archivo, con el formato canónico de 4 líneas definido en `sql-script-organizer/SKILL.md#header-canónico`:

```
-- Script: tema-rbac/03-migracion.sql
-- Sesion: s057, s058, s063
-- Objeto: migración de roles y asignaciones RBAC
-- Alcance: tablas tb_rol, tb_permiso_rol, tb_rol_usuario
```

**No copiar** los headers de los scripts individuales — su origen queda registrado en los separadores `[i/N]` del cuerpo y en `README.md`.

### `--keep-parts`

Si el flag está activo: preservar `por-tema/<slug>/parts/<categoria>/*.sql` con los scripts individuales (no consolidados). Permite ejecutar uno por vez para debugging.

## Rollback por tema y global

### `por-tema/tema-<slug>/rollback-tema-<slug>.sql`

Encadena los 4 consolidados de rollback (04→03→02→01) dentro de un único `BEGIN; … COMMIT;`. Operaciones irreversibles marcadas con header WARNING.

### `rollback-global.sql` (en output dir top-level)

Encadena rollback por-tema en orden **inverso a `ORDER.md`**. Si `por-tema/` no existe, encadena `por-sesion/<sessionXXX>/rollback/*.sql` por sesión cronológica inversa.

Algoritmo completo en `sql-rollback-generator/references/release-rollback.md` (referenciable cross-skill).

## `ORDER.md` cross-tema

Cuando hay `por-tema/`: el `ORDER.md` top-level del bundle intercala scripts por **fase** (no por tema):

```markdown
## Fase 1 — DDL tablas

psql -f por-tema/tema-rbac/01-ddl-tablas.sql
psql -f por-tema/tema-lista-negra-blanca/01-ddl-tablas.sql
psql -f por-tema/tema-auditoria/01-ddl-tablas.sql

## Fase 2 — DDL funciones

psql -f por-tema/tema-rbac/02-ddl-funciones.sql
...

## Fase 3 — Migración

...

## Fase 4 — Inserts iniciales

...

## Fase 5 — Cleanup irreversible

(operaciones DROP COLUMN, TRUNCATE, DROP CASCADE — al final)
```

Cuando **no** hay `por-tema/`: el `ORDER.md` lista scripts por sesión cronológica, dentro de cada una 01→04:

```markdown
## Sesión session057-export-func

psql -f por-sesion/session057-export-func/01-ddl-tablas/001-...sql
psql -f por-sesion/session057-export-func/02-ddl-funciones/001-...sql
...

## Sesión session058-export-arq

...
```

## Idempotencia

- Re-ejecutar export-scripts con los mismos args sobre las mismas sesiones produce el **mismo** output **modulo el NNN nuevo** del directorio. Cada invocación toma siguiente NNN; no sobrescribe.
- Para regenerar: borrar el directorio manualmente y re-invocar.
- Si los temas se declararon en OBJECTIVE: sin re-confirmación.
- Si fueron inferidos: re-propone con `--themes infer`.
