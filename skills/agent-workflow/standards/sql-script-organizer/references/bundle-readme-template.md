# Plantilla — README del Bundle SQL

Usar esta plantilla para generar `scripts/bundle/README.md` al finalizar la reorganización.

---

```markdown
# Bundle SQL — sessionXXX: [nombre de sesión]

## Información

- **Sesión:** sessionXXX-[nombre-kebab]
- **Fecha de bundle:** YYYY-MM-DD
- **Motor de BD:** PostgreSQL [versión si se conoce]
- **Esquemas afectados:** esq_[dominio1], esq_[dominio2]

## Resumen

[1-2 líneas describiendo qué hace este bundle en conjunto]

## Orden de ejecución (forward)

Ejecutar en este orden exacto. Cada script usa `BEGIN`/`COMMIT`.

### 01 — DDL de Tablas

| # | Archivo | Descripción |
|---|---|---|
| 1 | `01-ddl-tablas/001-crea-tb-x.sql` | [descripción breve] |
| 2 | `01-ddl-tablas/002-agrega-col-tb-y.sql` | [descripción breve] |

### 02 — DDL de Funciones / SP

| # | Archivo | Descripción |
|---|---|---|
| 1 | `02-ddl-funciones/001-crea-fn-z.sql` | [descripción breve] |

### 03 — Migración de Datos

> Ejecutar scripts de respaldo (`000-backup-*.sql`) primero.

| # | Archivo | Descripción |
|---|---|---|
| 1 | `03-migracion/000-backup-tb-x.sql` | Respaldo previo en esq_audit |
| 2 | `03-migracion/001-migra-estado-x.sql` | [descripción breve] |

### 04 — Inserts Nuevos

| # | Archivo | Descripción |
|---|---|---|
| 1 | `04-inserts/001-inserta-maestras.sql` | [descripción breve] |

## Rollback

Para revertir **toda** la sesión: ejecutar `rollback/00-rollback-global.sql`.

Para revertir **un script específico**: ejecutar el `.rollback.sql` acoplado al lado del forward.

**Orden de rollback** (inverso al forward): 04 → 03 → 02 → 01.

## Operaciones irreversibles

<!-- Listar si aplica. Si no hay ninguna, eliminar esta sección. -->

| Script | Operación | Riesgo | Mitigation |
|---|---|---|---|
| `01-ddl-tablas/002-elimina-col-legacy.sql` | DROP COLUMN | Pérdida de datos | Backup en esq_audit antes de ejecutar |

## Dependencias externas

<!-- Scripts o estados de BD que deben existir ANTES de ejecutar este bundle -->

- [Ej: `tb_maestra_detalle` debe tener el `codprog` X con los estados Y, Z]
- [Ej: El feature flag `FLAG_NUEVA_FUNCIONALIDAD` debe estar activo]

## Notas de ejecución

<!-- Cualquier instrucción manual necesaria antes o después del bundle -->

- [Ej: Detener el servicio X antes de ejecutar `03-migracion/`]
- [Ej: Refrescar la caché de parámetros después de `04-inserts/`]
```
