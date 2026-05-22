# Validations — V1-V6 para `/agent-workflow:export-tech-manuals`

Checks post-render que se aplican antes de escribir output al filesystem. Reglas adaptadas a los **2 modos** del comando (`complementar` y `regenerar`).

Niveles de severidad:
- **Hard-fail**: aborta la escritura, devuelve `ok: false` con error report. No se crea el archivo.
- **Warning**: emite mensaje, pide confirmación del usuario.

## V1 — Estructura por modo

**Severidad**: hard-fail si faltan secciones obligatorias del modo activo.

**Modo `complementar`** (output = `INDEX.md`):
Secciones obligatorias en orden:
1. `# Manuales técnicos — <PRODUCTO>` (header con título)
2. `## Manuales graduados`
3. `## Temas sin graduar detectables` (condicional — V4)
4. `## Próximos pasos sugeridos` (condicional — V4)
5. `## Cómo refrescar este índice`

**Modo `regenerar`** (output = N archivos en dossier):
Cada archivo `.md` del dossier debe tener:
1. `# <TITULO_MANUAL>` (header)
2. `## Propósito`
3. `## Pre-requisitos`
4. `## Pasos`
5. `## Validación post-uso`
6. `## Troubleshooting`
7. `## Referencias`

Adicionalmente, el dossier debe tener un `README.md` con índice de los manuales generados.

**Error report (hard-fail)**:
```
V1 FAILED: estructura inválida
  modo: regenerar
  archivo: 01-configurar-mcp.md
  esperado: Propósito, Pre-requisitos, Pasos, Validación post-uso, Troubleshooting, Referencias
  encontrado: Propósito, Pre-requisitos, Pasos, Referencias
  faltantes: Validación post-uso, Troubleshooting
  acción: regenerar el manual incluyendo las secciones faltantes
```

## V2 — Noise vetado

**Severidad**: hard-fail si hay ≥1 ocurrencia en el cuerpo (header y `## Referencias` exentos).

**Scope**: body-only (después del primer `## ` y antes de `## Referencias`).

**Lista vetada**: ver `lexico-tecnico.md` §"Lista vetada".

**Cómo validar**:
```bash
awk '
  BEGIN { body=0 }
  /^## Referencias/ { body=0 }
  body { print }
  /^## / && !/Referencias/ { body=1 }
' output.md > /tmp/body.md
grep -n -F -f lexico-noise-vetado.txt /tmp/body.md
```

**Error report (hard-fail)**:
```
V2 FAILED: noise vetado detectado
  archivo: 02-crear-sesion.md
  ocurrencias:
    línea 12: "{{PASO_1}}"       → placeholder sin reemplazar
    línea 19: "/Users/tacuchi/"  → path absoluto del developer
    línea 28: "TODO:"            → marker WIP no resuelto
  total: 3 ocurrencias
  acción: completar render y stripear paths absolutos
```

## V3 — Secciones de `template-manual.md` (sólo modo regenerar)

**Severidad**: hard-fail si un archivo del dossier no tiene las 6 secciones obligatorias del template-manual.

**No aplica en modo complementar** (V1 ya cubre las secciones del INDEX).

**Cómo validar**: por cada archivo `.md` del dossier (excluyendo `README.md`), extraer `^## ` headers; verificar Propósito + Pre-requisitos + Pasos + Validación post-uso + Troubleshooting + Referencias presentes.

**Error report**:
```
V3 FAILED: archivo del dossier sin secciones obligatorias
  archivo: docs/manuales/NNN-export-tech-manuals-YYYY-MM-DD/01-configurar-mcp.md
  faltantes: ## Validación post-uso, ## Troubleshooting
  acción: regenerar el manual
```

## V4 — Condicionales por modo

**Severidad**: hard-fail si no se honra la condición.

### V4.a — Modo complementar + 0 manuales graduados

- **Comportamiento esperado**: tabla "Manuales graduados" presente con una fila informativa `_Sin manuales graduados en este workspace todavía._`. No fila vacía, no encabezado solo.
- **Comportamiento esperado para "Temas sin graduar"**: si 0 temas detectables → omitir la sección completa.
- **Comportamiento esperado para "Próximos pasos"**: omitido si 0 temas no graduados.

### V4.b — Modo regenerar + 0 temas detectables

- **Comportamiento esperado**: abortar con `ok: false`. No producir dossier vacío.
- **Error report**:
```
V4.b FAILED: modo regenerar sin temas detectables
  filtros aplicados: --temas <ninguno>, --source <ninguno>, --since <ninguno>
  corpus: 12 sesiones cerradas
  temas detectados: 0
  acción: ajustar filtros o pasar `--temas slug1` explícito; o pasar a modo `complementar` para reflejar el estado vacío
```

### V4.c — Modo regenerar + dossier con ≥1 manual

- **Comportamiento esperado**: el dossier `NNN-export-tech-manuals-YYYY-MM-DD/` contiene un `README.md` + ≥1 archivo `.md` adicional (un manual). Si solo hay README → fail.

## V5 — Header bien formado

**Severidad**: warning.

**Checks**:
- Modo `complementar`: línea 1 contiene `# Manuales técnicos — <PRODUCTO>` con producto resuelto.
- Modo `regenerar`: cada archivo del dossier tiene línea 1 con `# <TITULO_MANUAL>` (no literal `{{TITULO_MANUAL}}`).

**Error report (warning)**:
```
V5 WARNING: header de un manual incompleto
  archivo: 03-migrar-legacy.md
  línea 1: "# {{TITULO_MANUAL}}"
  acción sugerida: completar el placeholder
```

## V6 — Referencias resolubles

**Severidad**: warning.

**Checks**: cada link en `## Referencias` de cada manual / del INDEX apunta a un path existente.

**Cómo validar**:
```bash
grep -oE '`[^`]+\.md`|`[^`]+\.json`|`docs/[^`]+`' output.md | tr -d '`' | \
  while read p; do
    if [ ! -e "$p" ]; then echo "MISSING: $p"; fi
  done
```

**Error report (warning)**:
```
V6 WARNING: 1 referencia apunta a path inexistente
  archivo: 01-configurar-mcp.md
  - docs/conclusiones/004-audit-test.md → no existe en filesystem
  acción sugerida: revisar el link o eliminar la referencia
```

## Orden de aplicación

1. V1 (estructura) — primero, barato.
2. V2 (noise) — segundo, barato.
3. V3 (secciones de template-manual, sólo regenerar) — tercero.
4. V4 (condicionales) — cuarto.
5. V5 (header) — quinto.
6. V6 (referencias resolubles) — último.

Si V1, V3 o V4 fallan → abortar inmediatamente.
Si V2 falla → abortar.
Si V5 o V6 emiten warning → pedir confirmación al usuario.

## Reporte consolidado

```json
{
  "ok": true | false,
  "mode": "complementar" | "regenerar",
  "output_paths": ["docs/manuales/INDEX.md"]  // o ["docs/manuales/NNN-.../README.md", "...01-...md", ...]
  "manuales_graduados_count": 3,
  "temas_no_graduados_count": 5,
  "manuales_generados_count": 0,  // sólo aplica a regenerar
  "validations": {
    "V1": { "status": "pass", "sections_found_per_file": {...} },
    "V2": { "status": "pass", "noise_hits": 0 },
    "V3": { "status": "pass" | "n/a", "details": "..." },
    "V4": { "status": "pass", "conditionals": { "manuales_graduados": "fila informativa OK", "temas_no_graduados": "sección presente con 5 temas", "proximos_pasos": "presente (5 temas)" } },
    "V5": { "status": "warning", "issues": [...] },
    "V6": { "status": "warning", "missing_refs": [...] }
  },
  "summary": "INDEX.md sobrescrito; 3 graduados + 5 temas no-graduados detectables."
}
```

Si hard-fail:

```json
{
  "ok": false,
  "stage": "validation",
  "failed_at": "V4.b",
  "details": "modo regenerar sin temas detectables",
  "no_files_written": true
}
```

## Diferencias con los validations hermanos

| Validación | `export-tech-manuals` | `export-arq` | `export-report` |
|---|---|---|---|
| V1 | estructura por modo (INDEX vs dossier) | estructura de secciones por scope | cota dura de palabras |
| V2 | noise mínimo (~30) | noise mínimo (~25) | léxico ejecutivo (~75) |
| V3 | secciones por manual (sólo regenerar) | diagrama C4 presente | secciones obligatorias en orden |
| V4 | condicionales por modo (3 sub-casos) | condicionales (2 sub-casos) | "Recomendaciones" condicional (1 caso) |
| V5 | header del INDEX o del manual | header arq con snapshot+fuentes+diagrams | header con período natural |
| V6 | referencias resolubles | referencias resolubles | referencias resolubles |
