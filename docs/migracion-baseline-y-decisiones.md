# Migración — baseline sellado y decisiones durables

Qué cambia para un workspace que ya viene usando `plan-exec`, y qué hacer con los
planes que existían antes. Nada de esto exige una migración previa: **todo plan
que funcionaba sigue funcionando**, y lo que cambia es lo que el sistema se anima
a *afirmar* sobre él.

## 1. Un plan ahora puede decir de qué versión de su spec deriva

Antes, un plan probaba su origen con un número: `> Derived from: docs/specs/033-…`.
Eso identifica el documento, no el contrato — la spec podía cambiar entera y el
plan seguía diciendo que derivaba de ella.

Ahora un plan puede llevar además su **baseline sellado**, una línea en el
blockquote de cabecera:

```
> Derived from: docs/specs/033-spec-reconciliacion-incremental-spec-plan.md
> Baseline: docs/specs/033-spec-reconciliacion-incremental-spec-plan.md@sha256:…
```

Esa línea **no se escribe a mano**. La sella la publicación: cuando `plan-new` o
`plan-refine` publican el plan, el CLI calcula el digest de la spec tal como la
está leyendo y lo estampa en los bytes que se aprueban. Vista previa, aprobación
y escritura cubren la misma cosa.

### Qué significa `sin sello` para los planes que ya existen

Los **32 planes** de este workspace nacieron antes del sello, así que ninguno lo
tiene. Su lectura es `unsealed`, y eso es un estado legítimo y explícito:

| Lectura | Qué dice | Qué NO dice |
|---|---|---|
| `aligned` | el plan está sobre la versión de la spec que selló | — |
| `divergent` | la spec cambió desde que se selló, con los dos digests | que el plan esté mal |
| `unsealed` | **el plan no dice de qué versión deriva** | que esté desalineado |
| `malformed` | la línea está pero no se puede leer, con su arreglo | que falte |

`unsealed` **no** se presenta como alineado ni como derivado del contrato
vigente. `resume` lo dice con todas las letras —
`SIN SELLO DE BASELINE — el plan no dice de qué versión de su spec deriva` — en
lugar de proponer «continuar por la primera fase no validada» sobre un contrato
que nadie puede probar.

**No hay que sellar nada retroactivamente.** Un plan viejo que se cierra tal cual
se cierra igual que siempre. El sello aparece solo la próxima vez que
`plan-refine` republique el plan.

Y `malformed` nunca se degrada a `unsealed`: una línea rota es un problema para
arreglar, no una ausencia para tolerar.

## 2. El gate de desviación dejó de ser doctrina y pasó a ser máquina

Antes, cuando aparecía una divergencia entre lo que el plan decía y lo que la
ejecución encontraba, el gate estaba escrito en la doctrina del loop y el
recorrido lo aplicaba solo, siguiendo derecho hasta el commit.

Ahora **la corrida se detiene** y ofrece cuatro salidas:

1. **Registrar la decisión y seguir** (recomendada) — se publica una nota durable
   y la ejecución continúa sin salir del loop.
2. **Volver a `plan-refine`** — la desviación es estructural.
3. **Volver a `spec-refine`** — la desviación es funcional.
4. **Escalar a una spec nueva** — el problema es más grande que este linaje.

Las tres últimas arman un **paquete de escalación**, y el destino declara que lo
consumió: `spec-refine` y `plan-refine` ganaron una primera fila de juicio que lo
adopta antes de re-derivar nada.

La elegibilidad de la salida componible es **cierre, no tamaño**: no se mide por
cuántas líneas cambian, sino por si el linaje, la intención, el impacto y la
recuperabilidad quedan cerrados.

### Qué cambia en la práctica

- Una corrida con una desviación declarada **ya no llega sola al commit**.
- Sin ninguna desviación declarada, el gate se salta con su causa: la ejecución
  sigue exactamente como antes.
- Más de una divergencia en una corrida **sobrevive entera**: las observaciones
  se acumulan en vez de reemplazarse.

## 3. Las decisiones viven fuera de lo que deciden

Una decisión se publica como **nota durable** en `docs/decisions/<spec>-decisions-<slug>.json`.
Esa carpeta es **no relocalizable**: `flow`, `status` y `resume` tienen que
encontrar la misma cadena, y una cadena que la mitad de las superficies ve es
peor que no tener contrato.

Una nota nunca se guarda dentro de su spec ni de su plan: eso cambiaría el digest
del documento, y el contrato enmendado dejaría de ser el contrato que se enmendó.

**La cadena es append-only.** Corregir una nota es publicar otra que la sustituya
por referencia; nunca reescribirla. Y el contrato efectivo se compone aplicando
en orden las notas vigentes sobre el baseline — o **bloquea** nombrando la acción
correctiva. No hay una tercera respuesta donde gane la más nueva.

## 4. Un plan con trabajo compensatorio abierto no se puede cerrar

Cuando una decisión invalida trabajo ya cerrado, **nada histórico se toca**: la
fase sigue `validada` y sus casillas siguen marcadas, porque registran lo que
realmente pasó. Lo que aparece es **trabajo nuevo del contrato efectivo**:
obligaciones compensatorias pendientes, cada una ligada a la nota que la causó.

Mientras haya una obligación abierta:

- el plan se lee `inconsistent` si se declara `done` — el documento dice una cosa
  y el contrato muestra otra;
- `resume` propone saldarla, con su causa y su punto de retorno, y dice que el
  plan **no es ejecutable tal cual ni cerrable**;
- la fila `plan-exec.plan-done` no sella nada, porque sólo sella cuando el
  tablero lee el plan cerrado.

**Cómo se salda una obligación:** publicando una nota que sustituya a la que la
creó y no la arrastre. No existe un segundo libro de obligaciones saldadas — uno
podría contradecir a la cadena, y no habría con qué desempatar.

El punto de retorno es siempre la **primera** obligación alcanzada, no la más
nueva: retomar en la última pisaría trabajo que una decisión anterior todavía
debe.

## 5. Consumidores múltiples

Todo plan conocido derivado de un baseline se lee en una de cuatro posiciones:

- `aligned` — sellado sobre el baseline vigente y sin nada que deber;
- `pending-reconciliation` — abierto, con compensación pendiente;
- `historical` — cerrado: su contrato es historia;
- `unproven` — sin sello, o con uno que ya no coincide.

**Ningún consumidor abierto se presenta como alineado hasta cerrar sus
obligaciones**, y ninguno sin sello se presenta como alineado en absoluto.

## 6. Estado de corrida: versión 8 → 9

`.flow-run.json` pasa a versión 9 por un campo nuevo y **opcional**
(`continuation`, dónde vuelve la ejecución tras una decisión). El CLI lee las
versiones **9, 8 y 7**: una corrida a mitad de camino escrita por un CLI anterior
se sigue leyendo tal como estaba y se re-estampa en su primera escritura.

La continuidad **mueve la posición en el plan, nunca el cursor del recorrido**.
El recorrido sigue siendo una pasada lineal append-only: un cursor que retrocede
volvería re-ejecutable todo lo ya aplicado, y el ledger que topea intentos se
apoya en que sólo crece.

## Resumen: qué hacer hoy

| Situación | Acción |
|---|---|
| Planes viejos sin sello | **nada**. Se reportan `unsealed` y se cierran igual |
| Plan que se va a refinar | el sello aparece solo al republicarlo |
| Corrida `.flow-run.json` en curso | **nada**. Se lee y se re-estampa sola |
| Aparece una desviación | elegir una de las cuatro salidas del gate |
| Hay una obligación pendiente | saldarla y publicar la nota que sustituya a su causa |
