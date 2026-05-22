# Validations — V1-V6 para `/agent-workflow:export-report`

Checks post-render que se aplican antes de escribir el `.md` al filesystem. Heredan de `docs/especificaciones/001-export-report-format/DELIVERY.md §"Validation criteria"`.

Niveles de severidad:
- **Hard-fail**: aborta la escritura, devuelve `ok: false` con error report. No se crea el archivo.
- **Warning**: emite mensaje, pide confirmación del usuario para continuar. Si confirma → escribe.

## V1 — Cota de palabras

**Severidad**: hard-fail si excede +20% de la cota; warning si excede ±10%.

**Cotas por variante** (v1.1: B y C subieron por Componentes impactados; A sin cambio; v1.4 session079: tolerancia condicional en C):

| Variante | Cota nominal | Warning fuera de | Hard fail |
|---|---|---|---|
| A — Compacta | 400w | 360-440w | >480w o <320w |
| B — Media (default v1.1) | 760w | 684-836w | >912w o <608w |
| C — Extensa (v1.1) | 1620w | 1458-1782w | >1944w o <1296w |

**Tolerancia condicional en C (v1.4 — DEC-005 session079)**: cuando V4 omite "Oportunidades de mejora" en C (corpus sin items abiertos), la ventana efectiva de warning se desplaza a **1323-1617w** (1470w nominal ±10%). Razón: los pesos C sin Op suman 1470w (no 1620w); la ventana original generaba warnings de borde sin valor. La cota de hard fail sigue siendo 1296w (low) — la tolerancia condicional solo afecta el rango warning. A y B mantienen ventana fija (sus deltas con/sin Op son menores).

**Cómo contar**:

Word count canónico = `wc -w` sobre el `.md` puro tras stripear:
- Bloque de Referencias (no cuenta).
- Front-matter YAML si existe (no cuenta).
- Comentarios HTML `<!-- ... -->` (no cuentan).
- Code fences ```...``` (no cuentan, salvo que el diagrama opt-in incluido se considere texto representativo — decisión del render).

Comando referencial:
```bash
awk '
  /^# Referencias/ { skip=1 }
  /^---$/ { yaml = !yaml; next }
  /^<!--/ { hc=1 }
  /-->$/ { hc=0; next }
  /^```/ { cf = !cf; next }
  !skip && !yaml && !hc && !cf { print }
' output.md | wc -w
```

**Error report (hard-fail)**:
```
V1 FAILED: cota excedida
  variante: B
  cota nominal: 760w (±10% warning, ±20% hard fail)
  cota actual: 951w
  excedente: +191w (+25%)
  acción: comprimir secciones {{LOGROS}}, {{OBJETIVO}} o {{ALCANCES}}
```

## V2 — Léxico vetado

**Severidad**: hard-fail si hay ≥1 ocurrencia en el **cuerpo** (header y Referencias exentos).

**Lista vetada**: ver `lexico.md` §"Lista vetada (V2 — para grep determinista)".

**Scope de V2**: desde la línea inmediatamente siguiente al primer header `# ` hasta la línea inmediatamente anterior a `# Referencias`. Quedan **fuera del scope**:
- Header del documento (líneas antes del primer `# `): contiene el nombre del producto provisto por AW-PROJECT, que puede legítimamente incluir identificadores del equipo (ej. "RUNTIME QTC-*"). El nombre del producto no es jerga — es el título.
- Sección `# Referencias`: contiene paths a `docs/<categoria>/` que son ineludibles.

**Cómo validar**:

```bash
# Strippear header (antes del primer #) y sección Referencias
awk '
  BEGIN { body=0 }
  /^# Referencias/ { body=0 }
  body { print }
  /^# / && !/Referencias/ { body=1 }
' output.md > /tmp/body.md

# grep contra cada término de la lista vetada (fixed strings, case-insensitive).
# -F (fixed strings) captura compuestos como `flow=dev` y `<mcp-cert>` que
# `-w` (word boundary) descartaría por contener caracteres no-palabra.
grep -i -n -F -f lexico-vetado.txt /tmp/body.md
```

Salida vacía → V2 pasa. Salida con matches → V2 falla.

**Nota de implementación**: `lexico-vetado.txt` es un archivo de una palabra/término por línea derivado de la "Lista vetada (V2)" de `lexico.md`. Como es fixed-string match, los términos genéricos cortos (≤3 caracteres) se descartan de la lista para evitar falsos positivos; los términos vetados elegidos son distintivos técnicos (`commits`, `skill`, `<mcp-cert>`, `flow=dev`, `Codex`, etc.) que no aparecen naturalmente en español ejecutivo.

**Excepción adicional**: el patrón fijo `\bN sesiones trabajadas\b` en el header (cuando se cuela en cuerpo por alguna razón) NO cuenta como violación.

**Error report (hard-fail)**:
```
V2 FAILED: léxico vetado detectado en cuerpo
  ocurrencias:
    línea 12: "...commits aplicados..."  → reemplazar por "cambios aplicados"
    línea 28: "...flow=dev..."           → reemplazar por "trabajo de implementación"
    línea 41: "...skill..."              → reemplazar por "componente del sistema"
  total: 3 ocurrencias
  acción: aplicar tabla de traducción de lexico.md y re-renderizar
```

## V3 — Secciones obligatorias presentes en orden + motor del diagrama

**Severidad**: hard-fail si falta alguna sección obligatoria; hard-fail si el orden está mal. Warning si el motor del diagrama no es Mermaid en B/C (v1.2 default).

**Secciones obligatorias por variante** (v1.1: B y C extendidas con Objetivo (reubicado desde Finalidades), Componentes impactados y Diagrama de flujo; rename Recomendaciones→Oportunidades de mejora):

| Variante | Secciones obligatorias (orden) |
|---|---|
| A | `# Resumen`, `# Cambios`, `# Riesgos`, `# Referencias` (4 — más `# Oportunidades de mejora` condicional) |
| B (default v1.1) | `# Resumen ejecutivo`, `# Período cubierto`, `# Objetivo`, `# Logros del período`, `# Componentes impactados`, `# Diagrama de flujo`, `# Alcances / Límites`, `# Riesgos y deuda`, `# Referencias` (9 — más `# Oportunidades de mejora` condicional) |
| C (v1.1) | `# Resumen ejecutivo`, `# Contexto del período`, `# Objetivo`, `# Cambios por capacidad`, `# Componentes impactados`, `# Diagrama de flujo`, `# Alcances`, `# Límites`, `# Riesgos y deuda`, `# Referencias` (10 obligatorias — más `# Oportunidades de mejora` condicional) |

**Motor del diagrama (v1.2)**: dentro de `# Diagrama de flujo` (B/C), el code fence debe ser ` ```mermaid ` con contenido `flowchart` o `graph` por default. Si es plain code fence con ASCII, se emite warning (`engine: ascii (fallback)`) en lugar de hard-fail — ASCII es válido como fallback opt-in.

**Link de visualización (v1.3 — session078)**: cuando engine=mermaid, inmediatamente después del fence de cierre debe aparecer un blockquote con `> Ver diagrama renderizado: <https://mermaid.ink/img/BASE64>`. Si falta → warning `render_link: absent` (no hard-fail; corpus pre-v1.3 no lo tenía). Si engine=ascii → skip el check (ASCII no lleva link).

**Cómo validar**: extraer todos los `^# ` headers del output, verificar que la lista incluye los obligatorios en el orden esperado. Dentro de la sección `# Diagrama de flujo`, parsear el primer code fence: si abre con ` ```mermaid ` → engine=mermaid (pass); si abre con ` ``` ` plano → engine=ascii (warning). Si engine=mermaid, buscar el blockquote `> Ver diagrama renderizado:` en la línea siguiente al fence de cierre — si presente, `render_link: present`; si ausente, `render_link: absent` (warning).

**Error report**:
```
V3 FAILED: estructura de secciones inválida
  variante: B
  esperado: Resumen ejecutivo → Período cubierto → Objetivo → Logros del período → Componentes impactados → Diagrama de flujo → Alcances / Límites → Riesgos y deuda → [Oportunidades de mejora?] → Referencias
  encontrado: Resumen ejecutivo → Logros del período → Objetivo → Alcances / Límites → Riesgos y deuda → Referencias
  faltantes: Período cubierto, Componentes impactados, Diagrama de flujo
  orden incorrecto: Objetivo debe ir antes de Logros del período
  acción: regenerar incluyendo todas las secciones obligatorias en el orden correcto
```

## V4 — "Oportunidades de mejora" condicional honored

**Severidad**: hard-fail si la sección aparece sin justificación en el corpus, o si falta cuando el corpus la justifica.

v1.1 (session076): renombrada desde "Recomendaciones / próximos pasos" para alinear con el formato ejecutivo. La lógica de detección NO cambia — los corpus existentes mantienen `## Recommendations` / `## Recomendaciones` como header en CONCLUSIONS.md (sin migración forzada).

**Condiciones de aparición** (al menos UNA debe matchear en el corpus filtrado):

- ≥1 item en sección `## Open (gaps)` de algún `CONCLUSIONS.md` del corpus.
- ≥1 item en sección `## Recommendations` / `## Recomendaciones` de algún `CONCLUSIONS.md`.
- ≥1 decision con texto "pendiente" / "diferido" / "TODO" en `DECISIONS.md` del corpus.
- ≥1 mención a "próximos pasos" / "futuras mejoras" / "oportunidades" / "queda pendiente" en `CHECKPOINT.md` o `CONCLUSIONS.md` del corpus.

**Cómo validar**: pre-render — count de matches en el corpus filtrado.
- `count > 0` → render debe incluir `# Oportunidades de mejora`.
- `count == 0` → render debe NO incluir ese encabezado.

Post-render: verificar consistencia.

**Error report (caso A — sección presente sin justificación)**:
```
V4 FAILED: sección "Oportunidades de mejora" presente pero corpus filtrado no tiene items abiertos
  corpus inspeccionado: 12 sesiones (período: last-month)
  open gaps detectados: 0
  recommendations detectadas: 0
  decisions pendientes: 0
  menciones "próximos pasos / oportunidades": 0
  acción: omitir sección o ajustar detector
```

**Error report (caso B — sección omitida pero corpus la justifica)**:
```
V4 FAILED: corpus filtrado tiene items abiertos pero sección "Oportunidades de mejora" omitida
  corpus inspeccionado: 12 sesiones (período: last-month)
  open gaps detectados: 3 (en sessionXXX, sessionYYY, sessionZZZ)
  decisions pendientes: 1 (DEC-014 en sessionWWW)
  acción: incluir sección con los items detectados
```

## V5 — Header bien formado

**Severidad**: warning (no bloquea — el usuario puede aceptar).

**Checks**:
- Línea 1 contiene `{{PRODUCTO}} — Informe ejecutivo` con `{{PRODUCTO}}` reemplazado por valor real (no literal).
- Línea 2 contiene `Período: Del <DD> de <mes> al <DD> de <mes> de <YYYY>. <N> sesiones trabajadas.`
- Fecha en formato natural ES (no `2026-05-18`).
- Si variante C: línea 3 contiene `Audiencia: Comité de seguimiento`.

**Error report (warning)**:
```
V5 WARNING: header incompleto o mal formado
  línea 1: OK
  línea 2: "Período: 2026-05-08 a 2026-05-18 (55 sesiones)"
           → formato esperado: "Del 8 de mayo al 18 de mayo de 2026. 55 sesiones trabajadas."
  acción sugerida: re-renderizar header con formato natural ES
  ¿continuar de todas formas? (s/n)
```

## V6 — Referencias resolubles

**Severidad**: warning (no bloquea).

**Checks**: cada link en la sección `# Referencias` apunta a un path existente en filesystem al momento de la generación.

**Cómo validar**:
```bash
grep -E '^- [A-Za-z]+:' references-section.md | \
  sed -E 's/^- [A-Za-z]+: //' | \
  while read p; do
    if [ ! -e "$p" ]; then echo "MISSING: $p"; fi
  done
```

**Error report (warning)**:
```
V6 WARNING: 2 referencias apuntan a paths inexistentes
  - docs/arquitectura/NNN-export-arq-YYYY-MM-DD/  → no existe (export-arq aún no generado)
  - docs/manuales/NNN-export-mt-YYYY-MM-DD/       → no existe (export-mt aún no generado)
  acción sugerida: omitir referencias placeholder o regenerar tras producir export-arq y export-mt
  ¿continuar de todas formas? (s/n)
```

## Orden de aplicación

1. V1 (cota) — primero, barato (word count).
2. V2 (léxico) — segundo, barato (grep).
3. V3 (secciones) — tercero, barato (regex headers).
4. V4 (oportunidades de mejora condicional) — cuarto, requiere consultar corpus.
5. V5 (header) — quinto.
6. V6 (referencias resolubles) — último.

Si V1, V3 o V4 fallan → abortar inmediatamente. No correr el resto.
Si V2 falla → abortar (no warning).
Si V5 o V6 emiten warning → mostrar al usuario y pedir confirmación.

## Reporte consolidado

Al final del flujo, el skill devuelve:

```json
{
  "ok": true | false,
  "variant": "A" | "B" | "C",
  "output_path": "docs/funcional/NNN-export-report-YYYY-MM-DD.md",
  "word_count": 681,
  "word_target": 700,
  "validations": {
    "V1": { "status": "pass", "actual": 681, "target": 700, "tolerance_pct": 10 },
    "V2": { "status": "pass", "vetoed_hits": 0 },
    "V3": { "status": "pass", "sections_found": ["Resumen ejecutivo","Período cubierto","Objetivo","Logros del período","Componentes impactados","Diagrama de flujo","Alcances / Límites","Riesgos y deuda","Oportunidades de mejora","Referencias"], "diagram_engine": "mermaid", "render_link": "present" },
    "V4": { "status": "pass", "section_included": true, "trigger_count": 7 },
    "V5": { "status": "warning", "issues": ["línea 2 con formato no-natural"] },
    "V6": { "status": "warning", "missing_refs": ["docs/arquitectura/..."] }
  },
  "summary": "Output escrito. 2 warnings (V5/V6) aceptados por el usuario."
}
```

Si algún hard-fail:

```json
{
  "ok": false,
  "stage": "validation",
  "failed_at": "V2",
  "details": "léxico vetado detectado en cuerpo: 3 ocurrencias (commits, flow=dev, skill)",
  "no_file_written": true
}
```
