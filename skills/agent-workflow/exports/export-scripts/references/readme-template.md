# Plantilla — README del bundle export-scripts (v4.0.0)

Plantilla canónica del `README.md` único del bundle. Reemplaza `manifest.md` + `ORDER.md` legacy desde v4.0.0 (session093). Reemplazar `[entre corchetes]` con valores reales al momento de generar.

> **Heredada y consolidada de**: `manifest-template.md` v3.x (informe) + `readme-template.md` v3.x (índice). v4.0.0 unifica ambos en una sola plantilla siguiendo la doctrina "un solo punto de verdad" del usuario.

---

```markdown
# Bundle export-scripts NNN — [YYYY-MM-DD]

- **Rama actual:** `[nombre-rama]`
- **Rama destino:** `certificacion`
- **Sesiones incluidas:** [N]
- **Readiness:** [🟢 verde | 🟡 amarillo | 🔴 rojo]
- **Generado por:** agent-workflow · skill `export-scripts` v4.0.0

## Contenido del bundle (layout v4.0.0)

| Archivo | Propósito | Condicional |
|---|---|---|
| `00-ROLLBACK.sql` | Único rollback cross-session — encadenado 04→01 dentro de un `BEGIN; ... COMMIT;` único. Bloque "Fase 5 — Cleanup irreversible" al final fuera de la transacción. | Siempre (si hay sentencias) |
| `01-DDL-TABLES.sql` | `CREATE TABLE` / `ALTER TABLE` / `CREATE INDEX` / `CREATE SEQUENCE` cross-session. | Skip si categoría vacía |
| `02-DDL-FUNCTIONS.sql` | `CREATE OR REPLACE FUNCTION` / `PROCEDURE` cross-session. | Skip si categoría vacía |
| `03-DML.sql` | `UPDATE` / `DELETE` / migración de datos cross-session (con backup en `esq_audit` cuando aplica). | Skip si categoría vacía |
| `04-INSERTS.sql` | `INSERT` / seed de datos maestros cross-session. | Skip si categoría vacía |
| `README.md` | Este archivo — único informe + índice + how-to-execute. | Siempre |
| `_queries/sessionXXX/` | Queries de consulta de soporte por sesión (no ejecución). | Solo si alguna sesión tenía `queries/` |
| `por-tema/<slug>/` | Capa adicional opt-in con consolidado per-tema (sin rollback duplicado). | Solo si `--themes` activado o `## Temas` declarado |

---

## 1. Resumen ejecutivo

[1-2 párrafos sintetizando qué entra en este bundle: módulos tocados, tipo de cambios predominantes (features, fixes, migración de datos), y el juicio general de readiness con 1-2 motivos principales.]

**Motivos del color de readiness:**
- [motivo 1]
- [motivo 2]

---

## 2. Sesiones incluidas

| # | Sesión | Estado | Fase | Fechas | Resumen | Refs |
|---|---|---|---|---|---|---|
| 1 | session001-nombre | closed | 5 | YYYY-MM-DD → YYYY-MM-DD | [resumen 1 línea] | [DEC](../decisiones/001-*.md) |
| 2 | session002-nombre | ⚠ active | 3 | YYYY-MM-DD → — | [resumen 1 línea] + motivo de apertura | — |

**Sesiones abiertas:** destacadas con ⚠. Cada una baja la readiness del bundle. Motivo y próxima acción debe quedar explícito en el resumen.

---

## 3. Acciones manuales previas a producción

Checklist ordenado. Marcar cada ítem antes del despliegue.

- [ ] **ACT-001** — [Título corto]
  - **Motivo:** [por qué es necesaria]
  - **Quién:** [rol/persona sugerida]
  - **Detalle:** [qué hacer, con qué entrada/salida esperada]

- [ ] **ACT-002** — Solicitar API keys de producción
  - **Motivo:** REQUIREMENTS de session003 menciona integración con servicio externo pero no hay claves concretas.
  - **Quién:** Administrador de infraestructura
  - **Detalle:** enviar correo con plantilla en §3.1.

### 3.1 Plantillas de correo

Copiar, personalizar y enviar manualmente. **Este plugin no envía correos.**

```
Para: [correo-destino]
CC: [correo-cc]
Asunto: [Bundle NNN] Solicitud de API keys de producción

Buen día,

Para el bundle NNN-[nombre] que se despliega el [fecha objetivo] requerimos las siguientes credenciales de producción:

- [servicio 1] — URL y token de acceso
- [servicio 2] — usuario/clave técnica

Adjunto el bundle: docs/scripts/NNN-export-scripts-[YYYY-MM-DD]/README.md

Quedamos atentos.
Saludos.
```

---

## 4. Secuencia de ejecución (01 → 04)

Orden obligatorio. Categorías vacías se omiten (no aparece el archivo).

```bash
# 1. DDL de tablas (CREATE/ALTER TABLE, INDEX, SEQUENCE)
psql -h <host> -U <user> -d <db> -f 01-DDL-TABLES.sql

# 2. DDL de funciones (CREATE OR REPLACE FUNCTION/PROCEDURE)
psql -h <host> -U <user> -d <db> -f 02-DDL-FUNCTIONS.sql

# 3. DML / migración (UPDATE, DELETE, backup en esq_audit)
psql -h <host> -U <user> -d <db> -f 03-DML.sql

# 4. Inserts / seed maestros
psql -h <host> -U <user> -d <db> -f 04-INSERTS.sql
```

> **Importante**: este plugin NO ejecuta SQL. El usuario aplica los scripts manualmente.

### 4.1 Mapping sesión ↔ tema ↔ scripts

> **Condicional**: incluir esta sub-sección **sólo si** `--themes` activado y `por-tema/` se generó. Si no, omitir entera la 4.1.

| Sesión | Tema | Sentencias (categoría:NNN-stmt) |
|---|---|---|
| session001 | `tema-rbac` | 01:001-rol-permiso, 02:001-fn-validacion, 03:001-mig-roles |
| session002 | `tema-rbac` | 01:001-asignacion-default |
| session003 | `tema-lista-negra-blanca` | 01:001-listas-table, 04:001-inserts-iniciales |

---

## 5. Rollback (`00-ROLLBACK.sql`)

Un solo archivo cross-session al root del bundle. Orden interno inverso absoluto: última sesión → primera; dentro de cada una 04 → 03 → 02 → 01.

```bash
# Ejecutar el rollback completo en una sola transacción:
psql -h <host> -U <user> -d <db> -f 00-ROLLBACK.sql
```

### 5.1 Operaciones irreversibles

**Detectadas en el bundle:**

| Sesión origen | Operación | Mitigación disponible |
|---|---|---|
| session003 | `DROP COLUMN col_legacy` | Respaldo previo en `esq_audit.tb_bkp_session003` (incluido en `03-DML.sql`) |
| session005 | `TRUNCATE esq_x.tb_z` | Sin backup automático — pérdida total de datos |

Si no hay irreversibles: incluir un placeholder con "Sin operaciones irreversibles en este bundle." (el AI debe reemplazar la tabla por esta frase única).

**Bloque "Fase 5" del `00-ROLLBACK.sql`**: las operaciones irreversibles aparecen al final del archivo **fuera de la transacción** principal, con header `-- WARNING: IRREVERSIBLE` y referencia a la DECISION de la sesión origen. El operador decide ejecutar este bloque manualmente.

### 5.2 Impacto

- **Tablas creadas:** [lista]
- **Tablas modificadas:** [lista, indicando tipo de ALTER]
- **Funciones creadas/modificadas:** [lista]
- **Filas afectadas por migración:** [estimación si hay count en sesiones]

---

## 6. Código fuente — hallazgos del escaneo

> **Condicional V4.b**: si `--skip-code-scan` fue usado, esta sección contiene **sólo** una nota inline `_(Escaneo omitido por --skip-code-scan)_` y nada más.

**Resumen:** [X] críticos · [Y] medios · [Z] bajos

### 6.1 Severidad alta (bloqueantes para producción)

| # | Patrón | Archivo:línea | Snippet | Recomendación |
|---|---|---|---|---|
| H1 | Credencial hardcodeada | `src/.../Config.java:42` | `password = "..."` | Mover a variable de entorno o gestor de secretos. Rotar la credencial si fue commiteada. |

Si vacío: incluir un placeholder con "Sin hallazgos de severidad alta." (frase única que reemplaza la tabla).

### 6.2 Severidad media

| # | Patrón | Archivo:línea | Snippet | Recomendación |
|---|---|---|---|---|
| M1 | URL localhost | `src/.../api.service.ts:18` | `http://localhost:8080` | Reemplazar por `environment.apiUrl` u otro mecanismo de configuración. |

### 6.3 Severidad baja

Agrupados por patrón, con conteo.

| Patrón | Conteo | Ejemplos |
|---|---|---|
| `TODO` | 7 | `UserService.java:88`, `OrderService.java:42`, ... |
| `FIXME` | 2 | `validator.ts:15`, `payment.ts:103` |

### 6.4 Alcance del escaneo

- **Directorios incluidos:** [lista]
- **Directorios excluidos:** `node_modules/`, `target/`, `dist/`, `build/`, `.workflow/`, `docs/`, `tests/`, `test/`, `.git/`
- **Extensiones:** [lista]

---

## 7. Git y ramas

- **Rama actual:** `[nombre]`
- **Rama destino:** `certificacion`
- **Commits pendientes de merge (rama actual → certificacion):** [N]

### 7.1 Commits pendientes

```
[sha corto] [mensaje]
[sha corto] [mensaje]
```

### 7.2 Archivos modificados (git diff --stat)

```
[salida de git diff certificacion --stat]
```

### 7.3 Cambios sin commitear

Si `git status` muestra archivos modificados/untracked:

```
[salida de git status --porcelain]
```

**Acción recomendada:** el usuario decide si esos cambios entran al bundle (commit) o no (stash/descartar).

### 7.4 PR sugerido (texto — no se crea)

```
Título: [feat/fix/chore]: [resumen del bundle]
Rama origen: [rama actual]
Rama destino: certificacion
Descripción:
- Bundle NNN consolidando las siguientes sesiones:
  - session001 — [título]
  - session002 — [título]
- Bundle completo: docs/scripts/NNN-export-scripts-[YYYY-MM-DD]/
```

---

## 8. Documentación graduada

| Sesión | Decisiones | Manuales | Especificaciones | Conclusiones |
|---|---|---|---|---|
| session001 | `001-*.md`, `002-*.md` | — | — | — |
| session002 | — | `003-*.md` | — | — |
| session003 | `004-*.md` | — | `001-*/` | — |

Nota: el modelo nuevo gradua 6 kinds (`decision`, `manual`, `script`, `especificacion`, `conclusion`, `release`). Este README enlaza los 4 primeros; `release` queda implícito en este mismo dossier; `script` queda implícito en los archivos `0X-*.sql` del root.

---

## 9. Checklist final de producción

Lista única consolidada. Todos los ítems deben marcarse antes del "go":

- [ ] **BD:** respaldo completo del esquema afectado tomado y verificado
- [ ] **BD:** scripts ejecutados en orden (`01-DDL-TABLES.sql` → `02-DDL-FUNCTIONS.sql` → `03-DML.sql` → `04-INSERTS.sql`)
- [ ] **BD:** `00-ROLLBACK.sql` probado en staging/certificación
- [ ] **Infra:** variables de entorno actualizadas (ver §3)
- [ ] **Infra:** API keys de producción solicitadas y configuradas
- [ ] **Código:** hallazgos de severidad alta resueltos (§6.1)
- [ ] **Git:** rama mergeada a `certificacion` (o PR aprobado)
- [ ] **Git:** tag/release creado en el repositorio
- [ ] **Stakeholders:** notificación enviada antes y después del despliegue
- [ ] **Acciones manuales:** todos los ACT-XXX de §3 completados

### 9.1 Advertencias

Cosas que el skill detectó pero no pudo validar automáticamente. Leer antes de marcar el checklist como completo.

Si no hay advertencias: incluir un placeholder con "Sin advertencias pendientes." (frase única).

---

## 10. Metadata

- **Generado:** YYYY-MM-DD HH:MM
- **Versión del skill:** export-scripts v4.0.0 (layout plano cross-session)
- **Sub-skill rollback:** sql-rollback-generator v2.0.0
- **Argumentos usados:** `[sin argumentos | --sessions NNN[,NNN] | --since sessionNNN | --themes slug1,slug2 | --dry-run | --skip-code-scan]`
- **Comando original:** `/agent-workflow:export-scripts [args]`
- **Reemplaza:** `/agent-workflow:release` v2.0.0 + `/agent-workflow:release-scripts` v2.0.0 (ambos en deprecation Fase 1 desde plugin v2.8.0)

## Re-generación

Para regenerar este bundle:

```
/agent-workflow:export-scripts [--sessions NNN[,NNN]] [--since sessionNNN] [--themes slug1,slug2]
```

Cada invocación toma siguiente NNN. NO sobrescribe bundles previos. Bundles generados con export-scripts v3.x (layout `por-sesion/` + `manifest.md` + `ORDER.md` + `rollback-global.sql`) quedan como histórico y no se migran.
```
