# Léxico técnico — limpieza mínima de noise para export-tech-manuals

A diferencia de `export-report/references/lexico.md` (que traduce técnico→ejecutivo para audiencia gerencial), este léxico es **mínimo**: la audiencia de `export-tech-manuals` es técnica (operadores/soporte/onboarding) y los términos técnicos son bienvenidos.

Mismo patrón que `export-arq/references/lexico-tecnico.md`: vetar sólo el "noise" interno.

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
{{TITULO
{{SESIONES
{{PROPOSITO
{{PREREQUISITOS
{{PASO_
{{PASOS_
{{VALIDACION
{{TROUBLESHOOTING
{{REFERENCIAS
{{N_MANUALES
{{N_TEMAS
{{TABLA_
{{PROXIMOS_PASOS
sessionXXX
sessionYYY
sessionNNN
DEC-NNN
NNN-export-tech-manuals
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
- **Placeholders no reemplazados** (`{{...}}`): indica fallo del render.
- **Fragmentos de plantilla** (`<-- TODO`, etc.): noise residual del template.
- **Paths absolutos del developer** (`/Users/`, `~/Git/`): filtran info local.
- **Markers WIP** (TODO/FIXME/HACK con dos puntos): incompletos sin terminar.

**Excepciones autorizadas** (V2 las exime):
- Sección `## Referencias` puede contener placeholders esperados (ej. `NNN-` en paths tipo).
- Header del documento puede contener identificadores del producto canónicos.
- Sección `## Troubleshooting` puede mencionar errores que contienen jerga técnica del dominio (ej. mensaje literal del sistema).

## Cómo validar

```bash
awk '
  BEGIN { body=0 }
  /^## Referencias/ { body=0 }
  body { print }
  /^## / && !/Referencias/ { body=1 }
' output.md > /tmp/body.md

grep -n -F -f lexico-noise-vetado.txt /tmp/body.md
```

Salida vacía → V2 pasa. Salida con matches → V2 falla.

## Reglas adicionales de redacción

Aplicables al render de cada manual o del INDEX. Heredan de `agent-workflow:redaccion-simple` preset default:

- **Frases cortas**: ≤20 palabras.
- **Listas sobre prosa**: 3+ items paralelos → bullets.
- **Una idea por línea en bullets**.
- **Verbos directos**: "Ejecutar" mejor que "Se procede a ejecutar".
- **Sin pasos compuestos**: una acción por paso numerado.
- **Términos técnicos OK**: del dominio (`agent-workflow`, `MCP`, `hook`, `kind`, `session`) están autorizados.
- **Acrónimos**: glosarlos la primera vez si no son del dominio universal del lector técnico operativo.
- **Sin nombres del developer** (ni paths absolutos, ni emails, ni handles).
- **Códigos / comandos en backticks**: `agent-workflow session-create` siempre con backticks; no en prosa cursiva.

## Diferencias con los lexicos hermanos

| Aspecto | `export-tech-manuals/lexico-tecnico.md` | `export-arq/lexico-tecnico.md` | `export-report/lexico.md` |
|---|---|---|---|
| Foco | Limpieza noise + render checks | Limpieza noise + render checks | Traducción técnica → ejecutiva |
| Tamaño | ~30 términos vetados | ~25 términos vetados | ~75 términos vetados |
| Audiencia | operadores/soporte/onboarding | devs/arquitectos | gerencia/jefatura/comité |
| Tabla de traducción | ninguna | ninguna | ~45 pares |
| Términos técnicos del dominio | autorizados | autorizados | vetados (a traducir) |
| Grep mode | `-F -f` case-sensitive | `-F -f` case-sensitive | `-i -F -f` case-insensitive |
