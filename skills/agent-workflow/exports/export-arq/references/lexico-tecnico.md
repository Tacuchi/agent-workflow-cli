# Léxico técnico — limpieza mínima de noise para export-arq

A diferencia de `export-func/references/lexico.md` (que traduce técnico→ejecutivo para audiencia gerencial), este léxico es **mínimo**: la audiencia de `export-arq` es técnica (devs/arquitectos) y los términos técnicos son bienvenidos. Sólo se veta el "noise" interno no profesional.

## Lista vetada (V2 — para grep determinista)

Términos / patrones que **no deben aparecer** en el cuerpo del output (excepto en `## Referencias`):

```
{{
}}
<-- TODO
<-- FIXME
<-- WIP
<-- XXX
{{PRODUCTO}}
{{FECHA
{{C4_CONTEXT
{{C4_CONTAINER
{{C4_COMPONENT
{{INTEGRACIONES
{{MODELO_DATOS
{{DECISIONES
{{RIESGOS
{{REFERENCIAS
{{RESUMEN
{{LISTA_FUENTES
{{DIAGRAMS_ENGINE
sessionXXX
sessionYYY
sessionNNN
DEC-NNN
NNN-export
YYYY-MM-DD
/Users/
~/Git/
TODO:
FIXME:
WIP:
XXX:
HACK:
```

**Qué busca esta lista**:
- **Placeholders no reemplazados** (`{{...}}`, `sessionXXX`, `DEC-NNN`, `NNN-export`, `YYYY-MM-DD`): indica fallo del render.
- **Fragmentos de plantilla** (`<-- TODO`, `<-- FIXME`, comentarios HTML que debían stripearse): noise residual.
- **Paths absolutos del developer** (`/Users/`, `~/Git/`): no son útiles para el lector y filtran info local.
- **Markers de "WIP"** (TODO/FIXME/HACK con dos puntos): si quedaron en el doc final, V2 los marca como noise.

**Excepciones autorizadas** (V2 las exime):
- La sección `## Referencias` puede contener placeholders esperados (ej. `docs/arquitectura/NNN-...` como path tipo).
- El header puede contener identificadores del producto que sean canónicos (ej. "agent-workflow").

## Cómo validar

```bash
# Strippear header (antes del primer #) y sección Referencias
awk '
  BEGIN { body=0 }
  /^# Referencias/ { body=0 }
  body { print }
  /^# / && !/Referencias/ { body=1 }
' output.md > /tmp/body.md

# grep contra la lista vetada (fixed strings, case-sensitive para placeholders).
grep -n -F -f lexico-noise-vetado.txt /tmp/body.md
```

Salida vacía → V2 pasa. Salida con matches → V2 falla.

## Reglas adicionales de redacción

Aplicables al render del documento. Heredan de `agent-workflow:redaccion-simple` con preset default:

- **Frases cortas**: ≤20 palabras (más permisivo que en export-func ejecutivo).
- **Listas sobre prosa**: 3+ items paralelos → bullets.
- **Una idea por línea en bullets**.
- **Sin relleno**: cero "es importante notar que", "cabe destacar", etc.
- **Verbos directos**: "valida" mejor que "realiza la validación de".
- **Términos técnicos OK**: jerga del dominio (propuesta, MCP, C4, hook, skill) está autorizada — la audiencia la maneja.
- **Acrónimos**: glosarlos la primera vez sólo si no son del dominio cotidiano del lector técnico. Ej: "C4 (Context-Container-Component-Code)" la primera vez OK; "MCP" se asume conocido.
- **Sin nombres del developer** (ni paths absolutos, ni emails, ni handles).
- **Diagramas integrados con texto**: cada diagrama Mermaid va acompañado de 1-2 líneas que lo introducen o resumen. Diagrama suelto sin texto es noise estructural.

## Diferencias con `export-func/references/lexico.md`

| Aspecto | `export-arq/lexico-tecnico.md` | `export-func/lexico.md` |
|---|---|---|
| Foco | Limpieza de noise interno | Traducción técnica → ejecutiva |
| Tamaño de tabla | ~25 términos vetados | ~75 términos vetados |
| Tabla de traducción | ninguna | ~45 pares |
| Términos técnicos | autorizados | vetados (deben traducirse) |
| Audiencia | devs/arquitectos | gerencia/jefatura/comité |
| Grep modo | `-F -f` (case-sensitive ok) | `-i -F -f` (case-insensitive) |
