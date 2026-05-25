# Validations — V1-V6 para `/agent-workflow:export-scripts` (v4.0.0)

Checks post-render que se aplican antes de escribir el bundle al filesystem. Adaptados del canon de la familia export-* (export-arq + export-report) con foco en bundle SQL + informe único.

Niveles de severidad:
- **Hard-fail**: aborta la escritura, devuelve `ok: false` con error report. No se crea el directorio.
- **Warning**: emite mensaje, pide confirmación del usuario para continuar.

## V1 — Estructura del bundle (layout plano cross-session)

**Severidad**: hard-fail si falta archivo obligatorio O aparece archivo/sub-dir vetado.

### Archivos obligatorios siempre

- `README.md` — único informe + índice + how-to-execute.
- `00-ROLLBACK.sql` — sólo si al menos una categoría 01-04 tiene contenido (si todo el corpus está vacío, no se escribe el bundle).

### Archivos por categoría (skip silencioso si vacío)

- `01-DDL-TABLES.sql` — sólo si hay sentencias `@category: 01` en el corpus.
- `02-DDL-FUNCTIONS.sql` — sólo si hay sentencias `@category: 02`.
- `03-DML.sql` — sólo si hay sentencias `@category: 03`.
- `04-INSERTS.sql` — sólo si hay sentencias `@category: 04`.

### Archivos condicionales

- `_queries/<sessionXXX>/` — sólo si la sesión origen tenía `queries/`.
- `por-tema/<slug>/` — sólo si `--themes` activado, `## Temas` declarado, o `--themes infer`.

### Archivos VETADOS (presencia → hard-fail)

Layout v3.x eliminado desde v4.0.0:
- `manifest.md` (absorbido por `README.md`).
- `ORDER.md` (absorbido por §4 del `README.md`).
- `rollback-global.sql` separado (reemplazado por `00-ROLLBACK.sql`).
- `por-sesion/` y todo su contenido (consolidación es cross-session al root).
- `<file>.rollback.sql` companions por sentencia (eliminado en sql-rollback-generator v2.0.0).
- `<session>/rollback/` sub-carpetas per-sesión (eliminado en sql-rollback-generator v2.0.0).

**Cómo validar**: listar el output dir antes de escribir el bundle final; verificar que (a) archivos obligatorios están presentes y (b) no aparece nada del set vetado.

**Error report (hard-fail)**:
```
V1 FAILED: estructura del bundle incompatible con v4.0.0
  esperado al root: README.md + 0X-*.sql (categorías con contenido)
  encontrado vetado: por-sesion/ (4 sub-carpetas), manifest.md, rollback-global.sql
  acción: el generador está produciendo layout v3.x — revisar export-scripts v4.0.0 + sql-rollback-generator v2.0.0
```

## V2 — Noise vetado + anti-redundancia v4.0.0

**Severidad**: hard-fail si hay ≥1 ocurrencia.

**Scope**: body-only del `README.md` — líneas después de `# Bundle export-scripts NNN` (h1 inicial) y antes de `## 10. Metadata`.

**Patrones vetados** (catálogo en `references/lexico-tecnico.md` + reglas anti-redundancia v4.0.0):

1. Placeholders sin reemplazar: `NNN`, `YYYY-MM-DD`, `[entre corchetes]`, `<placeholder>`.
2. Paths absolutos del developer: `/Users/`, `/home/`, `C:\\`.
3. Referencias residuales al layout v3.x dentro de prosa generada (no en bloques deprecation explicit):
   - `por-sesion/` en `## 4. Secuencia de ejecución` o `## 5. Rollback` (esos paths fueron eliminados).
   - `manifest.md` como recurso vigente del bundle (sólo válido si se cita el template DEPRECATED).
   - `ORDER.md` como archivo del bundle (eliminado).
   - `rollback-global.sql` como path activo (renombrado a `00-ROLLBACK.sql`).
   - `<file>.rollback.sql` companions.

**Cómo validar**:
```bash
awk '
  BEGIN { body=0 }
  /^## 10\. Metadata/ { body=0 }
  body { print }
  /^# / && !/Metadata/ { body=1 }
' README.md > /tmp/body.md
grep -n -F -f references/lexico-tecnico.md /tmp/body.md
# Plus anti-redundancia v4.0.0:
grep -nE 'por-sesion/|rollback-global\.sql|\.rollback\.sql|ORDER\.md|manifest\.md' /tmp/body.md
```

**Error report (hard-fail)**:
```
V2 FAILED: noise vetado / redundancia v3.x detectados en README.md
  ocurrencias:
    línea 12: "NNN-export-scripts-YYYY-MM-DD"  → placeholder sin reemplazar
    línea 28: "/Users/tacuchi/"                → path absoluto del developer
    línea 65: "por-sesion/session001-*/"       → layout v3.x deprecated
  total: 3 ocurrencias
  acción: completar render con paths v4.0.0 y stripear referencias legacy
```

## V3 — Secciones obligatorias del README único

**Severidad**: hard-fail si falta una sección obligatoria.

**Secciones obligatorias** (todas siempre presentes en `README.md`):

1. `## 1. Resumen ejecutivo`
2. `## 2. Sesiones incluidas`
3. `## 3. Acciones manuales previas a producción`
4. `## 4. Secuencia de ejecución (01 → 04)`
5. `## 5. Rollback (\`00-ROLLBACK.sql\`)`
6. `## 6. Código fuente — hallazgos del escaneo`
7. `## 7. Git y ramas`
8. `## 8. Documentación graduada`
9. `## 9. Checklist final de producción`
10. `## 10. Metadata`

**Cómo validar**:
```bash
grep -c '^## [0-9]\+\. ' README.md  # debe dar exactamente 10
```

**Error report (hard-fail)**:
```
V3 FAILED: secciones obligatorias faltantes
  esperadas: 10
  encontradas: 8
  faltantes: "## 5. Rollback (`00-ROLLBACK.sql`)", "## 9. Checklist final de producción"
  acción: regenerar README con secciones completas
```

## V4 — Secciones condicionales honored

**Severidad**: hard-fail si una sub-sección condicional aparece sin justificación o falta cuando debería estar.

### V4.a — Mapping por tema (`## 4.1 Mapping sesión ↔ tema ↔ scripts`)

- **Patrón A — `--themes` activado**: sub-sección `## 4.1 Mapping sesión ↔ tema ↔ scripts` presente con tabla de mapping.
- **Patrón B — sin temas**: sub-sección `## 4.1` **ausente** (no aparece header ni placeholder).

**Error report (Patrón B esperado pero sección presente sin contenido)**:
```
V4.a FAILED: sin temas declarados pero sección "## 4.1 Mapping" presente
  themes: []
  acción: omitir sección cuando no hay temas (no dejar placeholder)
```

### V4.b — Code scan skip (`## 6`)

- **Patrón A — escaneo ejecutado**: sección 6 contiene resumen con counts (`X críticos · Y medios · Z bajos`).
- **Patrón B — `--skip-code-scan`**: sección 6 contiene **nota inline explícita** `_(Escaneo omitido por --skip-code-scan)_` y no hay tabla de hallazgos.

**Error report (Patrón B esperado pero tabla presente)**:
```
V4.b FAILED: --skip-code-scan declarado pero sección 6 tiene tabla de hallazgos
  args: --skip-code-scan
  acción: reemplazar tabla por nota inline
```

### V4.c — Sesiones abiertas

- **Patrón A — sesiones cerradas**: tabla "## 2. Sesiones incluidas" sin warnings ⚠.
- **Patrón B — sesiones activas incluidas**: cada sesión activa marcada con ⚠ + motivo de apertura en la columna "Resumen".

**Error report (Patrón B sin ⚠)**:
```
V4.c FAILED: sesiones activas detectadas pero no marcadas con ⚠
  sesiones activas: session061
  acción: marcar con ⚠ en tabla y documentar motivo en columna Resumen
```

### V4.d — Categorías SQL vacías

- **Patrón A — categoría con contenido**: archivo `0X-*.sql` presente al root + referencia en §4 del README.
- **Patrón B — categoría vacía**: archivo `0X-*.sql` **ausente** + comando psql correspondiente **omitido** del bloque de §4 (no aparece línea con archivo inexistente).

**Error report (Patrón B con referencia)**:
```
V4.d FAILED: categoría 03-DML vacía pero referenciada en §4
  corpus_dml_count: 0
  archivo presente: false
  referencia README: línea 88 → "psql ... -f 03-DML.sql"
  acción: omitir comando psql cuando la categoría está vacía
```

## V5 — Header del README bien formado

**Severidad**: warning.

**Checks** (líneas 1-7 del `README.md`):

- Línea 1: `# Bundle export-scripts NNN — <YYYY-MM-DD>` con NNN reemplazado.
- Línea 3: `- **Rama actual:** \`<nombre-rama>\``
- Línea 4: `- **Rama destino:** \`certificacion\``
- Línea 5: `- **Sesiones incluidas:** <N>`
- Línea 6: `- **Readiness:** 🟢 verde | 🟡 amarillo | 🔴 rojo` (una sola opción seleccionada).
- Línea 7: `- **Generado por:** agent-workflow · skill \`export-scripts\` v4.0.0`

**Error report (warning)**:
```
V5 WARNING: header incompleto o malformado
  línea 1: OK
  línea 3: "- **Rama actual:** `<nombre-rama>`" → placeholder sin reemplazar
  acción: re-renderizar header con valores reales
  ¿continuar de todas formas? (s/n)
```

## V6 — Referencias resolubles

**Severidad**: warning.

**Checks**: cada link en cualquier sección del README apunta a un path existente en filesystem al momento de generar.

**Cómo validar**:
```bash
grep -Eo '`[^`]+\.(md|sql)`|\[.+?\]\([^)]+\)' README.md | \
  sed -E 's/^`(.+)`$/\1/; s/^\[.+?\]\((.+)\)$/\1/' | \
  while read p; do
    if [ ! -e "$p" ] && [ ! -e "<output_dir>/$p" ]; then echo "MISSING: $p"; fi
  done
```

**Excepción**: links a `docs/decisiones/`, `docs/manuales/`, etc. **fuera** del output dir son válidos si existen en el workspace; si no, warning suave (no aborta).

**Error report (warning)**:
```
V6 WARNING: 2 referencias apuntan a paths inexistentes
  - docs/decisiones/005-tipos-cobranza.md → no existe en workspace
  - 03-DML.sql                            → no existe en output dir (categoría vacía)
  acción sugerida: corregir paths u omitir referencias a categorías vacías
  ¿continuar de todas formas? (s/n)
```

## Orden de aplicación

1. V1 (estructura del bundle, anti-redundancia layout) — primero, barato.
2. V3 (secciones del README) — segundo, barato.
3. V2 (noise vetado + redundancia v3.x en prosa) — tercero, requiere lectura del body.
4. V4 (condicionales) — cuarto, requiere reconstruir contexto de flags + corpus.
5. V5 (header) — quinto.
6. V6 (referencias resolubles) — último.

Si V1, V3 o V4 fallan → abortar inmediatamente.
Si V2 falla → abortar (no warning, igual que en export-arq y export-report).
Si V5 o V6 emiten warning → pedir confirmación al usuario.

## Reporte consolidado

Al final del flujo, el skill devuelve:

```json
{
  "ok": true,
  "output_dir": "docs/scripts/NNN-export-scripts-YYYY-MM-DD/",
  "files_written": [
    "README.md",
    "00-ROLLBACK.sql",
    "01-DDL-TABLES.sql",
    "02-DDL-FUNCTIONS.sql",
    "04-INSERTS.sql",
    "por-tema/tema-rbac/01-DDL-TABLES.sql",
    "..."
  ],
  "categories_empty": ["03-DML"],
  "themes_resolved": ["rbac", "lista-negra-blanca"],
  "sessions_included": ["057", "058", "059", "060"],
  "validations": {
    "V1": { "status": "pass", "forbidden_artifacts": 0 },
    "V2": { "status": "pass", "noise_hits": 0, "v3_legacy_refs": 0 },
    "V3": { "status": "pass", "sections_found": 10 },
    "V4": { "status": "pass", "conditionals": { "mapping_tema": "presente (2 temas)", "code_scan": "ejecutado", "sesiones_abiertas": "0", "categorias_vacias": "1 (03-DML)" } },
    "V5": { "status": "pass" },
    "V6": { "status": "warning", "missing_refs": ["docs/decisiones/005-...md"] }
  },
  "summary": "Bundle escrito (layout v4.0.0). 1 warning (V6) aceptado."
}
```

Si hard-fail:

```json
{
  "ok": false,
  "stage": "validation",
  "failed_at": "V1",
  "details": "estructura v3.x detectada: por-sesion/ presente. El generador no debería emitir ese sub-dir desde v4.0.0.",
  "no_files_written": true
}
```

## Diferencias con `export-arq/references/validations.md`

| Validación | export-arq | export-scripts |
|---|---|---|
| V1 | estructura de secciones por `--scope` | estructura del bundle (archivos al root + sub-dirs opt-in) + anti-redundancia v4.0.0 |
| V2 | noise interno (~25 términos) | noise + placeholders + referencias residuales al layout v3.x |
| V3 | secciones por scope | 10 secciones fijas del README único |
| V4 | Modelo de datos + Decisiones condicionales | Mapping tema + code-scan skip + sesiones abiertas + categorías vacías |
| V5 | header con snapshot + fuentes + diagrams engine | header con rama + readiness + counts + versión skill |
| V6 | referencias resolubles | referencias resolubles (incl. archivos de categoría skipped) |
