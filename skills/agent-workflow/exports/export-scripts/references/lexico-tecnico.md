# Léxico técnico — limpieza mínima de noise para export-scripts (v4.0.0)

A diferencia de `export-report/references/lexico.md` (que traduce técnico→ejecutivo para audiencia gerencial), este léxico es **mínimo**: la audiencia de `export-scripts` es técnica (devs / DBAs / release managers) y los términos técnicos son bienvenidos. Sólo se veta el noise interno: placeholders sin reemplazar, paths del developer, restos de plantilla, y referencias residuales al layout v3.x (`por-sesion/`, `manifest.md` separado, `ORDER.md`, `rollback-global.sql`).

## Lista vetada (V2 — para grep determinista)

Términos / patrones que **no deben aparecer** en el cuerpo del `README.md` rendered (excepto en `## 10. Metadata`):

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
grep -n -F -f /tmp/lexico-vetado.txt /tmp/readme-body.md
```

El primer awk toggle-extrae las líneas entre triple-backticks (alterna `flag` cada `\`\`\`` solitario); el segundo grep matchea como fixed strings.

## Anti-redundancia v4.0.0 (regex aparte)

Patrones del layout v3.x que NO deben aparecer en prosa del README (V2 los rechaza vía regex, no fixed-string):

```regex
por-sesion/
manifest\.md
ORDER\.md
rollback-global\.sql
\.rollback\.sql
```

Estos patrones son válidos sólo dentro de bloques que declaran explícitamente "v3.x histórico" / "DEPRECATED" / "eliminado". V2 valida el contexto (presencia de palabra "deprecated"/"histórico" cercana).

## Total ≈ 50 términos vetados (fixed-string) + 5 patrones v3.x (regex)

Mantenimiento: revisar tras cada change major del `readme-template.md`; los términos derivan 1:1 de los placeholders activos en la plantilla.
