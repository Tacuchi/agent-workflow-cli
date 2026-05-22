# Plantilla — README del bundle export-scripts

Plantilla exacta para el `README.md` del output dir. Se escribe junto con `manifest.md`. Reemplazar `[entre corchetes]` con valores reales.

---

```markdown
# Bundle export-scripts NNN — [YYYY-MM-DD]

Bundle SQL + informe consolidado para paso a producción. Generado por `/agent-workflow:export-scripts`.

## Contenido

| Archivo | Propósito |
|---|---|
| `manifest.md` | Informe consolidado: sesiones, acciones manuales, BD, hallazgos code-scan, git state, checklist final. |
| `ORDER.md` | Secuencia ejecutable cross-bundle (01 → 02 → 03 → 04 por sesión, intercalado por tema si aplica). |
| `rollback-global.sql` | Rollback encadenado inverso (toda sesión → primera, 04 → 01 dentro de cada una). |
| `por-sesion/` | Bundle SQL por sesión, organizado en 4 categorías. |
| `por-tema/` | (opcional) Bundle consolidado cross-session por tema/funcionalidad. |

## Mapping sesión ↔ tema ↔ scripts

> **Condicional**: incluir esta sección **sólo si** `por-tema/` se generó.

| Sesión | Tema | Scripts |
|---|---|---|
| session001 | `tema-rbac` | `01-rol-permiso.sql`, `02-fn-validacion.sql`, `03-mig-roles.sql` |
| session002 | `tema-rbac` | `01-asignacion-default.sql` |
| session003 | `tema-lista-negra-blanca` | `01-listas-table.sql`, `04-inserts-iniciales.sql` |

## Cómo ejecutar el bundle

### Paso 1 — Validar pre-condiciones

1. Revisar `manifest.md` §3 (acciones manuales) — completar antes de ejecutar SQL.
2. Revisar `manifest.md` §5 (hallazgos code-scan) — resolver severidades altas.
3. Tomar respaldo completo del esquema afectado.

### Paso 2 — Ejecutar SQL

```bash
# Opción A: orden por sesión (default)
cat ORDER.md  # ver secuencia

# Ejecutar manualmente cada script en orden:
psql -h <host> -U <user> -d <db> -f por-sesion/session001-<slug>/01-ddl-tablas/001-*.sql
# ... continuar con 02, 03, 04 ...
```

> **Importante**: este plugin NO ejecuta SQL. El usuario aplica los scripts manualmente.

### Paso 3 — Validar post-ejecución

1. Marcar checklist final de `manifest.md` §8.
2. Si algo falló: aplicar `rollback-global.sql` en una sola transacción.

## Rollback

Bundle global: `rollback-global.sql` (este directorio).

Orden inverso absoluto: última sesión → primera; dentro de cada una 04 → 03 → 02 → 01.

**Operaciones irreversibles** (si las hay): listadas en `manifest.md` §4.2 con su mitigación. Revisar antes de ejecutar rollback.

## Re-generación

Para regenerar este bundle:

```
/agent-workflow:export-scripts [--since sessionNNN] [--themes slug1,slug2]
```

Cada invocación toma siguiente NNN. NO sobrescribe bundles previos.

## Relación con release legacy

Este bundle reemplaza el output que generaban `/agent-workflow:release` + `/agent-workflow:release-scripts` legacy (ambos en deprecation Fase 1 desde plugin v2.8.0). Si tu workspace tiene `docs/release/` poblado: queda como histórico, no se migra.
```
