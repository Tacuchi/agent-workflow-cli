# Migración — baseline sellado y decisiones durables

Qué cambia para un workspace que ya viene usando `plan-exec`, y qué hacer con los
planes y corridas que existían antes. No hay una reescritura retrospectiva: el
CLI conserva la evidencia histórica y distingue con precisión qué puede ejecutar,
qué sólo puede leer y qué debe bloquear.

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

### Qué digiere el sello: el contenido funcional, no los bytes

El sello **no** digiere el archivo entero. Digiere el **contenido funcional** de
la spec: `## Requirement`, `## Scope`, `## Acceptance criteria`, `## Scenarios`,
`## Behavioral changes` y `## Affected capabilities`, con los blancos
normalizados y las casillas sin tildar.

La consecuencia es la que importa: **una edición editorial de la spec ya no
vuelve divergentes a sus planes.** Corregir un typo, completar `## Context`,
sumar una entrada a `## Decisions`, reordenar secciones o tildar un criterio deja
el plan alineado. Cambiar una palabra de `## Scope` sí lo vuelve divergente, que
es lo que se quería medir desde el principio. Reordenar dos secciones no cuenta
como cambio, pero **mover texto de una a otra sí**: el contenido se identifica
por sección, así que sacar algo de `## Scope` y ponerlo en `## Context` es un
cambio funcional y no un movimiento.

**Los sellos anteriores siguen valiendo.** La alineación acepta el digest
funcional **o** el byte-exacto que sellaron los planes previos a este cambio: un
plan sellado antes sigue alineado mientras su spec no cambie, y no hay que
resellar nada para eso. Lo que el tablero reporta es siempre el digest funcional,
porque es el que una nota de decisión pinea; si reportara el otro, una nota recién
publicada se leería como si decidiera sobre un contrato que ya no existe.

Un payload funcional vacío —una spec sin ninguna de esas secciones, o con un
fence sin cerrar que se traga el resto del documento— **degrada al digest
byte-exacto**: un digest constante compartido por varias specs dejaría un plan
alineado para siempre, que es peor que ser sensible a un cambio editorial.

### Matriz de baseline y ruta

`unsealed` es un estado legítimo de un plan anterior al sello: no prueba
alineación, pero tampoco inventa una divergencia. La ruta depende además de si
el plan está abierto o cerrado:

| Baseline y estado del plan | Resultado que declara el CLI | Comando |
|---|---|---|
| legacy `unsealed`, abierto | ejecutable en modo `compatible`; el aviso `SIN SELLO DE BASELINE` aparece sólo en el detalle | `/w:plan-exec <plan>` |
| legacy `unsealed`, cerrado (`done`) | `historical`: conserva su evidencia y no crea deuda nueva | ninguno |
| `aligned` | ejecución normal | `/w:plan-exec <plan>` |
| `divergent` | la spec cambió **funcionalmente** desde el digest sellado; se entrega a refinamiento estructural, o se re-sella si el plan sigue vigente tal cual | `/w:plan-refine <plan>` · `aw reseal prepare <plan>` |
| `malformed` | bloqueo tipado `WORKLINE_BASELINE_MALFORMED` | `null` |
| spec ausente (`unresolved`) | bloqueo tipado `WORKLINE_BASELINE_SPEC_ABSENT` | `null` |
| `> Standalone:` (plan sin spec, nacido de la conversación) | modo propio `standalone`, **sin** aviso de sello ausente: es el modo, no un defecto | `/w:plan-exec <plan>` |

Un legacy abierto no se presenta como alineado ni como derivado del contrato
vigente: sólo puede continuar bajo compatibilidad. Un legacy cerrado es historia,
no una deuda que el sistema pueda fabricar después. En cambio, `malformed` nunca
se degrada a `unsealed`: una línea rota es un problema para arreglar, no una
ausencia para tolerar.

**No hay que sellar ni resellar nada retroactivamente.** El sello aparece sólo
cuando `plan-new` o `plan-refine` publican nuevos bytes del plan; el CLI jamás
fabrica un baseline para habilitar una corrida vieja.

### `aw reseal`: cerrar una divergencia legítima sin rediseñar el plan

Cuando la divergencia es real y el plan **sigue valiendo tal cual**, recorrer un
`/w:plan-refine` completo sólo para que la publicación recalcule el sello es un
precio absurdo — y hasta ahora era el único. Los dos comandos:

```
aw reseal prepare docs/plans/041-plan-<slug>.md      # read-only: sellado → vigente
aw reseal apply   docs/plans/041-plan-<slug>.md --approval <digest>
```

`prepare` no escribe nada: muestra el digest sellado, el vigente y la línea exacta
que va a quedar. `apply` **vuelve a preparar** sobre el árbol vivo y exige el
digest que se mostró, así que un plan editado en el medio —o una publicación
concurrente de `plan-exec`— se rechaza en vez de pisarse. La escritura es una sola
línea; el resto del plan queda byte a byte igual.

**Un re-sello es una afirmación humana**, no un arreglo automático: quien lo
ejecuta declara «revisé el plan contra la spec vigente y sigue valiendo». Por eso
la aprobación es explícita y el CLI nunca lo dispara solo. Si lo que cambió sí
mueve el plan, la salida sigue siendo `/w:plan-refine`.

Un plan cuya spec está declarada en `## Origin` en vez de en un `> Derived from`
no se puede re-sellar todavía: el rechazo dice qué línea agregarle. Y un plan
`> Standalone:` no sella baseline en absoluto, así que ahí no hay nada que
re-sellar.

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

Esto es el gate de una desviación encontrada durante una ejecución ya
habilitada. Un baseline `divergent` no entra por estas cuatro alternativas: la
matriz anterior lo entrega directamente a `plan-refine` antes de ofrecer
`plan-exec`.

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

Una nota **direcciona** lo que enmienda con la gramática `S{NNN}/AC-nn`, y el CLI
**deriva** ese id del rótulo `AC-nn` que el criterio lleva en el checklist de la
spec más el número de su archivo. O sea que la forma legible que escribe la
plantilla —`- [ ] AC-01: <resultado>`— ya es direccionable; una spec que escriba
el id completo en la línea se lee igual, sin contarlo dos veces. Lo que no se
puede enmendar es un criterio **sin rótulo**: ahí la nota se rechaza con
`CONTRACT_ASSERTION_ABSENT` y la salida es rotularlo en la spec, no inventar una
segunda forma de nombrarlo en la nota.

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

### Decisión forward para Specs 033/034 y Plan 032

Las obligaciones históricas incompatibles de Specs 033/034 y del Plan 032 no se
reescriben ni se simula que nunca existieron. Esta migración las sustituye sólo
hacia adelante: las nuevas ejecuciones usan la matriz de baseline y el estado
v10 de batches; una corrida legacy no se resella ni recibe batches inferidos.
La evidencia y los bytes históricos quedan intactos. Si una ejecución concreta
necesita enmendar su contrato, lo hace mediante una nota durable append-only,
nunca editando esas Specs o ese Plan para acomodar el comportamiento nuevo.

## 5. Consumidores múltiples

Todo plan conocido derivado de un baseline se lee en una de cuatro posiciones:

- `aligned` — sellado sobre el baseline vigente y sin nada que deber;
- `pending-reconciliation` — abierto, con compensación pendiente;
- `historical` — cerrado: su contrato es historia;
- `unproven` — no tiene baseline alineable (sin sello, divergente, ilegible o
  con spec ausente).

**Ningún consumidor abierto se presenta como alineado hasta cerrar sus
obligaciones**, y ninguno sin sello se presenta como alineado en absoluto. Esta
clasificación no reemplaza la ruta ejecutable de la matriz: un consumer legacy
abierto puede estar `unproven` y, aun así, continuar sólo en modo compatible.

## 6. Estado de corrida: versión 10 y batches repetibles

`.flow-run.json` se escribe ahora en versión **10**. Para `plan-exec` guarda el
batch tipado: su id e iteración, fases, tareas exactas, digest del plan, etapa y
traza append-only por iteración. Así la publicación acredita exactamente las
tareas del batch y el estado o bloqueo de sus fases, en una transición CAS; no
depende de una afirmación libre de "efectos pendientes".

El ciclo de un batch es explícito: inferir, aislar, implementar, resolver una
desviación si aparece, validar, revisar, cerrar el batch e integrar. Si quedan
fases, el `batch_loop` abre la siguiente iteración; sólo el último batch hace la
validación final antes de sellar el cierre.

El CLI todavía **lee** v9, v8 y v7 para status, evidencia y recuperación, pero
una corrida legacy activa exige adopción explícita antes de cualquier mutación:

```
aw flow advance --code <sesión> --flow plan-exec --adopt
```

Adoptar preserva la historia y empieza v10 con batches y traza vacíos: declara
que no se reconstruye ni inventa el límite de batches que la corrida anterior
nunca registró. Leer, `status` o `resume` no migran ni re-estampan nada.

La continuidad sigue moviendo la posición en el plan, nunca el cursor del
recorrido. El recorrido permanece append-only: un cursor que retrocede volvería
re-ejecutable trabajo ya aplicado y rompería el ledger de intentos.

## Resumen: qué hacer hoy

| Situación | Acción |
|---|---|
| Plan legacy sin sello, abierto | ejecutar sólo en modo compatible; leer el aviso en el detalle |
| Plan legacy sin sello, cerrado | conservarlo como histórico, sin deuda retrospectiva |
| Plan que se va a refinar | el sello aparece solo al republicarlo |
| Baseline divergente | ir exactamente a `plan-refine` |
| Baseline ilegible o spec ausente | atender el bloqueo tipado; no hay comando de ejecución |
| Corrida `.flow-run.json` v9/v8/v7 en curso | leerla; usar `aw flow advance --adopt` antes de mutarla |
| Corrida v10 | publicar batches y traza por iteración; no inferir historia legacy |
| Aparece una desviación | elegir una de las cuatro salidas del gate |
| Hay una obligación pendiente | saldarla y publicar la nota que sustituya a su causa |
