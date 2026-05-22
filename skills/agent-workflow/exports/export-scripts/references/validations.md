# Validations — V1-V6 para `/agent-workflow:export-scripts`

Checks post-render que se aplican antes de escribir el bundle al filesystem. Adaptados del canon de la familia export-* (export-arq + export-report) con foco en bundle SQL + informe.

Niveles de severidad:
- **Hard-fail**: aborta la escritura, devuelve `ok: false` con error report. No se crea el directorio.
- **Warning**: emite mensaje, pide confirmación del usuario para continuar.

## V1 — Estructura del bundle

**Severidad**: hard-fail si falta archivo obligatorio o sub-dir esperado.

**Archivos obligatorios siempre**:
- `manifest.md`
- `README.md`
- `ORDER.md`
- `rollback-global.sql`
- `por-sesion/` con ≥1 sesión

**Archivos condicionales**:
- `por-tema/` con ≥1 tema — sólo si la activación de Paso 6 dio positivo (themes declarados, `## Temas` en OBJECTIVE, o `--themes infer`).

**Cómo validar**: listar el output dir antes de escribir el manifest final; verificar que todos los archivos obligatorios estarán presentes.

**Error report (hard-fail)**:
```
V1 FAILED: bundle incompleto
  esperado: manifest.md, README.md, ORDER.md, rollback-global.sql, por-sesion/
  encontrado: manifest.md, README.md, por-sesion/
  faltantes: ORDER.md, rollback-global.sql
  acción: regenerar pasos 7 y 9
```

## V2 — Noise vetado

**Severidad**: hard-fail si hay ≥1 ocurrencia en el cuerpo del `manifest.md` (header y sección Metadata exentos).

**Scope**: body-only — líneas después de `# Informe del bundle NNN` (h1 inicial) y antes de `## 10. Metadata`.

**Cómo validar**:
```bash
awk '
  BEGIN { body=0 }
  /^## 10\. Metadata/ { body=0 }
  body { print }
  /^# / && !/Metadata/ { body=1 }
' manifest.md > /tmp/body.md
grep -n -F -f references/lexico-tecnico.md /tmp/body.md
```

**Error report (hard-fail)**:
```
V2 FAILED: noise vetado detectado en cuerpo del manifest
  ocurrencias:
    línea 12: "NNN-export-scripts-YYYY-MM-DD"  → placeholder sin reemplazar
    línea 28: "/Users/tacuchi/"                → path absoluto del developer
    línea 41: "DEC-NNN"                        → placeholder sin reemplazar
  total: 3 ocurrencias
  acción: completar render y stripear paths absolutos
```

## V3 — Secciones obligatorias del manifest

**Severidad**: hard-fail si falta una sección obligatoria.

**Secciones obligatorias** (todas siempre presentes en `manifest.md`):
1. `## 1. Resumen ejecutivo`
2. `## 2. Sesiones incluidas`
3. `## 3. Acciones manuales previas a producción`
4. `## 4. Base de datos`
5. `## 5. Código fuente — hallazgos del escaneo`
6. `## 6. Git y ramas`
7. `## 7. Documentación graduada`
8. `## 8. Checklist final de producción`
9. `## 9. Advertencias`
10. `## 10. Metadata`

**Cómo validar**:
```bash
grep -c '^## [0-9]\+\. ' manifest.md  # debe dar exactamente 10
```

**Error report (hard-fail)**:
```
V3 FAILED: secciones obligatorias faltantes
  esperadas: 10
  encontradas: 8
  faltantes: "## 5. Código fuente — hallazgos del escaneo", "## 9. Advertencias"
  acción: regenerar manifest con secciones completas
```

## V4 — Secciones condicionales honored

**Severidad**: hard-fail si una sub-sección condicional aparece sin justificación o falta cuando debería estar.

### V4.a — Vista por tema (`## 4.4 Vista por tema`)

- **Patrón A — activada**: temas declarados (CLI flag o `## Temas`) → sub-sección `## 4.4 Vista por tema` presente con conteo + paths a `por-tema/`.
- **Patrón B — no activada**: sin temas → sub-sección `## 4.4 Vista por tema` **ausente** (no aparece header ni placeholder).

**Error report (Patrón B esperado pero sección presente sin contenido)**:
```
V4.a FAILED: sin temas declarados pero sección "## 4.4 Vista por tema" presente
  themes: []
  acción: omitir sección cuando no hay temas (no dejar placeholder)
```

### V4.b — Code scan skip (`## 5`)

- **Patrón A — escaneo ejecutado**: sección 5 contiene resumen con counts (`X críticos · Y medios · Z bajos`).
- **Patrón B — `--skip-code-scan`**: sección 5 contiene **nota inline explícita** `_(Escaneo omitido por --skip-code-scan)_` y no hay tabla de hallazgos.

**Error report (Patrón B esperado pero tabla presente)**:
```
V4.b FAILED: --skip-code-scan declarado pero sección 5 tiene tabla de hallazgos
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

## V5 — Header bien formado

**Severidad**: warning.

**Checks** (líneas 1-5 del `manifest.md`):
- Línea 1: `# Informe del bundle NNN — <YYYY-MM-DD>` con NNN reemplazado.
- Línea 3: `- **Rama actual:** \`<nombre-rama>\``
- Línea 4: `- **Rama destino:** \`certificacion\``
- Línea 5: `- **Sesiones incluidas:** <N>`
- Línea 6: `- **Readiness:** 🟢 verde | 🟡 amarillo | 🔴 rojo` (una sola opción seleccionada).
- Línea 7: `- **Generado por:** agent-workflow · skill \`export-scripts\``

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

**Checks**: cada link en cualquier sección del manifest apunta a un path existente en filesystem al momento de generar.

**Cómo validar**:
```bash
grep -Eo '`[^`]+\.(md|sql)`|\[.+?\]\([^)]+\)' manifest.md | \
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
  - por-sesion/session999/01-ddl-tablas/  → no existe en output dir
  acción sugerida: corregir paths o omitir referencias placeholder
  ¿continuar de todas formas? (s/n)
```

## Orden de aplicación

1. V1 (estructura del bundle) — primero, barato.
2. V3 (secciones del manifest) — segundo, barato.
3. V2 (noise vetado) — tercero, requiere lectura del body.
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
    "manifest.md", "README.md", "ORDER.md", "rollback-global.sql",
    "por-sesion/session057-export-func/...",
    "por-sesion/session058-export-arq/...",
    "por-tema/tema-rbac/01-ddl-tablas.sql",
    "..."
  ],
  "themes_resolved": ["rbac", "lista-negra-blanca"],
  "sessions_included": ["057", "058", "059", "060"],
  "validations": {
    "V1": { "status": "pass" },
    "V2": { "status": "pass", "noise_hits": 0 },
    "V3": { "status": "pass", "sections_found": 10 },
    "V4": { "status": "pass", "conditionals": { "por_tema": "presente (2 temas)", "code_scan": "ejecutado", "sesiones_abiertas": "0" } },
    "V5": { "status": "pass" },
    "V6": { "status": "warning", "missing_refs": ["docs/decisiones/005-...md"] }
  },
  "summary": "Bundle escrito. 1 warning (V6) aceptado."
}
```

Si hard-fail:

```json
{
  "ok": false,
  "stage": "validation",
  "failed_at": "V3",
  "details": "secciones obligatorias faltantes: ## 5. Código fuente — hallazgos del escaneo",
  "no_files_written": true
}
```

## Diferencias con `export-arq/references/validations.md`

| Validación | export-arq | export-scripts |
|---|---|---|
| V1 | estructura de secciones por `--scope` | estructura del bundle (archivos + sub-dirs) |
| V2 | noise interno (~25 términos) | noise + placeholders (~45 términos) |
| V3 | secciones por scope | 10 secciones fijas del manifest |
| V4 | Modelo de datos + Decisiones condicionales | Vista por tema + code-scan skip + sesiones abiertas |
| V5 | header con snapshot + fuentes + diagrams engine | header con rama + readiness + counts |
| V6 | referencias resolubles | referencias resolubles |
