# Validations — V1-V6 para `/agent-workflow:export-arq`

Checks post-render que se aplican antes de escribir el `.md` al filesystem. Adaptados desde `export-func/references/validations.md` con foco técnico: sin cota dura de palabras, sí estructura + presencia de diagramas C4 + decisiones rastreables.

Niveles de severidad:
- **Hard-fail**: aborta la escritura, devuelve `ok: false` con error report. No se crea el archivo.
- **Warning**: emite mensaje, pide confirmación del usuario para continuar.

## V1 — Estructura del documento

**Severidad**: hard-fail si faltan secciones obligatorias por `--scope`.

**Secciones por `--scope`**:

| `--scope` | Secciones obligatorias |
|---|---|
| `c4` | Resumen + Sistema + Contenedores (Componentes condicional) |
| `integraciones` | Resumen + Integraciones externas |
| `datos` | Resumen + Modelo de datos |
| `decisiones` | Resumen + Decisiones arquitectónicas |
| `riesgos` | Resumen + Riesgos y deuda |
| `todo` (default) | Resumen + Sistema + Contenedores + Integraciones + Modelo de datos (cond.) + Decisiones (cond.) + Riesgos + Referencias |

**Cómo validar**: extraer todos los `^# ` y `^## ` headers; verificar que los obligatorios están presentes.

**Error report (hard-fail)**:
```
V1 FAILED: estructura inválida
  scope: todo
  esperado: Sistema, Contenedores, Integraciones externas, Decisiones arquitectónicas, Riesgos y deuda
  encontrado: Sistema, Contenedores, Riesgos y deuda
  faltantes: Integraciones externas, Decisiones arquitectónicas
  acción: regenerar incluyendo las secciones faltantes
```

## V2 — Noise vetado

**Severidad**: hard-fail si hay ≥1 ocurrencia en el cuerpo (header y Referencias exentos).

**Scope**: body-only (líneas después del primer `# ` y antes de `# Referencias`).

**Cómo validar**:
```bash
awk '
  BEGIN { body=0 }
  /^# Referencias/ { body=0 }
  body { print }
  /^# / && !/Referencias/ { body=1 }
' output.md > /tmp/body.md
grep -n -F -f lexico-noise-vetado.txt /tmp/body.md
```

**Error report (hard-fail)**:
```
V2 FAILED: noise vetado detectado en cuerpo
  ocurrencias:
    línea 12: "{{PRODUCTO}}"     → placeholder sin reemplazar
    línea 28: "/Users/tacuchi/"   → path absoluto del developer
    línea 41: "DEC-NNN"           → placeholder sin reemplazar
  total: 3 ocurrencias
  acción: completar render y stripear paths absolutos
```

## V3 — Diagramas C4 presentes (cuando aplican)

**Severidad**: hard-fail si `--scope` incluye `c4` o `todo` Y no hay diagrama Structurizr/Mermaid/PlantUML detectable.

**Cómo validar** (orden por default v1.1):
- Para `--diagrams structurizr` (default): verificar existencia de `workspace.dsl` en el directorio output Y que `arquitectura.md` incluya el Mermaid auxiliar embebido (bloque ```mermaid``` con keywords `C4Context`/`C4Container`).
- Para `--diagrams mermaid`: buscar bloque ```mermaid``` con keywords `C4Context`/`C4Container`/`C4Component` en arquitectura.md (sin requerir `workspace.dsl`).
- Para `--diagrams plantuml`: verificar existencia de `arquitectura.puml` Y referencia en arquitectura.md.

**Link de visualización (v1.2 — session078)**: por cada bloque ```` ```mermaid ```` en `arquitectura.md`, debe seguir un blockquote `> Ver diagrama renderizado: <https://mermaid.ink/img/BASE64>` en la línea siguiente al fence de cierre. Si falta → warning `render_link: absent` para ese bloque (no hard-fail; corpus pre-v1.2 no lo tenía). NO aplica a `workspace.dsl` ni `arquitectura.puml`.

**Cuándo NO aplica V3**: `--scope c4` excluido (ej. `--scope decisiones`); el doc no requiere diagramas.

**Error report**:
```
V3 FAILED: diagrama C4 ausente
  scope: todo (incluye c4)
  diagrams: structurizr (default)
  buscado: workspace.dsl + bloque ```mermaid``` auxiliar con C4Context|C4Container
  encontrado: arquitectura.md sin Mermaid auxiliar; workspace.dsl ausente
  acción: regenerar el DSL + Mermaid auxiliar; al menos C4 Context + Container
```

## V4 — Secciones condicionales honored

**Severidad**: hard-fail si una sección condicional aparece sin justificación, o falta cuando debería estar.

### V4.a — Modelo de datos

- **Patrón A (preferente cuando MCP disponible)**: `--scope` ∈ {datos, todo} Y MCP configurado → sección presente con `erDiagram` + tabla de tamaños.
- **Patrón B (cuando MCP no disponible)**: `--scope` ∈ {datos, todo} pero MCP NO configurado → sección presente con **nota inline explícita** sustituyendo al diagrama. Header + nota inline es válido — no se requiere ausencia total de la sección.
- **Patrón C (omitida)**: `--scope` excluye `datos` → sección totalmente ausente (sin header).

**Detección de MCP**: presencia de variable de entorno `MCP_CERT_URL` / `MCP_PROD_URL`, O archivo `.mcp.json` con servers `<mcp-cert>`/`<mcp-prod>`.

**Detección de nota inline** (Patrón B): sección "Modelo de datos" contiene una de las cadenas: `_(MCP no configurado` / `_(MCP no disponible` (cursiva con paréntesis abierto y texto explícito).

**Error report (Patrón A esperado pero sección con nota inline o ausente)**:
```
V4.a FAILED: scope incluye datos, MCP configurado, pero sección no tiene erDiagram
  scope: todo
  mcp_detectado: .mcp.json con <mcp-cert>
  acción: incluir sección con erDiagram desde MCP
```

**Error report (Patrón C esperado pero sección presente)**:
```
V4.a FAILED: scope excluye datos pero sección "Modelo de datos" presente
  scope: c4
  acción: omitir sección (sin header) cuando scope no incluye datos
```

**Patrón B pasa silenciosamente**: si MCP no detectado y la nota inline está presente, V4.a OK.

### V4.b — Decisiones arquitectónicas

- **Aparece si**: `--scope` ∈ {decisiones, todo} Y count(DEC-NNN) > 0.
- **Omitido / nota si**: `--scope` excluye `decisiones`, O 0 DEC en corpus filtrado.

**Error report (caso A — sección con 0 decisiones)**:
```
V4.b FAILED: sección "Decisiones arquitectónicas" presente sin contenido
  corpus filtrado: 12 sesiones
  DEC encontradas: 0
  acción: omitir sección o reemplazar por nota inline "_(Sin decisiones DEC-NNN en el período filtrado)_"
```

## V5 — Header bien formado

**Severidad**: warning.

**Checks**:
- Línea 1: `# Arquitectura — <PRODUCTO>` con `<PRODUCTO>` reemplazado.
- Línea 2: `Snapshot del sistema al <FECHA>.` (fecha natural ES).
- Línea 3: `Fuentes incluidas: <lista>.`
- Línea 4: `Variante de diagrama: <engine>.`

**Error report (warning)**:
```
V5 WARNING: header incompleto
  línea 1: OK
  línea 2: "Snapshot del sistema al 2026-05-18." → formato esperado natural ES: "18 de mayo de 2026"
  acción: re-renderizar header con fecha natural
  ¿continuar de todas formas? (s/n)
```

## V6 — Referencias resolubles

**Severidad**: warning.

**Checks**: cada link en `# Referencias` apunta a un path existente en filesystem al momento de generar.

**Cómo validar**:
```bash
grep -E '^- [A-Za-z]+: ' references-section.md | \
  sed -E 's/^- [A-Za-z]+: //' | \
  while read p; do
    if [ ! -e "$p" ]; then echo "MISSING: $p"; fi
  done
```

**Error report (warning)**:
```
V6 WARNING: 2 referencias apuntan a paths inexistentes
  - docs/scripts/    → no existe (export-scripts aún no implementado)
  - docs/manuales/   → no existe (export-mt aún no implementado)
  acción sugerida: omitir referencias placeholder
  ¿continuar de todas formas? (s/n)
```

## Orden de aplicación

1. V1 (estructura) — primero, barato.
2. V2 (noise) — segundo, barato.
3. V3 (diagrama C4) — tercero, requiere parseo de bloques mermaid/dsl/puml.
4. V4 (condicionales) — cuarto, requiere consultar corpus + filesystem (MCP detect).
5. V5 (header) — quinto.
6. V6 (referencias resolubles) — último.

Si V1, V3 o V4 fallan → abortar inmediatamente.
Si V2 falla → abortar (no warning, igual que en export-func).
Si V5 o V6 emiten warning → pedir confirmación al usuario.

## Reporte consolidado

Al final del flujo, el skill devuelve:

```json
{
  "ok": true | false,
  "scope": "c4|integraciones|datos|decisiones|riesgos|todo",
  "diagrams": "structurizr|mermaid|plantuml",
  "output_dir": "docs/arquitectura/NNN-export-arq-YYYY-MM-DD/",
  "files_written": ["arquitectura.md", "workspace.dsl", "README.md"],
  "validations": {
    "V1": { "status": "pass", "sections_found": [...] },
    "V2": { "status": "pass", "noise_hits": 0 },
    "V3": { "status": "pass", "engine": "structurizr", "dsl_present": true, "mermaid_auxiliary": ["C4Context", "C4Container"], "render_links": { "C4Context": "present", "C4Container": "present" } },
    "V4": { "status": "pass", "conditionals": { "modelo_datos": "omitido (sin MCP)", "decisiones": "incluido (6 DEC)" } },
    "V5": { "status": "warning", "issues": ["fecha en formato ISO no natural"] },
    "V6": { "status": "warning", "missing_refs": ["docs/scripts/", "docs/manuales/"] }
  },
  "summary": "Output escrito. 2 warnings (V5/V6) aceptados."
}
```

Si algún hard-fail:

```json
{
  "ok": false,
  "stage": "validation",
  "failed_at": "V3",
  "details": "diagrama C4 ausente con scope=todo y diagrams=mermaid",
  "no_files_written": true
}
```

## Diferencias con `export-func/references/validations.md`

| Validación | export-func | export-arq |
|---|---|---|
| V1 | cota dura de palabras | estructura de secciones |
| V2 | léxico ejecutivo vetado (~75 términos) | noise interno (~25 términos) |
| V3 | secciones obligatorias en orden | diagrama C4 presente (cuando aplica) |
| V4 | Recomendaciones condicional (1 caso) | Modelo de datos + Decisiones condicionales (2 casos) |
| V5 | header con período en formato natural | header con snapshot + fuentes + diagrams engine |
| V6 | referencias resolubles | referencias resolubles |
