# Plantilla — Informe del bundle export-scripts

## Status: DEPRECATED (desde v4.0.0 — session093)

Este template ya **no se usa** para bundles nuevos. Desde `export-scripts` v4.0.0 el informe consolidado vive en `README.md` único al root del bundle (ver `readme-template.md`). El layout plano cross-session reemplazó `manifest.md` + `ORDER.md` + `rollback-global.sql` separados.

**Si estás generando un bundle nuevo**: usar `references/readme-template.md` (plantilla canónica).

**Si estás leyendo un bundle histórico** (`docs/scripts/001-002-003-export-scripts-*` generado por v3.x): este template describe el formato que tenía. No se reescriben los bundles ya generados.

---

## Plantilla original (export-scripts v3.x — histórico)

Plantilla exacta que usaba el skill `export-scripts` v3.x para generar `manifest.md` dentro del output dir. Reemplazar los placeholders `[entre corchetes]` con valores reales al momento de generar.

> **Heredada de `release/references/report-template.md` v2.0.0**. Cambios respecto al original: (1) paths actualizados al nuevo output dir único; (2) sección 4.4 "Vista por tema" condicional (V4.a); (3) header con readiness color emoji; (4) sección 10 cita `export-scripts v1.0.0`.

---

```markdown
# Informe del bundle NNN — [YYYY-MM-DD]

- **Rama actual:** `[nombre-rama]`
- **Rama destino:** `certificacion`
- **Sesiones incluidas:** [N]
- **Readiness:** [🟢 verde | 🟡 amarillo | 🔴 rojo]
- **Generado por:** agent-workflow · skill `export-scripts`

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
| 1 | session001-nombre | closed | 5 | YYYY-MM-DD → YYYY-MM-DD | [resumen 1 línea] | [DEC](../decisiones/001-*.md) · [SQL](por-sesion/sessionXXX-*/) |
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
  - **Detalle:** enviar correo con plantilla abajo (sección 3.1).

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

Adjunto el manifest con detalle técnico: docs/scripts/NNN-export-scripts-[YYYY-MM-DD]/manifest.md

Quedamos atentos.
Saludos.
```

---

## 4. Base de datos

### 4.1 Secuencia de ejecución

Orden obligatorio (01 → 02 → 03 → 04) por sesión cronológica. Detalle completo en `ORDER.md`.

Resumen alto nivel:

1. **session001** → `por-sesion/session001-[slug]/01-ddl-tablas/...`
2. **session001** → `por-sesion/session001-[slug]/02-ddl-funciones/...`
3. **session001** → `por-sesion/session001-[slug]/03-migracion/...`
4. **session001** → `por-sesion/session001-[slug]/04-inserts/...`
5. **session002** → ...

### 4.2 Rollback

Bundle global: `rollback-global.sql` (en este mismo directorio).

Orden inverso absoluto: última sesión → primera, y dentro de cada una 04 → 03 → 02 → 01. Ejecutable dentro de un único `BEGIN; … COMMIT;`.

**Operaciones irreversibles detectadas:**

| Script | Sesión origen | Operación | Mitigación disponible |
|---|---|---|---|
| `por-sesion/session003-*/03-migracion/001-*.sql` | session003 | `DROP COLUMN col_legacy` | Respaldo en `esq_audit.tb_bkp_...` (script `000-backup-*.sql`) |

Si no hay irreversibles: incluir un placeholder con "Sin operaciones irreversibles en este bundle." (el AI debe reemplazar la tabla por esta frase única).

### 4.3 Impacto

- **Tablas creadas:** [lista]
- **Tablas modificadas:** [lista, indicando tipo de ALTER]
- **Funciones creadas/modificadas:** [lista]
- **Filas afectadas por migración:** [estimación si hay count en sesiones]

### 4.4 Vista por tema

> **Condicional V4.a**: incluir esta sub-sección **sólo si** `por-tema/` se generó (temas declarados, `## Temas` en OBJECTIVE, o `--themes infer`). Si no se generó, omitir entera la sub-sección 4.4 (sin header).

Bundle por tema: `por-tema/`

- **Orden ejecutable cross-tema:** `por-tema/ORDER.md`
- **Temas incluidos:** [slug1], [slug2], [slug3] — [N] scripts.

Mapeo tema ↔ sesión ↔ scripts: `README.md` §"Mapping".

---

## 5. Código fuente — hallazgos del escaneo

> **Condicional V4.b**: si `--skip-code-scan` fue usado, esta sección contiene **sólo** una nota inline `_(Escaneo omitido por --skip-code-scan)_` y nada más.

**Resumen:** [X] críticos · [Y] medios · [Z] bajos

### 5.1 Severidad alta (bloqueantes para producción)

| # | Patrón | Archivo:línea | Snippet | Recomendación |
|---|---|---|---|---|
| H1 | Credencial hardcodeada | `src/.../Config.java:42` | `password = "..."` | Mover a variable de entorno o gestor de secretos. Rotar la credencial si fue commiteada. |

Si vacío: incluir un placeholder con "Sin hallazgos de severidad alta." (frase única que reemplaza la tabla).

### 5.2 Severidad media

| # | Patrón | Archivo:línea | Snippet | Recomendación |
|---|---|---|---|---|
| M1 | URL localhost | `src/.../api.service.ts:18` | `http://localhost:8080` | Reemplazar por `environment.apiUrl` u otro mecanismo de configuración. |

### 5.3 Severidad baja

Agrupados por patrón, con conteo. Lista expandida si hay menos de 20; si más, mostrar top 10 y conteo total.

| Patrón | Conteo | Ejemplos |
|---|---|---|
| `TODO` | 7 | `UserService.java:88`, `OrderService.java:42`, ... |
| `FIXME` | 2 | `validator.ts:15`, `payment.ts:103` |

### 5.4 Alcance del escaneo

- **Directorios incluidos:** [lista]
- **Directorios excluidos:** `node_modules/`, `target/`, `dist/`, `build/`, `.workflow/`, `docs/`, `tests/`, `test/`, `.git/`
- **Extensiones:** [lista]

---

## 6. Git y ramas

- **Rama actual:** `[nombre]`
- **Rama destino:** `certificacion`
- **Commits pendientes de merge (rama actual → certificacion):** [N]

### 6.1 Commits pendientes

```
[sha corto] [mensaje]
[sha corto] [mensaje]
```

### 6.2 Archivos modificados (git diff --stat)

```
[salida de git diff certificacion --stat]
```

### 6.3 Cambios sin commitear

Si `git status` muestra archivos modificados/untracked:

```
[salida de git status --porcelain]
```

**Acción recomendada:** el usuario decide si esos cambios entran al bundle (commit) o no (stash/descartar).

### 6.4 PR sugerido (texto — no se crea)

```
Título: [feat/fix/chore]: [resumen del bundle]
Rama origen: [rama actual]
Rama destino: certificacion
Descripción:
- Bundle NNN consolidando las siguientes sesiones:
  - session001 — [título]
  - session002 — [título]
- Manifest completo: docs/scripts/NNN-export-scripts-[YYYY-MM-DD]/manifest.md
- Bundle SQL: docs/scripts/NNN-export-scripts-[YYYY-MM-DD]/por-sesion/
```

---

## 7. Documentación graduada

| Sesión | Decisiones | Manuales | Especificaciones | Conclusiones |
|---|---|---|---|---|
| session001 | `001-*.md`, `002-*.md` | — | — | — |
| session002 | — | `003-*.md` | — | — |
| session003 | `004-*.md` | — | `001-*/` | — |

Nota: el modelo nuevo gradua 6 kinds (`decision`, `manual`, `script`, `especificacion`, `conclusion`, `release`). Este manifest enlaza los 4 primeros; `release` queda implícito en este mismo dossier; `script` queda implícito en `por-sesion/`.

---

## 8. Checklist final de producción

Lista única consolidada. Todos los ítems deben marcarse antes del "go":

- [ ] **BD:** respaldo completo del esquema afectado tomado y verificado
- [ ] **BD:** scripts ejecutados en orden (01 → 02 → 03 → 04)
- [ ] **BD:** rollback probado en staging/certificación
- [ ] **Infra:** variables de entorno actualizadas (ver sección 3)
- [ ] **Infra:** API keys de producción solicitadas y configuradas
- [ ] **Código:** hallazgos de severidad alta resueltos (sección 5.1)
- [ ] **Git:** rama mergeada a `certificacion` (o PR aprobado)
- [ ] **Git:** tag/release creado en el repositorio
- [ ] **Stakeholders:** notificación enviada antes y después del despliegue
- [ ] **Acciones manuales:** todos los ACT-XXX de la sección 3 completados

---

## 9. Advertencias

Cosas que el skill detectó pero no pudo validar automáticamente. Leer antes de marcar el checklist como completo.

Si no hay advertencias: incluir un placeholder con "Sin advertencias pendientes." (frase única).

---

## 10. Metadata

- **Generado:** YYYY-MM-DD HH:MM
- **Versión del skill:** export-scripts v1.0.0
- **Argumentos usados:** `[sin argumentos | --since sessionNNN | --themes slug1,slug2 | --dry-run | --skip-code-scan]`
- **Comando original:** `/agent-workflow:export-scripts [args]`
- **Reemplaza:** `/agent-workflow:release` v2.0.0 + `/agent-workflow:release-scripts` v2.0.0 (ambos en deprecation Fase 1 desde plugin v2.8.0)
```
