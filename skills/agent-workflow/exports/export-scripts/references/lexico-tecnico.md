# Léxico técnico — placeholders vetados (V2)

Lista mínima de placeholders y patrones de noise que NO deben aparecer en el bundle generado (`README.md` y `.sql`). Audiencia técnica: la terminología SQL/DBA es bienvenida, sólo se vetan restos de plantilla.

## Lista vetada (V2 — para grep -F -f)

```
NNN
YYYY-MM-DD
[entre corchetes]
[CATEGORIA]
[nombre-rama]
[primera categoría con contenido]
[segunda categoría con contenido — si aplica]
<placeholder>
sessionXXX
sessionYYY
sessionNNN
ACT-NNN
ACT-001
ACT-002
/Users/
/home/
C:\Users\
TODO:
FIXME:
WIP:
```

## Patrones v3.x deprecados (V2 — regex)

```regex
por-sesion/
manifest\.md
ORDER\.md
rollback-global\.sql
\.rollback\.sql
```

Válidos sólo dentro de bloques explícitos "DEPRECATED" / "histórico". V2 valida el contexto cercano.

## Cómo extraer la lista

```bash
awk '/^```$/{flag=!flag; next} flag' lexico-tecnico.md > /tmp/lexico-vetado.txt
grep -n -F -f /tmp/lexico-vetado.txt README.md
```
