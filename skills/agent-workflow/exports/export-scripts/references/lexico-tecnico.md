# Léxico técnico — limpieza mínima de noise para export-scripts

A diferencia de `export-report/references/lexico.md` (que traduce técnico→ejecutivo para audiencia gerencial), este léxico es **mínimo**: la audiencia de `export-scripts` es técnica (devs / DBAs / release managers) y los términos técnicos son bienvenidos. Sólo se veta el noise interno: placeholders sin reemplazar, paths del developer, restos de plantilla.

## Lista vetada (V2 — para grep determinista)

Términos / patrones que **no deben aparecer** en el cuerpo del `manifest.md` rendered (excepto en `## 10. Metadata`):

```
{{
}}
{{PRODUCTO}}
{{FECHA}}
{{SOURCE}}
[entre corchetes]
[YYYY-MM-DD]
[nombre-rama]
[nombre]
[lista]
[N]
[motivo 1]
[motivo 2]
[breve descripción]
[resumen 1 línea]
[título]
[fecha objetivo]
[correo-destino]
[correo-cc]
[servicio 1]
[servicio 2]
[sha corto]
[mensaje]
[salida de
sessionXXX
sessionYYY
sessionNNN
session001-nombre
session002-nombre
NNN-export-scripts-YYYY-MM-DD
NNN-informe-release
NNN-release-YYYY-MM-DD
DEC-NNN
ACT-NNN
ACT-001
ACT-002
H1
M1
/Users/
~/Git/
C:\Users\
TODO:
FIXME:
WIP:
XXX:
<-- TODO
<-- FIXME
<-- WIP
resto de acciones detectadas automáticamente
otras advertencias dinámicas según lo detectado
Si vacío:
Si no hay irreversibles:
Si no existe vista por tema:
Si --skip-code-scan fue usado:
Si no hay advertencias:
```

## Cómo extraer la lista para `grep -F -f`

El validator de V2 (descrito en `validations.md` §V2) procesa este `.md` extrayendo sólo las líneas **dentro del fenced block**, no toda la prosa. Pre-proceso típico:

```bash
awk '/^```$/{flag=!flag; next} flag' lexico-tecnico.md > /tmp/lexico-vetado.txt
grep -n -F -f /tmp/lexico-vetado.txt /tmp/manifest-body.md
```

El primer awk toggle-extrae las líneas entre triple-backticks (alterna `flag` cada `\`\`\`` solitario); el segundo grep matchea como fixed strings.

## Total ≈ 50 términos vetados

Mantenimiento: revisar tras cada change major del template; los términos derivan 1:1 de los placeholders activos en `manifest-template.md`.
