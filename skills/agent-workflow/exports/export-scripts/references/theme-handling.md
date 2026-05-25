# Theme handling — detección + consolidación per-tema (v4.0.0)

> **Port adaptado** de `release-scripts/references/theme-detection.md` + `release-scripts/references/order-generation.md` (ambos v2.0.0). DEC-004 de session061: contenido equivalente, paths actualizados al layout plano de export-scripts v4.0.0. **session093**: la capa `por-tema/` ya NO duplica el rollback y NO emite `ORDER.md` separado — el rollback canónico es `00-ROLLBACK.sql` único al root, y la secuencia de ejecución vive en §4 del `README.md`.

## Activación de la capa `por-tema/`

`por-tema/` es **capa adicional opt-in encima del root plano** — NO reemplaza los archivos `0X-*.sql` consolidados cross-session al root. Se genera **sólo** si se cumple **alguna** de estas condiciones:

1. `--themes slug1,slug2` declarado explícitamente.
2. Al menos una de las sesiones incluidas tiene sección `## Temas` en su `OBJECTIVE.md` (o `OBJETIVO.md` legacy).
3. `--themes infer` declarado (inferencia LLM con confirmación).

Si **ninguna** se cumple: el output dir contiene sólo `00-ROLLBACK.sql` + `0X-*.sql` (categorías con contenido) + `README.md` al root. No se crea sub-carpeta `por-tema/` vacía.

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

1. Leer OBJECTIVE + sentencias del `SCRIPTS.sql` (con sus markers `@objeto`).
2. Inferir temas candidatos (3-5 max) con confidence score 0-1.
3. Proponer al usuario:
   ```
   Sesión session057:
   - Tema candidato: `export-report` (confidence 0.92, sentencias: ...)
   - Tema candidato: `lifecycle-extension` (confidence 0.45)
   - ¿Aceptar / editar / declarar uno propio?
   ```
4. Persistir respuesta:
   - Si sesión **activa**: escribir `## Temas` en OBJECTIVE.
   - Si sesión **cerrada**: guardar en `por-tema/themes.inferred.md` del bundle (no toca artefactos cerrados).

### Paso C — Filtro `--themes`

Si `--themes slug1,slug2` declarado: restringir el output `por-tema/` a esos slugs. Sentencias cuyo tema no entre en el filtro **siguen apareciendo en los archivos `0X-*.sql` del root** (la consolidación cross-session es independiente del filtro de temas) pero no se replican en `por-tema/`.

## Asignación de cada sentencia a su tema

Por cada sentencia forward parseada del `SCRIPTS.sql` (markers `@category` + `@stmt`):

1. **Header declarativo**: leer marker `-- Temas: slug1, slug2` si está presente. Si sí: usar esos slugs.
2. **Por nombre del stmt**: matchear contra patrones del tema (substring del slug en el nombre `@stmt`, ej. `rbac-rol-permiso` → `rbac`).
3. **Por contenido**: leer el cuerpo de la sentencia y aplicar heurística (qué tabla/función toca, qué módulo de negocio).
4. **Fallback**: si nada matchea, asignar a `tema-general/` con warning en el `README.md` §1.

### Multi-tema

Si una sentencia aplica a 2+ temas: copia al primer tema declarado y crea `.link.md` en los demás referenciando el canónico:

```markdown
# Link — sentencia multi-tema

Esta sentencia aplica al tema `[secundario]` pero su versión canónica vive en:

- `por-tema/tema-[primario]/03-DML.sql` (sección [N], sentencia `[stmt-original]`)

Razón: el marker `-- Temas:` lista temas múltiples, y por convención el primero es el canónico.
```

## Consolidación por categoría dentro de cada tema

Para cada tema y cada categoría (01..04):

1. Ordenar sentencias fuente por orden cronológico (cross-session por sNNN → orden de aparición en SCRIPTS.sql).
2. Para cada sentencia, extraer cuerpo eliminando `BEGIN;` inicial y `COMMIT;` final.
3. Concatenar con separadores `[i/N]` + nombre `@stmt` + ruta canónica al `SCRIPTS.sql` original.
4. Envolver todo en un único `BEGIN; … COMMIT;`.
5. Escribir `por-tema/tema-<slug>/<categoria>.sql` con nombres UPPERCASE EN canon: `01-DDL-TABLES.sql`, `02-DDL-FUNCTIONS.sql`, `03-DML.sql`, `04-INSERTS.sql`.
6. **NO se genera** `<tema>/rollback*` ni `<tema>/00-ROLLBACK.sql`. El rollback canónico es `<bundle-root>/00-ROLLBACK.sql` único — un solo punto de verdad para reversa.

### Header del consolidado

**Uno solo** al inicio del archivo, con el formato canónico de 4 líneas definido en `sql-script-organizer/SKILL.md#header-canónico`:

```
-- ============================================================================
-- Script:  tema-rbac/03-DML.sql
-- Sesion:  s057, s058, s063
-- Objeto:  migración de roles y asignaciones RBAC
-- Alcance: tablas tb_rol, tb_permiso_rol, tb_rol_usuario
-- ============================================================================
```

**No copiar** los headers individuales de cada sentencia — su origen queda registrado en los separadores `[i/N]` del cuerpo y en `README.md` §4.1 (mapping cuando `por-tema/` activo).

### `--keep-parts`

Si el flag está activo: preservar `por-tema/<slug>/parts/<categoria>/*.sql` con sentencias individuales (no consolidadas). Permite ejecutar una por vez para debugging.

## Rollback con temas activos

Sigue siendo **único**: `<bundle-root>/00-ROLLBACK.sql` cubre todas las sentencias del corpus, indistinto del tema. Cuando `por-tema/` está activo, el `README.md` §5 incluye una nota explícita:

> El `00-ROLLBACK.sql` revierte todos los temas. NO ejecutar rollbacks parciales por tema — dejaría el estado de BD inconsistente cuando los temas comparten objetos (tablas, funciones, foreign keys).

Algoritmo de generación del `00-ROLLBACK.sql` en `sql-rollback-generator/SKILL.md` v2.0.0.

## Secuencia de ejecución cuando `por-tema/` está activo

§4 del `README.md` incluye una variante "Por tema (opcional)" además del orden canónico al root. Ejemplo:

```markdown
### 4.2 Ejecución per-tema (opcional, requiere --themes)

Útil cuando un solo tema necesita validarse aisladamente en staging antes del despliegue completo. **Importante**: si se ejecuta un tema parcial, el rollback canónico (`00-ROLLBACK.sql`) sigue cubriendo todo el bundle — no hay rollback per-tema.

```bash
# Tema rbac:
psql -f por-tema/tema-rbac/01-DDL-TABLES.sql
psql -f por-tema/tema-rbac/02-DDL-FUNCTIONS.sql
psql -f por-tema/tema-rbac/03-DML.sql
psql -f por-tema/tema-rbac/04-INSERTS.sql
```
```

## Idempotencia

- Re-ejecutar export-scripts con los mismos args sobre las mismas sesiones produce el **mismo** output **modulo el NNN nuevo** del directorio. Cada invocación toma siguiente NNN; no sobrescribe.
- Para regenerar: borrar el directorio manualmente y re-invocar.
- Si los temas se declararon en OBJECTIVE: sin re-confirmación.
- Si fueron inferidos: re-propone con `--themes infer`.
