# Changelog

All notable changes to `@tacuchi/agent-workflow-cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [25.3.0] — 2026-09-04

### Added

- **Cada obligación que deja una nota de decisión declara de quién es el trabajo, y sólo una de las dos clases retiene el cierre.** Una nota podía dejar trabajo pendiente sin decir a quién le tocaba, y la reconciliación lo contaba todo como deuda propia: un traspaso que el recorrido no podía saldar —porque el trabajo era de otra gente— dejaba el plan ni ejecutable ni cerrable para siempre, y la única salida era editar `docs/decisions/` a mano. Ahora una obligación es `compensation`, que es trabajo de este linaje y retiene el cierre hasta saldarse, o `handoff`, que es trabajo que alguien de afuera tomó: queda listado, sigue visible después de que el plan cierre, y no bloquea nada. Nada histórico se mueve en ninguno de los dos casos: las casillas y los estados de fase registran lo que realmente pasó, y la obligación es trabajo nuevo del contrato efectivo. La clase la declara el agente al redactar la nota y la persona la ve en la vista previa sellada antes de registrarla; una nota nueva que deja trabajo sin decir la clase se rechaza con `NOTE_OBLIGATION_KIND_MISSING`.
- **Las notas ya publicadas se leen sin migrarlas, y la lectura se distingue de la palabra de la nota.** Una obligación sin clase declarada se lee **compensación** —la mitad segura— salvo que el plan mismo enumere ese trabajo exacto en su sección de traspaso operativo o en sus preguntas abiertas, y la única correspondencia admitida es que uno de los dos textos contenga al otro, con un piso de veinticuatro caracteres para que una coincidencia corta no decida nada — nunca un juicio sobre palabras. Toda superficie que la muestre la marca como una lectura que alguien suministró y no como la clase que la nota dijo, con una sola redacción compartida: un traspaso legado vuelve el plan cerrable, así que es justo la lectura que más importa no afirmar como propia de la nota. El digest de una nota legada no cambia al releerla: el sello es sobre la forma escrita en disco.
- **El cierre de `plan-exec` salda o reconoce las obligaciones sin salir del recorrido.** Entre el último cierre de lote y la validación final aparecen tres fronteras que sólo se abren cuando el plan debe compensación: el agente declara, por cada una, si está cumplida y con qué evidencia; la persona responde una sola pregunta y sólo cuando una obligación legada admite más de una lectura, con la propuesta del agente recomendada; y el CLI deriva y publica la nota de saldo con la misma primitiva de registro que ya existía. La nota de saldo sustituye a la que cargaba la obligación arrastrando su decisión, su motivo, sus aserciones, su alcance, sus consumidores y su evidencia, soltando sólo lo saldado y clasificando lo que queda —no hay un segundo registro de obligaciones saldadas, porque una constancia fuera de la cadena podría contradecirla—. Una compensación que sigue pendiente **deja la frontera abierta con una acción ejecutable y no gasta ningún intento**: decir la verdad sobre trabajo que falta no puede costarle a nadie sus reintentos. Sin compensaciones vigentes las tres fronteras se saltean solas y el cierre es el de antes, sin ninguna interacción humana nueva.
- **`aw settle` destraba un plan cuyo recorrido cerró hace tiempo.** Es la otra mitad del saldo: un plan bloqueado hoy por una obligación de una corrida que ya terminó. `aw settle list <plan>` muestra cada obligación con su nota, su posición, su clase, si esa clase la declaró alguien y el punto vigente del plan; `prepare` deriva los mismos sucesores que derivaría el cierre, no escribe nada y devuelve la vista previa con el digest que la autoriza; `apply` vuelve a derivar todo desde el workspace vivo, exige ese digest y publica bajo el candado. El sello cubre la evidencia, que es lo único que aporta una persona. Con un recorrido de ejecución abierto sobre el plan se niega y nombra esa corrida —un recorrido que puede saldar sus propias obligaciones es el que tiene que hacerlo—, y una corrida cuyo recorrido ya se agotó no bloquea, que es exactamente el workspace para el que el comando existe. Es transversal: no abre flujo, no crea sesión, y viaja sin documento en el bundle.
- **La doctrina embarcada dice las dos clases, quién las declara y cómo se saldan.** El § *Deviation gate* del recorrido de ejecución tiene ahora una subsección de obligaciones con las dos clases y su efecto, la lectura tolerante de una nota legada, el saldo en el cierre y con `aw settle`, y la regla de reparto entre andamiaje y contenido en tres líneas. Dice además que la clase **es revocable** en la frontera de saldo y que en duda la lectura es compensación, que es la única cuyo error alcanza a atrapar una frontera posterior. Un pin de doctrina fija la subsección, su lugar dentro del gate y el efecto atado a cada clase.

### Changed

- **El tablero y los rechazos nombran una salida que se puede tomar, en vez de decir sólo que no se puede.** Un plan con compensación vigente salía `blocked` con `command: null` —un rechazo sin salida— y el titular mandaba a retomar en el punto que la nota grabó el día que se escribió, aunque esa fase estuviera validada e integrada. Ahora la fila sale `continue` con comando: el de la corrida abierta sobre ese plan cuando hay una, y `aw settle prepare <plan>` cuando no. El punto de reanudación lo deriva el documento como está hoy —la primera fase que no reporta validada, o el cierre— y el que la nota declaró queda en el detalle de la obligación, para auditoría y nunca como destino. Un plan cuyo linaje no se puede componer nombra su reparación en vez de una fase: una fase no arregla un índice ilegible.
- **Un plan cerrado con traspasos vigentes vuelve al tablero como pendiente no bloqueante.** Cerrar el plan era justamente lo que volvía invisible un traspaso que ninguna clausura salda, porque no es trabajo de esta línea. Ahora vuelve como su propia fila —última, sin marcar obligación y con el comando con que se reconoce—, y `aw status` y `aw resume` lo proyectan por la misma derivación: la regla de pertenencia del tablero es una sola y `resume <plan>` la consume, donde antes tenía la suya y podía llamar «histórico y sin deuda» a un plan cuyo traspaso el tablero estaba imprimiendo. El rechazo del sello, el titular del tablero y la acción de la fila salen de una única función del dominio, así que no pueden volver a describir distinto el mismo bloqueo.

- **La forma de `aw status --json` y `aw resume --json` cambia con la clase de obligación.** `plans[].reconciliation` se parte en `pending` —sólo compensaciones— y `handoffs`, y cada obligación gana `index`, `kind`, `legacy` y, cuando corresponde, `corresponds_to`. `plans[]` gana `current_point` —el punto que el documento reporta hoy— y `holding_run`, la sesión cuya corrida tiene ese plan. `pipeline[].kind` gana el valor `plan-handoff`, `pipeline[].action.mode` gana `settlement`, y aparece el aviso `WORKLINE_PLAN_CLOSURE_UNVERIFIED` en la fila de un plan cerrado sobre evidencia omitida o sustituta. En el sobre de `aw flow`, la vista previa de una decisión pasa `obligations` de una lista de textos a objetos `{text, kind, declared}`. Y se suman veintiún códigos de rechazo del saldo (`SETTLE_*`, `SETTLEMENT_*`, `FLOW_SETTLEMENT_*`, `PLAN_EXEC_SETTLEMENT_PENDING`, `NOTE_OBLIGATIONS_INVALID`) además de `NOTE_OBLIGATION_KIND_MISSING`.

### Removed

- **`plans[].reconciliation.resume_point` ya no se emite, y `plans[].reconciliation.pending[].resume_point` se llama `declared_point`.** Era el punto que la nota grabó el día que se escribió, y como agregado del plan mandaba a fases ya validadas: el punto al que se vuelve lo deriva ahora el documento y sale en `plans[].current_point`, mientras el declarado queda en cada obligación, para auditoría. Un consumidor de `--json` que lea el campo viejo recibe `undefined`.
- **El código `WORKLINE_PLAN_RECONCILIATION_PENDING` desapareció de `pipeline[].action.code`.** Un plan con compensación vigente ya no sale `blocked`: sale `continue` con comando, así que no queda un bloqueo que nombrar.

### Fixed

- **Un índice de decisiones que no se puede leer dejó de leerse como «ninguna obligación».** El comentario del código decía que un índice corrupto no es una lista vacía y el código hacía lo contrario: caía a una lista vacía, así que una cadena ilegible se leía como pizarra limpia y dejaba cerrar un plan sobre compensación que nadie podía leer. Ahora la negativa del lector es lo que se propaga, el plan no se lee cerrable, y la fila del tablero nombra la reparación del índice.

### Migration

- **Cerrá, reseteá o descartá toda corrida `plan-exec` en vuelo que esté parada en `plan-exec.final-validation` o después ANTES de actualizar.** Las tres filas del saldo se insertan delante de esa fila, y el estado de una corrida es un cursor posicional, así que una corrida escrita por 25.2.0 que ya alcanzó la validación final, la habilitación o autorización del commit, su ejecución, la integración de la unidad o el sello se rechaza con `FLOW_RUN_AHEAD_OF_JOURNEY`. `aw flow advance --adopt` **no** la recupera —la versión del estado persistido no cambió, así que no hay nada que adoptar— y `aw settle` la niega mientras la sesión siga abierta, porque la proyección la sigue considerando dueña del plan. La salida es `aw reset`, `aw discard` o `aw session-close` sobre esa sesión. Las corridas paradas antes del cierre del último lote no se ven afectadas. Detectalas con `aw status --detail` o `aw sessions` antes de actualizar.
- **Corré `aw self install-skill` después de actualizar** si querés que el bundle instalado traiga la subsección de obligaciones del recorrido de ejecución y la ruta de `aw settle` en `/w:resume`.

## [25.2.0] — 2026-09-03

### Added

- **`aw doctor` —y su atajo `aw --doctor`— reúne en un solo informe el estado de Workline en todos los hosts de la máquina.** El diagnóstico estaba repartido en `aw self doctor`, `aw self detect-hosts`, `aw mcp doctor`, `aw host-doctor` y el doctor de visibilidad: varias corridas, cada una con su vocabulario de severidad y su propia convención de código de salida. Ahora una sola corrida recorre los hosts detectados o con configuración residual y cubre instalación/hosts, MCPs, skills, herramientas y autenticación, plugins/hooks y visibilidad del workspace, con los mismos hosts, cobertura, hallazgos y acciones en la vista humana y en `--json` (`schema_version: 1`, con orden estable entre corridas). Los hosts sin rastro en esta máquina se enumeran y nunca se convierten en advertencia. Los ids son los del catálogo (`claude-code`, no `claude`): `--host <id>` destaca el host actual y no filtra —un id desconocido simplemente no destaca nada—, mientras `--only <host>` filtra, se puede repetir, y ante un id que el catálogo no declara bloquea nombrando el más parecido en vez de filtrar a cero y salir sano. Los doctores especializados siguen ahí con su contrato intacto, y el comando no abre flujo ni crea sesión.
- **El informe declara qué llegó a mirar y no llama sano a lo que no comprobó.** Cada categoría dice, por host, si quedó comprobada, no aplicable, omitida o no disponible, y siempre con la razón. Un hallazgo sano se emite explícitamente en vez de deducirse de una lista vacía, y «no verificado» es un estado propio: una comprobación que no corrió no se lee como aprobada. El veredicto fija el código de salida —0 con advertencias no bloqueantes, 1 con un bloqueo **o con un proveedor que se cayó**, porque un doctor que responde 0 después de no haber podido mirar se lee como «tu entorno está sano»— y viaja además dentro del JSON. El informe se emite siempre como resultado exitoso, así que la vista humana completa se imprime también cuando bloquea, en lugar de una sola línea de error. Y `aw doctor` a secas no anexa su invocación al registro de operaciones: se puede correr a ciegas sin dejar rastro; `prepare` sí queda registrado y `apply` es el único que escribe.
- **`aw doctor prepare` propone las reparaciones y las sella: nada se toca hasta que se aprueba ese lote exacto.** Sin selección lista los hallazgos con reparación automatizable, con su comando equivalente y sus clases de efecto, y no sella nada. Con `--select <id> …` devuelve la vista previa del lote —recursos, acciones, efectos, dependencias y estado esperado—, su digest y la línea de `apply` lista para copiar. `apply` exige `--approval <digest>`, recomputa la propuesta desde el estado vivo bajo el candado del workspace y compara antes del primer byte: si cambió el lote o alguno de los archivos que se leyeron para decidirlo, rechaza nombrando el digest aprobado y el vigente, así que se distingue «aprobé otra vista previa» de «el estado se movió». Un id que el informe no tiene, o que sólo tiene guía manual, se rechaza por su nombre y sin sellar nada.
- **Un lote que falla a la mitad lo dice acción por acción, sin dejar nada como resuelto por descarte.** Las acciones corren en orden: la que falla omite las que dependían de ella diciendo el motivo, y las independientes siguen. Después cada recurso se vuelve a comprobar con el mismo proveedor que lo halló y queda resuelto, pendiente, bloqueado o no verificado —una recomprobación que no pudo correr nunca cuenta como resuelta—. El lote se reporta `completed`, `partial` o `failed`, y salir 0 sólo pasa cuando todas aplicaron *y* su recomprobación las declara resueltas. Volver a aprobar un lote cuyo problema ya no existe responde «nada que hacer» sin ejecutar nada.
- **El doctor sólo toca lo que es atribuible a Workline; lo demás recibe guía y se queda como está.** Una entrada ajena, ambigua o que contiene algo con forma de credencial embebida se preserva siempre y recibe instrucciones escritas, nunca una acción, incluso cuando el host la reporta caída. La asimetría es deliberada: un MCP propio que el host no logra conectar bloquea —Workline prometió esa capacidad y no está—, mientras que uno ajeno que falla sólo advierte y explica con qué herramienta se arregla.
- **La categoría de MCPs agrega lo que ningún doctor miraba: lo que el propio host dice de todos sus servidores.** Le pregunta a Claude y a Codex por su lista de MCPs y releva el veredicto de cada uno —conectado, deshabilitado a propósito, sin autenticar o caído— con el detalle que dio el host, además de barrer todas las entradas declaradas en sus archivos de configuración. Esa consulta conecta los servidores del directorio actual, así que `--skip-native` la declina y deja esa cobertura como «omitida» en vez de fingirla; si el binario del host no está o la consulta vence, queda «no disponible» con su razón —salvo en un host que quedó sin runtime, donde la ausencia del binario es su estado normal y la cobertura queda «omitida»—. Una línea o un campo que el lector no reconoce cae en «no verificado» y jamás en «sano», y un archivo de configuración que no se pudo decodificar deja su cobertura como no disponible en vez de declarar «comprobada, nada encontrado» sobre bytes que nadie leyó.
- **La autenticación de las conexiones registradas se diagnostica sin que el CLI toque el secreto.** Por cada conexión dice si su variable de DSN está presente o ausente, y la guía nombra la variable y el archivo de arranque, jamás su valor. Sin `--verify-connection` la verificación profunda no corre: el hallazgo queda en presente/sano y la evidencia declara que nadie verificó la conexión. Con el flag, el CLI sale a la máquina con un `SELECT 1` de sólo lectura y una credencial presente que el servicio rechaza queda «no verificada» en vez de leerse como resuelta. Ninguna de estas autenticaciones es automatizable hoy —no hay comando que el CLI pueda correr para conseguir esa cadena sin custodiarla— y el informe lo dice en vez de prometer una reparación que no va a llegar; un flujo de autenticación que sólo pudiera correr poniendo la credencial en un argumento, o sin heredar la terminal, se bloquea con su razón antes de llegar a la vista previa.
- **`/w:doctor` llega al bundle y queda atado al host desde el que se invoca.** El bundle pasa a 19 comandos: el recorrido conversacional releva el informe del CLI sin parafrasearlo, ofrece una opción por hallazgo reparable, pide la autorización sobre la vista previa sellada y muestra el resultado acción por acción. El wrapper que se instala en cada host llega con `--host <id>` grabado, así que el informe destaca el host real de la invocación en vez del que digan los marcadores de la terminal; donde el host no tiene selector nativo, la degradación se declara y las opciones se listan como markdown etiquetado. Hay que correr `aw self install-skill` después de actualizar: una instalación anterior no tiene `/w:doctor` ni el binding del host.
- **`aw amend` corrige la redacción de una spec o un plan ya cerrados, en un solo acto y sin abrir un refinamiento.** Una frase que se lee mal en un documento cerrado —un typo, una ambigüedad, un puntero viejo— tenía una sola salida: un refinamiento completo, con su recorrido, su vista previa y su aprobación, para cambiar una línea con la que nadie discute. Ahora `aw amend apply <documento> --de <texto> --a <texto> --declaracion <motivo>` lee, comprueba, escribe y deja constancia en una invocación. Es transversal —no abre flujo ni crea sesión— y acepta la ruta relativa del documento o su correlativo. No lleva `prepare`/`apply` porque el candado del workspace más el compare-and-swap sobre el digest del documento dan la misma seguridad: un documento que se movió entre la lectura y la escritura detiene el acto sin escribir nada y lo reporta con el nombre de la garantía que lo paró (`PROPOSAL_BASE_STALE`). Por ahora se invoca desde la terminal: no hay `/w:amend` en el bundle.
- **Sólo corrige documentos cerrados, y lo que toca el contrato se rechaza estructuralmente.** Un plan que no declara `> Estado: done`, o una spec que no está en `status: ready-for-plan`, se rechaza con `AMEND_TARGET_OPEN` y se remite al recorrido que lo tiene abierto —mientras está abierto, lo escribe ese recorrido—. La declaración se registra pero no es el criterio: `AMEND_CONTRACT_TOUCHED` rechaza lo que mueve el contenido funcional de una spec, o la cabecera, el grafo de fases y tareas, las cláusulas de cierre o los lotes de ejecución de un plan, y nombra `/w:spec-refine` o `/w:plan-refine` en vez de iniciarlo. El fragmento de `--de` tiene que aparecer exactamente una vez (`AMEND_TEXT_AMBIGUOUS` si aparece dos, `AMEND_TEXT_ABSENT` si no está), y una corrección sin declaración no escribe nada.
- **Cada corrección queda registrada con su preimagen exacta y se puede deshacer.** La constancia es append-only en `.workflow/amendments.jsonl`, junto a `claims.jsonl` y con su misma forma de evento: qué documento, qué texto había, qué texto quedó, con qué declaración y con los digests del antes y el después. `aw amend list [documento]` las muestra vigentes o revertidas, y `aw amend revert <id>` devuelve los bytes exactos como su propio evento —la misma corrección no se revierte dos veces—.

### Changed

- **La compuerta de evidencia de cierre acepta la comprobación que cualquier proyecto puede nombrar, no la que nombraría este repositorio.** Juzgaba por una lista blanca de términos cuya rama de rutas aceptaba **sólo cinco prefijos** —`src/`, `tests/`, `fixtures/`, `docs/`, `scripts/`—, que son los directorios de este repositorio: un plan que validaba nombrando `migraciones/001_init.sql` o `db/seeds/` se rechazaba por nombrar sus propias carpetas, describiendo una comprobación perfectamente local. Ahora lo que acredita es el **referente**: una invocación escrita como código (`` `make verificar-catalogo` ``) o una ruta relativa de cualquier forma. Una ruta local pero fuera del checkout no acredita (`/etc/x.conf`, `~/scripts/x.sh`), y una barra que no es una ruta tampoco, ni entre comillas invertidas. La lista de términos se conserva como vía de compatibilidad, así que el juicio es estrictamente más permisivo y ningún plan ya escrito cambia de veredicto. Una cláusula de cierre apoyada en una superficie externa se sigue rechazando con el mismo código y el mismo detalle.
- **El juicio de las cláusulas de cierre corre también al guardar el plan, no sólo al entrar a ejecutarlo.** El rechazo llegaba cuando alguien intentaba ejecutar un plan que ya estaba cerrado y aprobado, con quien lo escribió lejos. Ahora la compuerta corre sobre los bytes del plan que trae la propuesta de guardado, antes del sello y antes de que nadie apruebe. Dos precisiones que importan: ese rechazo gasta uno de los tres intentos de esa frontera (`aw flow recover` los devuelve), y cuando el bloque WORKSPACE no se puede leer, en la propuesta corre sólo la mitad semántica del juicio —la declaración estructural se sigue comprobando al entrar a ejecución—.
- **Cada rechazo de límite de fuentes dice qué hacer según su causa y su momento.** Una sola frase genérica contestaba los cinco códigos, y se equivocaba dos veces: mandaba a declarar fuentes que ya estaban declaradas, y mandaba una frase de prosa a un refinamiento. Ahora la declaración estructural ausente, el alias que no está en la tabla Fuentes, la fuente de una tarea fuera de la de su fase y la cláusula apoyada en una superficie externa dicen cada una su arreglo y, cuando corresponde, se entregan a `/w:plan-refine`; una cláusula que no nombra ninguna comprobación observable pide nombrar el comando, el archivo o la ruta que la produce, y en una propuesta de guardado pide corregir los bytes y volver a proponer la vista previa.

### Fixed

- **Un desajuste de la contabilidad de la propia corrida se repara solo y el avance sigue.** Cuando el contador de intentos de una frontera no coincidía con las filas persistidas —lo que deja, por ejemplo, restaurar una copia anterior del ledger—, la frontera quedaba agotada sin que nadie hubiera gastado nada. Ahora el avance reconcilia su propia contabilidad antes de resolver la frontera, y sólo cuando el desajuste tiene exactamente una lectura: no abre frontera, no gasta intento, no pide degradación y no agrega nada a la directiva —lo que se ve es la frontera que se iba a ver, contestable—. La regla se lee sobre el gasto efectivo, así que la reparación es idempotente y no le saca el techo a nadie. No se notifica, pero queda auditable: deja su línea en la traza sellada de la corrida, sale en la proyección de estado y aparece en el relato de la sesión como algo ya aplicado, nunca como pendiente.
- **Una frontera agotada por un desajuste mecánico ya no se saltea sola.** La salida ofrecida era degradar el gap sin importar la causa: pasar por alto el paso salteaba trabajo real porque dos contadores no coincidían, y ser lo primero ofrecido es lo que mandaba a un refinamiento que nadie necesitaba. Ahora, cuando lo roto es la contabilidad y su lectura **no** es única —la cadena de intentos repite un ordinal bajo la misma invocación—, la frontera bloquea, la degradación no se ofrece y la acción nombra `aw flow recover`, que le devuelve los intentos conservando todo lo aplicado. Degradar sigue siendo la salida cuando el problema es el gap: una frontera que ya movió el mundo, o una acción que empezó y nunca registró en qué terminó. `aw flow recover` usa la misma reconciliación que el avance, así que el verbo y la reparación automática no pueden discrepar, y lo ya perdonado no se perdona dos veces.
- **Un reenvío del mismo sobre ya no deja la frontera sin forma de contestarse.** Un reenvío reconocido se vuelve a evaluar y persiste su fila con el ordinal del gemelo —a propósito, para que siga contando contra el techo—, así que las filas decían dos y el ordinal más alto uno: la respuesta siguiente llegaba como intento 3 donde sólo se admite el 2, y `aw flow recover` tampoco abría la frontera, porque dos filas idénticas se reproducen como reenvío sin fallar. El ordinal del próximo intento se calcula ahora con la misma expresión que lo valida. Sin reenvíos la numeración no cambia; un mismo ordinal con contenido **distinto** sigue siendo `CAPABILITY_ATTEMPT_DIVERGED` y sigue exigiendo `recover`.
- **El predicado de flags de credencial es uno solo y cubre los nombres compuestos.** Reconocía las formas simples (`--token`, `--secret`, `--key`, `--dsn`) y dejaba pasar `--access-token`, `--client-secret`, `--credentials`, `--private-key` o `--connection-string`. Ahora lo comparten el recibo MCP y la custodia del doctor, así que un nombre agregado a la lista queda bloqueado en las dos superficies a la vez. Un flag que no dice qué transporta (`--pat`, `-t`) sigue pasando: ninguna lista de nombres puede cubrirlo.

## [25.1.2] — 2026-09-02

### Fixed

- **Actualizar el CLI ya no convierte en ajenos los descriptores MCP que Workline mismo escribió.** Cada descriptor global lleva la versión que lo publicó, y la clasificación sólo reconocía como propia la de la versión vigente: tras un `npm i -g`, las entradas quedaban en «conflict», `install` las rechazaba y `remove` borraba la conexión del registro dejando el descriptor en la configuración del host. Ahora una entrada idéntica salvo esa versión se reconoce propia y reemplazable, y `install` la actualiza en el lugar. El sello de release sigue cumpliendo su función: un binario que quedó atrás tampoco ahora puede confirmar que un host cargó su descriptor.
- **Cada clase de entrada anticuada dice cómo se arregla.** El detalle de la pestaña MCP distingue un descriptor de otra versión (se arregla reinstalando desde el panel) de una forma histórica (sólo la reemplaza `agent-workflow mcp migrate`, que previsualiza lo que pisa), nombra el archivo de cada uno y los hosts afectados. `install` refresca únicamente la primera clase: no migra formas históricas en silencio.
- **Un `install` rechazado deja de anunciarse como exitoso.** El resumen decía «Conexión 'x' instalada en …» aunque no se hubiera escrito nada; ahora dice que no se instaló y nombra el host y el archivo que lo impide.

## [25.1.1] — 2026-09-02

### Fixed

- **La elección adaptativa se presenta como una propuesta de solución comprensible.** Antes de elegir, la vista humana resume hallazgo, diagnóstico, solución, resultado y riesgo; usa «Aceptar propuesta»/«Pedir ajustes» y oculta por defecto ids internos como `quick.review-findings`. `--detail` conserva la traza técnica y las preguntas abiertas por 25.1.0 siguen aceptando sus etiquetas anteriores.
- **Una entrada MCP ajena homónima ya no deja una conexión imposible de retirar.** La TUI identifica el host y archivo en conflicto, explica la acción manual y `remove` elimina el registro y los recibos de Workline cuando no queda ningún descriptor propio. Las entradas ajenas no se modifican; si una de ellas oculta todavía un descriptor propio, la eliminación sigue fallando de forma segura y conserva el registro con una recuperación concreta.

## [25.1.0] — 2026-09-02

### Added

- **`aw flow` incorpora una ruta adaptativa sellada.** Antes de QUICK, SPEC-refine y PLAN, el agente propone sólo controles metodológicos relevantes con recomendación, alternativas, consecuencias y riesgo; la persona acepta toda la ruta o la ajusta sin mover cursor ni efectos. Los gates sin configuración siguen duros.
- **La calidad de evidencia se separa del cierre.** El estado y la directiva registran propuesta, decisiones y `assurance` (`verified`, `partially_verified`, `unverified_accepted`). Una omisión aceptada queda visible como evidencia no ejecutada; una sustitución sólo llega a `verified` al cruzar su propio veredicto. `status`, `resume` y el sello de PLAN nunca presentan evidencia ausente como aprobada.

### Changed

- **SPEC conserva el qué y PLAN el cómo.** Las restricciones técnicas decididas quedan como entrada mínima de PLAN; los planes disponen de `## Implementation decisions`, y QUICK mantiene excepciones de ruta en `DECISION` y `CHECKPOINT` sin crear un documento técnico adicional.

## [25.0.1] — 2026-09-01

### Fixed

- **Un rol PostgreSQL privilegiado ya no bloquea las tools de lectura.** `execute_sql` y `search_objects` continúan dentro de su transacción `READ ONLY` y devuelven `DATABASE_ROLE_UNSAFE` en `warnings[]`; `mcp doctor` lo reporta como advertencia sin salir con error. La validación SQL, la confirmación de `transaction_read_only`, el timeout, el rollback y los límites siguen siendo bloqueantes.

## [25.0.0] — 2026-09-01

**La spec vuelve a ser el «qué» funcional y el plan el «cómo» técnico: cambiar el plan ya no obliga a tocar la spec.** El sello `> Baseline:` digiere el contenido funcional de la spec en vez de sus bytes, los criterios `AC-nn` pasan a ser direccionables, un plan puede nacer de la conversación sin spec, la compactación ya no se retiene nunca, y el quick declara qué va a tocar antes de tocarlo.

### Added

- **`aw reseal prepare|apply <plan>` cierra una divergencia de baseline legítima sin rehacer el linaje.** `prepare` es de sólo lectura y devuelve la línea que escribiría con su digest; `apply` exige ese digest en `--approval`, recomputa toda la preparación bajo el lock del workspace y reescribe únicamente la línea del sello. Es transversal: no abre flujo ni crea sesión. Aprobar AFIRMA que una persona revisó el plan contra la spec vigente; el rediseño sigue siendo `/w:plan-refine`.
- **Un plan sin spec (`> Standalone: <origen>`) es ciudadano de primera.** Se planifica desde la conversación, no sella baseline, el tablero reporta su propio modo `standalone` sin aviso de no-sellado, y sus desviaciones se anotan en el `DECISION.md` de la sesión en vez de en una nota de contrato.
- **El quick declara un preview del arreglo antes de ejecutarlo** —archivos, intención y forma esperada del diff— proporcional a la tarea. Por encima del mismo umbral que dispara el gate de entrada una persona lo aprueba (`Ejecutar tal cual` · `Ajustar el enfoque` · `Escalar a spec`); por debajo no hay parada humana. Fronteras `quick.fix-preview` y `quick.fix-preview-approval`, rechazo `FLOW_PREVIEW_INVALID`, y el preview aprobado queda durable en el estado de la corrida: el sobre de `aw flow` lo expone en esa frontera (`fix_preview`), sobrevive a una compactación y viaja en el paquete de escalación.
- **La compactación degradada deja un refugio.** Cuando la sesión no se resuelve, el PreCompact aparca un `CHECKPOINT` en `.workflow/sessions/.refuge/` con su motivo, sus candidatos y su salida. `resume-summary` lo reporta en `refuge`, y el primer `checkpoint-write` que sí resuelve la sesión lo pliega en su `CHECKPOINT.md` y lo borra.
- **Una fence sin cerrar en la spec se nombra en vez de degradar en silencio.** El tablero informa la línea abierta y `aw reseal prepare` la rechaza con `RESEAL_SPEC_FENCE_UNCLOSED`, porque con el payload vacío el sello cae al byte-exacto y cualquier edición vuelve a divergir.

### Changed

- **El sello `> Baseline:` digiere el payload funcional de la spec, no sus bytes.** Entran `Requirement`, `Scope`, `Acceptance criteria`, `Scenarios`, `Behavioral changes` y `Affected capabilities` —sólo en `##`—, así que editar `## Context` o corregir una coma ya no divergen un plan. La alineación es **dual**: un sello viejo byte-exacto sigue alineando, y la nota de contrato acepta las dos formas. Con el payload vacío se cae al digest byte-exacto.
- **Los criterios de aceptación son direccionables.** Se rotulan `- [ ] AC-nn` y el CLI **deriva** el id `S{NNN}/AC-nn` del rótulo más el número del archivo; escribir el id completo se lee igual, nunca dos veces. Un criterio sin rótulo es lo que queda inalcanzable.
- **La spec no lleva validaciones, tests ni estrategia de verificación**: eso vive en el `## Validations` del plan y en la `Validación de fase` de cada fase, y los gates de `plan-new`/`plan-refine` verifican que cada criterio tenga evidencia. La superficie visible del producto —comandos y flags de un CLI, endpoints de una API, mensajes y formatos observables— es comportamiento funcional, no mecánica de verificación.
- **El gate de desviación de `plan-exec` tiene cuatro salidas, no dos.** Una divergencia técnica que deja la promesa intacta registra una nota sobre `S{NNN}/AC-nn` y la ejecución sigue; sólo se vuelve a `spec-refine` cuando se mueve el resultado que un criterio promete.
- Dentro de una fence el **fin de línea** deja de contar: un checkout con `core.autocrlf` ya no mueve el sello.

### Removed

- **El PreCompact ya no retiene una compactación.** Se retira el outcome `blocked` del destino de ciclo de vida de `checkpoint-write` y su exit 2: siempre sale 0 y degrada con refugio. (El `kind: "blocked"` de una frontera de flujo no tiene que ver y sigue en uso.) `--can-pause` se sigue aceptando y ya no hace nada, para no romper los hooks ya instalados.
- **La configuración `[compaction]` con modos `confirm | auto`**, que ningún código leyó nunca. La doctrina y el registro de flujo describen ahora la única degradación que existe de verdad.

### Fixed

- **El sello se estampaba con un límite de cabecera distinto del que lo lee.** En un plan cuyas fases son `###`, la línea `> Baseline:` aterrizaba dentro del bloque de una fase y se releía `absent`: el plan quedaba divergente para siempre y `aw reseal` lo rechazaba como si no tuviera cabecera.
- **La adopción del refugio podía perderlo.** Ahora se comprueba que el bloque quedó escrito antes de borrar el refugio, y ningún fallo de `fs` durante la adopción puede escapar: una excepción salía con exit 1, que es exactamente cómo un host retiene su compactación.
- Un enlace relativo roto en `modules/PROMPT-CONTINUITY.md`, con un guard nuevo que recorre los enlaces de toda la doctrina y exige cero rotos.

### Migration

- **Corré `aw self install-hooks` después de actualizar.** El PreCompact instalado sigue funcionando, pero el prompt de PostCompact viejo nunca menciona el `refuge`, así que una compactación degradada no te muestra dónde quedó aparcado el estado.
- **No mezcles 24.x y 25.x sobre el mismo workspace.** Un plan sellado por 25.x se lee **DIVERGENTE** bajo 24.x, que sólo compara el digest byte-exacto. Al revés sí funciona: la alineación es dual y los sellos viejos siguen valiendo.
- Las filas nuevas del registro de flujo tapian una corrida **quick en vuelo** parada en o después de `quick.deliverable-authoring` (`FLOW_RUN_AHEAD_OF_JOURNEY`, y `aw flow advance --adopt` no la recupera). Cerrá o descartá esas corridas antes de actualizar.

## [24.0.0] — 2026-09-01

**El runtime MCP deja de depender de DBHub, `npx`, la red y el `PATH` para servir PostgreSQL.** Workline publica un catálogo único de tools de lectura, verificable por protocolo, con la misma vía local directa cuando el host todavía no cargó MCP.

### Added

- **`tool list` y `tool call` ejecutan directamente las tools PostgreSQL.** `execute_sql` y `search_objects` comparten catálogo, validación y JSON canónico con MCP; `--input-json -` recibe el input por stdin sin entrar a logs operativos.
- **`mcp serve-db` implementa el servidor stdio de Workline.** Cada llamada abre una conexión PostgreSQL aislada, transacción `READ ONLY`, timeout de 30 s, rollback y límite de 1.000 filas / 4 MiB.
- **Recibos y probes separan configuración, launchability, recarga y carga real del host.** La TUI muestra el estado por host y Codex ofrece el comando local equivalente porque MCP sigue siendo opcional.
- **`mcp migrate` previsualiza y migra sólo shapes históricos propios.** Reconoce legacy, foreign, malformed y current sin sobrescribir una entrada ajena.

### Changed

- **Los descriptores globales usan Node y entrypoint absolutos**, namespace, instancia y host explícitos; no usan shell, `cmd /c`, `npx`, caché ni variables de entorno para arrancar.
- **`mcp-connections.json` pasa a v2 con `provider: "postgres"`.** Las entradas v1 se interpretan en memoria como PostgreSQL y sólo se reescriben mediante una acción explícita.
- **Doctor comprueba el lifecycle MCP y la postura del rol PostgreSQL.** Superuser y privilegios de servidor peligrosos bloquean la ejecución; permisos de escritura quedan como advertencia y no acreditan una conexión segura.

### Removed

- **`mcp dbhub` ya no ejecuta `@bytebase/dbhub`.** Conserva durante una versión el nombre como alias deprecado de `mcp serve-db`, con las dos tools Workline publicadas.

### Migration

- Revisá primero `aw mcp migrate --host <host> --all-connections --global`. La escritura exige `--apply --force`; no se migra, reinstala ni reinicia ningún host automáticamente.
- Rotá cualquier credencial que hubiera quedado embebida en descriptores DBHub legacy y usá un rol PostgreSQL de mínimo privilegio.

## [23.0.0] — 2026-08-25

**Workline deja de exigir un scaffold antes de ser útil, y `plan-exec` pasa a conservar toda la evidencia de sus iteraciones.** La raíz se resuelve desde el marcador más cercano —o el cwd exacto—, las primeras escrituras materializan sólo el runtime y el pipeline ya no puede ofrecer una continuación contradictoria con su estado.

### Changed

- **El workspace es implícito por defecto.** `status`, `resume`, TUI, skills, flows y checkpoints comparten una única raíz resuelta; `workspace-init` sin fuentes sólo materializa el runtime mínimo.
- **`plan-exec` usa estado v10.** Los batches se sellan antes de ejecutarse, el preview de decisión queda durable antes de elegir y el cierre vuelve a comprobar tareas, fases, validación, Git e integración.
- **La elicitation MCP valida y conserva respuestas libres**, negocia el lifecycle legacy de forma explícita y trata una entrada homónima ajena como conflicto sin escribirla.

### Removed

- **Ya no se admite reanudar implícitamente una corrida legacy activa.** Una corrida v7–v9 requiere `aw flow advance --adopt`; no se migra ni re-sella al leerla.
- **`workspace` deja de ser un alias configurable** y el estado MCP especulativo `usable` desaparece.

### Migration

- Materializá por anticipado con `aw workspace-init` sólo si necesitás el runtime antes de la primera mutación.
- Para continuar una corrida legacy, confirmá su flow y usá `aw flow advance --code <NNN> --flow <flow> --adopt`.

## [22.4.2] — 2026-08-22

**La razón del fallback de codex crecía entre la condición y su consecuencia.** La cláusula generada quedaba `When A — B; C, so D, fall back to E`: tres oraciones intercaladas antes de decir qué hacer. El estampado se lee en cada invocación de cada superficie de ese host, así que una cláusula que obliga a releerla es un costo real.

### Fixed

- **La razón del fallback cierra su aposición entre paréntesis**, de modo que `When … (…), fall back to labeled markdown` vuelve a leerse de una pasada. Ningún dato se perdió: el modo por defecto, `codex exec`, el opt-in que no alcanza, su fecha de prueba y el cambio de modo del TUI siguen todos nombrados.

## [22.4.1] — 2026-08-22

**El estampado de codex mandaba a un opt-in que no sirve.** La 22.4.0 dejó la razón del fallback diciendo que `default_mode_request_user_input` "sigue *under development*" — que se lee como *activalo y funciona*. Tres turnos reales por `codex debug app-server send-message-v2` probaron lo contrario: con el flag en `true` (y `codex features list` reportándolo así), el modelo sigue contestando que la herramienta no está disponible en Default mode, y ahí mismo pide que se active el modo Plan. Forzar `-c collaboration_mode=plan` tampoco la trae, porque un modo se cambia por slash command del TUI y no por config.

### Fixed

- **La razón del fallback de codex nombra la vía que sí existe.** Deja de sugerir el opt-in —dice que activarlo **no** agrega la herramienta— y nombra el cambio de modo en el TUI (`/plan`, `/pair`) como el movimiento de la persona, nunca del agente. Un agente que leía la versión anterior podía perseguir un flag inútil o, peor, intentar escribir en la config del host.
- **`HARNESS.md` fecha el probe y sus límites.** La celda de codex y la nota de evidencia registran los tres turnos, que `ModeKind` tiene seis valores (`plan|default|code|custom|execute|pair_programming`), y que el canal del probe **no tiene TTY** —lo que la herramienta exige—, así que lo que queda probado es que el opt-in no es la palanca, nunca que un modo interactivo falle.

### Added

- **La vía nativa independiente del modo queda registrada.** El handshake MCP de codex, capturado en el mismo probe, anuncia `capabilities.elicitation {form, url}`, y el host usa ese mismo mecanismo para sus propias aprobaciones de tools: un servidor MCP puede rendir un formulario nativo incluso en Default mode. Es doctrina en `HARNESS.md`, no todavía una capacidad del CLI.

## [22.4.0] — 2026-08-22

**El estampado de codex ordenaba «markdown siempre» contra un runtime que ya trae el picker completo.** La re-sonda del 2026-08-22 sobre codex-cli 0.149.0 encontró el overlay TUI de `request_user_input` terminado —selección, respuesta libre y fila `Other`— y un gate que dejó de ser la negativa categórica de 0.146.0: hoy es **la lista de tools del turno** («use it only when it is listed in the available tools for this turn», dice su propio prompt embebido). Peor: ese mismo prompt **prohíbe presentar multiple-choice como texto**, que es exactamente el fallback que el estampado ordenaba, así que en Default mode el host empuja al modelo a preguntar en prosa vaga en vez de mostrar el tablero de opciones.

El binding degradado pasa de negar la herramienta a **usarla exactamente cuando el turno la ofrece**, el fallback queda blindado contra el prompt del host, y los estampados nativos ganan la frase de forzado que faltaba.

### Changed

- **El estampado degradado-con-herramienta ordena usar el tool cuando el turno lo lista**, con sus techos (3×3 en codex), sus campos y la regla de no duplicar `Other`; cuando el turno no lo lista, cae a markdown etiquetado nombrando la razón accionable — Default mode lo deja fuera mientras el opt-in `default_mode_request_user_input` (`[features]` en `~/.codex/config.toml`) siga *under development*, y `codex exec` nunca lo soporta. Autocurativo: si un modo lo lista o el opt-in madura, el picker nativo se usa **sin re-release**.
- **La contra-instrucción al prompt del host cierra el estampado degradado**: «Even where this host's own guidance prefers a plain-text question, a Workline boundary still presents every option». Sin ella, la doctrina del host y la de Workline chocan en silencio y gana la que borra las alternativas.
- **Los estampados nativos ganan una frase de forzado**: «While it is reachable, never render a boundary as plain prose instead» — una frontera presentada como prosa teniendo la herramienta alcanzable es un defecto, no un estilo.
- **El catálogo de codex queda re-fechado al 2026-08-22 sobre 0.149.0**, leído del binario: overlay completo, gate por turno con los literales `not supported in exec mode`, `requires an interactive stdin terminal` y `can only be used by the root thread`, y `customAnswer: true` (fila `Other:` + flujo free-form propios). El detail del doctor (`structured-choice`) dice cuándo SÍ se usa en vez de sólo negar.
- **Evidencias re-verificadas al 2026-08-22** para kimi 0.36.1, opencode 1.18.15, crush v0.90.0 y oz v0.2026.08.19 — bindings sin cambio, fechados contra lo que hoy está instalado. `HARNESS.md` re-fecha la fila structured-choice, reescribe su nota de evidencia y corrige la celda de codex a la semántica por turno.

### Notes

- **Nada que migrar.** claude/kimi/agy/opencode/crush conservan su binding; lo que cambia en sus wrappers instalados es la frase de forzado. agy sigue en 1.0.16, la misma versión de su evidencia vigente.
- **Verificar el picker en un codex interactivo es un handoff**, nunca condición de cierre: con la skill re-estampada, un modo que liste el tool (p. ej. Plan) debe presentar la frontera con el overlay nativo.
- **Vía futura anotada:** `tool_call_mcp_elicitation` está *stable* y activo en codex 0.149.0 — un servidor MCP de Workline podría pedir input estructurado nativo incluso en Default mode (BACKLOG de la sesión 139, candidato a spec).

## [22.3.1] — 2026-08-18

**Dos entradas del catálogo quedaron fechadas antes de la verificación que las respalda.** `crush` decía haberse verificado el 2026-08-04 contra v0.87.0 y `opencode` el 2026-08-04 contra 1.18.5, mientras `HARNESS.md` y las notas de la 22.3.0 declaran el contrato fechado el 2026-08-18 contra crush v0.89.0 y opencode 1.18.15 — que es contra lo que se leyó de verdad.

Ninguna afirmación de comportamiento era falsa: esas verificaciones ocurrieron y su conclusión se sostiene. Lo que estaba viejo era la fecha de la evidencia, que es justamente el dato por el que existe el campo.

### Fixed

- **`verified` de crush y de opencode** pasa a nombrar la lectura del 2026-08-18: el doc embebido de crush v0.89.0 más el esquema `config.HookConfig` de su binario, y el doc de plugin embebido de opencode 1.18.15 con su firma `Plugin`, su superficie de hooks y sus directorios. `claude`, `codex` y `kimi` no se tocan: sus entradas siguen fechadas en la verificación que efectivamente las respalda.

## [22.3.0] — 2026-08-18

**El catálogo describía mecanismos de hooks que sus hosts no tienen.** crush figuraba sin hooks y los tiene; gemini nombraba un evento —`BeforeTool`— que no aparece ni una vez en el binario de `agy`; opencode nombraba su evento sin decir nunca dónde vive su plugin. Y lo que ninguna entrada decía era lo que más importa: cuál de los cinco eventos de la plantilla llega de verdad a cada host. Un lector suponía paridad, y en tres de ellos viaja el **enforcement** y no la **resumabilidad**.

Cada entrada del catálogo pasó a ser un contrato verificable —dónde viven los hooks, en qué forma, qué evento viaja y cuál no con su razón, y contra qué runtime se verificó— y sobre ese contrato crush y gemini quedaron administrados, codex genera su bundle de plugin y opencode su módulo. Nada que migrar.

### Added

- **Contrato de hooks por host.** `HarnessHooks` declara su `artifact` (la ruta y la forma contra la que se escribe un instalador), un `Record` sobre los **cinco eventos de la plantilla** donde cada host contesta `carried`, `degraded` u `omitted` con su razón, y un `verified` fechado con el runtime que se leyó. Es un `Record` sobre la unión cerrada a propósito: un host nuevo sin respuesta para un evento **no compila**.
- **crush y gemini quedan administrados.** `aw self install-hooks --target crush|gemini` escribe el artefacto y `aw self uninstall --with-hooks` lo retira. En crush los hooks se mergean dentro de su propio `crush.json` junto a los del usuario; en gemini viven bajo un hook con nombre en `~/.agents/hooks.json`. La propiedad es por entrada y por comando: un hook ajeno —incluso uno que se llame como el nuestro— se conserva.
- **Los matchers se TRADUCEN, nunca se copian.** Los de la plantilla nombran tools de Claude (`Edit`, `Bash`); crush los llama `edit`/`write`/`multiedit`/`bash` y agy usa sus step types en minúscula (`file_change`, `run_command`). Copiar el matcher instala un hook que **no dispara nunca** y soltarlo lo hace disparar en **todos** los tools, así que un matcher sin traducción **salta su hook y lo declara**.
- **La vía de plugin de Codex se genera.** `aw self install-hooks --target codex` escribe un bundle (`.codex-plugin/plugin.json` con `"hooks": "./hooks.json"` y los cinco eventos verbatim) bajo `~/.agent-workflow/codex-plugin/`, y reporta el estado nuevo **`generated`**, nunca `installed`: codex instala plugins **por marketplace** y ese paso es de la persona. Ninguna rama escribe un `trusted_hash`.
- **opencode recibe un módulo de plugin generado**, declarado en `opencode.json`, que registra `tool.execute.before` y **traduce en los dos sentidos**: sus tools al payload de Claude que los hooks leen, y el exit 2 del CLI a un `throw` que bloquea. El guard de SQL no viaja —su matcher no nombra ningún tool de opencode que el puente pueda producir— y la omisión queda escrita en el encabezado del propio módulo.
- **Guards de catálogo nuevos**: los eventos declarados son exactamente los de la plantilla del bundle y en su orden; todo host con hooks contesta los cinco; el mecanismo que se imprime no nombra un evento que el host omite.

### Changed

- **`aw self install-hooks` deja de contestar `unsupported` en crush, gemini, codex y opencode.** Sólo warp y oz siguen ahí, que no tienen sistema de hooks.
- **El mecanismo que imprimen las superficies se DERIVA del contrato** en vez de ser una frase escrita a mano por host — que es lo que dejó tres entradas mintiendo sin que nada fallara. Junto a él viaja la cobertura: qué eventos lleva ese host y cuáles omite.
- **`HARNESS.md`** corrige la fila de enforcement de gemini y crush, fecha el contrato al **2026-08-18** y agrega el bloque que explica, host por host, qué viaja y qué no.

### Fixed

- **Un host apagado en `[Config]` ya no aparece en el resto de la TUI.** La preferencia existía y sólo la respetaba el tile de status: la sección de administración de hosts y el selector de destino de MCP lo listaban igual y ofrecían instalarle cosas. Ahora lo filtran y sus contadores cuentan los visibles; `[Config]` sigue mostrándolos todos, que es donde se reactivan.
- **Un host oculto con instalación se reporta en vez de esconderse.** Si un host apagado tiene skill o hooks instalados, la pantalla que lo ocultó lo nombra en una línea: ocultarlo en silencio dejaba un artefacto sin forma de retirarlo desde la TUI.
- **El atajo `i` del estado vacío dejaba de funcionar con claude apagado.** Buscaba `claude` en una lista que ya no lo tenía y quedaba en un no-op silencioso mientras la barra seguía ofreciendo «install on Claude»; ahora instala en el primer host listado y la etiqueta lo nombra.

### Notes

- **Nada que migrar.** Los hosts que ya estaban administrados —claude y kimi— no cambian de comportamiento, y `~/.codex/hooks.json` sigue siendo lo que el catálogo declara para codex: lo que se agrega es la segunda vía, la del plugin.
- **El contrato es del checkout, no de un host corriendo.** Todo lo de arriba se verifica con tests y fixtures locales sobre HOME temporal. Observar que un crush, un agy o un opencode instalados cargan lo generado —e instalar el bundle de codex por marketplace— es un handoff opcional, nunca una condición de cierre.
- **Los runtimes que se leyeron para fechar el contrato**: crush v0.89.0, agy 1.0.16, codex-cli 0.147.0 y opencode 1.18.15.

## [22.2.0] — 2026-08-18

**El tablero listaba todo sin decir qué le faltaba a nada, y `resume` decía qué le faltaba a uno sin listar el resto.** Las dos superficies necesitan la misma lectura —por cada pendiente, qué le falta— y existía a medias y en el lugar equivocado: la derivaba `resume-service`, y sólo para la cabeza del pipeline o sus empates. El resultado observable era una vista engañosa: un plan con todas sus tareas hechas y sus 6 fases validadas aparecía como `plan 031 — 100%, fases 6/6`, sin decir que lo que le faltaba era la validación final y el cierre.

Nada que migrar: el cambio es aditivo de punta a punta.

### Added

- **Cada pendiente dice qué le falta.** La vista por defecto de `aw status` muestra, además del título y el comando, el paso siguiente que continúa el ítem. Un plan ejecutado sin cerrar dice que falta la validación final y el cierre; una fase bloqueada nombra su motivo declarado, y si el bloqueo no declara ninguno lo dice así.
- **Una obligación se nombra antes que el porcentaje.** Lo que deja un ítem ni ejecutable ni cerrable —una referencia de diseño irresoluble, una reconciliación pendiente, un baseline que nadie puede probar— toma el titular y el progreso baja debajo. Leído en el otro orden, el número es la parte que la gente cree.
- **`PipelineItemDetail`: el detalle por ítem se deriva UNA sola vez**, en la proyección compartida que ya aloja el pipeline, y viaja en el ítem (`objective`, `progress`, `next`, `obligation`). `resume` lo consume en vez de recalcularlo, así que las dos superficies no pueden describir el mismo ítem de dos maneras distintas.
- **`aw resume` sin target ofrece TODOS los pendientes.** El envelope gana `candidates` con el pipeline completo en el orden que ya decide el CLI, conservando `proposal` como la recomendación. Antes ofrecía sólo la cabeza y sus empates, así que los planes abiertos que `status` listaba quedaban fuera de la oferta.
- **`uninitialized`: un pipeline vacío por falta de workspace deja de leerse como «nada pendiente».** Ambas superficies lo dicen y proponen `/w:workspace-init`. Sin nada pendiente de verdad, `aw status` responde en una línea y no imprime secciones ni avisos vacíos.
- **Las sesiones sueltas se reportan como aviso propio**, con su cuenta y cómo verlas (`loose_sessions` en el envelope). La mecánica de sesión es del workline central: un checkpoint suelto compitiendo por atención con un plan abierto le pedía a una persona hacer la contabilidad del runtime.
- **Guard de doctrina G20**, que fija la regla nueva en `commands/status.md` y `commands/resume.md` para que ninguna superficie la pierda en silencio.

### Changed

- **`checkpoint-orphan` deja de ser una clase de trabajo del usuario en el pipeline.** La clase **no** desaparece del modelo; sale de la lista de pendientes y pasa al aviso, así que `counts.pending` cuenta trabajo documental.
- **`candidates` pasa de ser los empates a ser el pipeline completo** en la ruta sin target. Con empate en cabeza no hay una recomendación única, y el `action` dice cuántos empatan sobre cuántos pendientes hay.
- **La cadena de precedencia se movió entera, sin re-cortarla**: diseño irresoluble → fase bloqueada → reconciliación pendiente → plan inconsistente → baseline sin probar → validación final pendiente → primera fase no validada. Un plan con fase bloqueada y reconciliación pendiente sigue reportando la fase bloqueada.
- **`commands/status.md` y `commands/resume.md` declaran cómo se presenta la elección**: análisis breve antes de elegir, una opción por candidato en el orden del CLI, agrupación por clase en hasta 3 preguntas, degradación declarada a markdown rotulado con todos los candidatos, y que elegir invoca el comando en el mismo turno. `commands/workspace-init.md` se comprimió para respetar la mediana de activación del presupuesto de contexto, sin retirar ninguna regla.

### Notes

- **Sólo cambios aditivos en el modelo JSON.** Ningún campo de `aw status` ni de `aw resume` se retiró ni cambió de significado: el envelope de `status` gana `loose_sessions`, `PipelineItem` gana `detail`, y `resume` gana `candidates` y el estado `uninitialized`. La acción `board` del motor de flow y `runResumeSummary` —que alimenta el hook de precompactación— siguen leyendo lo mismo.
- El presupuesto de contexto cierra en verde en sus tres tramos sin re-congelar el baseline: `activation.median` queda en 2528 contra un techo de 2532, el mismo valor que antes del cambio.

## [22.1.0] — 2026-08-16

**Un plan y su spec pueden volver a estar de acuerdo sin rehacer ninguno de los dos.** Hasta acá, cuando la ejecución encontraba una divergencia con la spec, las únicas salidas eran seguir de largo o rehacer el linaje entero: el gate de desviación era doctrina sin máquina y el recorrido lo auto-aplicaba hasta el commit. Ahora la corrida se detiene, ofrece cuatro salidas, y la componible registra una decisión durable que enmienda el contrato sin reescribir lo que ya se validó.

Guía de migración: [`docs/migracion-baseline-y-decisiones.md`](docs/migracion-baseline-y-decisiones.md). **No hay que migrar nada**: los planes sin sello se leen `unsealed` y se cierran igual, y una corrida en curso se lee y se re-estampa sola.

### Added

- **El plan sella el baseline exacto de su spec.** Una línea `> Baseline: <spec>@sha256:…` en el blockquote de cabecera, estampada por la publicación —nunca a mano— para que vista previa, aprobación y escritura cubran la misma cosa. Se lee `aligned`, `divergent`, `unsealed` o `malformed`, y ninguna de las cuatro se degrada a otra.
- **Notas de decisión durables**, selladas y append-only, en `docs/decisions/<spec>-decisions-<slug>.json`. Categoría **no relocalizable**: `flow`, `status` y `resume` tienen que encontrar la misma cadena. Una nota vive FUERA de lo que decide — guardarla adentro cambiaría el digest del documento y el contrato enmendado dejaría de ser el que se enmendó. Corregir una nota es publicar otra que la sustituya por referencia.
- **`composeEffectiveContract`: el contrato efectivo se deriva en UNA sola función.** Compone las notas vigentes en orden sobre el baseline, o **bloquea** con su acción correctiva (`CONTRACT_OVERLAP`, `CONTRACT_ASSERTION_ABSENT`, `CONTRACT_BASELINE_ABSENT`, `CONTRACT_CONTRADICTION`). No hay tercera respuesta donde gane la más nueva.
- **Vista previa y autorización únicas.** Antes de decidir se muestran las ocho cosas que la decisión necesita —baseline, cambio efectivo, consumidores, impacto, evidencia conservada e invalidada, obligaciones, punto de retorno y efectos locales—, todas derivadas del contrato compuesto y de la nota sellada. Elegir una alternativa registra la nota y autoriza exactamente esos efectos, **sin una segunda confirmación**. Nunca cubre efectos destructivos ni de red externa.
- **Obligaciones compensatorias.** Una decisión que invalida trabajo cerrado **no lo destilda ni lo edita**: la fase sigue `validada` y sus casillas marcadas. Aparece trabajo nuevo del contrato efectivo, ligado a su nota, y el plan deja de ser cerrable hasta saldarlo.
- **`status` y `resume` proyectan el contrato efectivo**, las notas que aplican y la reconciliación pendiente. Cada consumidor conocido se lee `aligned`, `pending-reconciliation`, `historical` o `unproven`.

### Changed

- **`plan-exec.deviation-gate` pasa de `cli` a `human`, con cuatro salidas**: registrar la decisión y seguir (recomendada), volver a `plan-refine`, volver a `spec-refine`, o escalar a una spec nueva. Las tres últimas arman un paquete de escalación que el destino declara consumido — `spec-refine` y `plan-refine` ganaron su fila de adopción como primera fila de juicio.
- **La elegibilidad de la salida componible es cierre, no tamaño**: linaje, intención, impacto y recuperabilidad, no cuántas líneas cambian.
- **Las observaciones de una corrida se acumulan** en vez de reemplazarse, así que más de una divergencia en una misma corrida sobrevive entera.
- **Estado de corrida 8 → 9** por un campo opcional (`continuation`). Se leen las versiones **9, 8 y 7**: una corrida a mitad de camino se lee tal como estaba y se re-estampa en su primera escritura. La continuidad mueve la posición en el PLAN y **nunca el cursor del recorrido**, que sigue siendo una pasada lineal append-only.
- **`resume` deja de reportar «sus contadores no lo respaldan» sobre un plan sano.** Un plan retenido por una obligación tiene los contadores cuadrados: lo que se debe es trabajo, no un arreglo del documento.

## [22.0.1] — 2026-08-15

**El gate source-bounded era insatisfacible en un workspace con el árbol sucio, grande y con acentos.** `aw flow submit` rechazaba toda evidencia `workline.source-bounded` con `WORKLINE_CHECKOUT_PROOF_STALE` —«el checkout cambió desde que se capturó la prueba»— sin que el checkout cambiara. No había respuesta correcta posible y cada intento quemaba uno de los tres de la frontera. Como los cinco loops exigen esa evidencia para converger, el workspace afectado se quedaba sin ruta de cierre por `aw flow`.

### Fixed

- **La salida de un proceso se decodifica una sola vez, sobre el flujo entero.** Se acumulaba con un `toString()` por chunk: toda secuencia UTF-8 multibyte partida en un borde de pipe se volvía carácter de reemplazo, y dónde parte un pipe no es estable entre corridas. Medido sobre un diff de 4,5 MB en español: 4.500.324 bytes tras decodificar contra 4.500.171 reales. Alcanza a toda lectura de git con acentos, no sólo a la huella.
- **La huella del checkout se hashea en bytes y no se decodifica en ningún punto.** `git diff --binary` es binario por su propio flag; convertirlo a texto ataba el digest a una codificación que no le aporta nada. Con eso `checkoutDigest` dejaba de ser reproducible, y como `validateCheckoutProof` lo compara contra un recálculo del momento, ningún valor podía coincidir jamás.
- **Un archivo sin trackear que git no puede hashear deja de tirar el checkout entero.** Un symlink colgante, un enlace a un directorio o un archivo sin permiso de lectura hacían fallar su `hash-object`, y ese fallo descartaba la fuente completa del conjunto elegible: el submit contestaba `WORKLINE_CHECKOUT_PROOF_INVALID` —«la fuente no pertenece al checkout adquirido»— sobre un checkout que existe y es legible, de forma permanente mientras el enlace existiera, y quemando un intento cada vez. Es el mismo bloqueo por otra puerta: ahora la entrada se hace constar en la huella y el resto del árbol se sigue probando.
- **El tamaño de un blob en conflicto vuelve a ser el que git guardó.** `readStage` medía bytes sobre el texto ya decodificado, así que un blob que no fuera UTF-8 se reportaba con otro tamaño.
- **Dos mensajes de error dejan de llegar mutilados**: el de una conexión MCP que falla y el de un `git` de instalación de skills acumulaban su stderr con el mismo defecto.

### Changed

- **Un rechazo por fuente inválida nombra las elegibles.** `WORKLINE_CHECKOUT_PROOF_INVALID` decía qué fuente no pertenecía al checkout adquirido, no cuáles sí. Son `workspace` y las unidades aisladas de la sesión, nunca la ruta real del repo declarado en `Fuentes`, y averiguarlo costaba intentos de frontera.
- **Un digest que no sobrevive a su propio recálculo se informa como tal.** El submit toma la huella dos veces, en paralelo, y cuando difieren el rechazo dice que el árbol cambia mientras se valida o que la huella no es reproducible, en vez de mandar a buscar un cambio que puede no existir. Sigue siendo `WORKLINE_CHECKOUT_PROOF_STALE`: el vocabulario de códigos no cambia.

### Notes

- **Una prueba capturada con 22.0.0 puede vencer una vez al validar con 22.0.1**, y sólo si su árbol disparaba el defecto: un diff no-ASCII que superara un chunk. En ese caso no existía prueba válida posible, así que recapturarla era el camino de todos modos. Un árbol limpio, o uno cuyo diff sea ASCII puro, conserva su digest.

## [22.0.0] — 2026-08-15

### Breaking

- **Los marcadores QTC se retiran de inmediato.** No habrá alias, lectura dual ni migración automática en v22. Un workspace o integración que todavía los use debe migrarlos con v21.17.0 antes de actualizar.
- **La ejecución queda limitada al checkout.** Una fase sólo cierra con evidencia local del checkout y fuentes declaradas. Una lectura remota puede informar research, pero no validar ni cerrar trabajo.
- **`mcp-connections.json` es la única autoridad de conexiones.** Registrá cada conexión con `aw self mcp use-env`; si hay varias, las operaciones directas requieren `--instance <nombre>` y el fan-out explícito es `--all-connections`.

### Migration

- Antes de actualizar, conservá v21.17.0 para revisar y aplicar la migración de marcadores legacy. Refiná cada plan v21 abierto al contrato de fuentes y límite `checkout` antes de iniciarlo con `plan-exec`.
- Consultá la guía pre-v22 del workspace documental para el orden de preparación, los ejemplos de registro MCP y la separación entre evidencia local y handoffs operativos.

### Notes

- Push, publicación en npm, aplicación de SQL y comprobaciones contra hosts o productos desplegados son handoffs operativos. No bloquean ni certifican el cierre local de una fase.

## [21.17.0] — 2026-08-15

**Publicar un paquete de diseño podía dejar el árbol sin lo que lo hace legible y reportar éxito igual.** Cuando la publicación no derivaba su destino escribía los artefactos autorados verbatim —sin línea base, sin manifiesto, sin gate— y el recibo decía `completed`; `aw designs` rechazaba después ese mismo árbol. En paralelo convivían dos implementaciones del sellado: la que corría, y otra sin llamadores que concentraba la mayor parte de las pruebas.

### Changed

- **Una sola implementación viva del sellado.** Sobrevive la del manejador, y el criterio importa: la retirada escribía directo, salteando el sello de propuesta, la vista previa y la aprobación que atraviesa todo efecto durable — conservarla era conservar un segundo camino de escritura sin frontera de aprobación. Su cobertura se migró repartida por lo que cada caso pregunta.
- **La madurez sale del catálogo que se publica**, con una sola función sobre el manifiesto: la misma pregunta para el árbol que una publicación va a dejar y para el ya publicado, así que el recibo y la validación posterior no pueden contradecirse sobre el mismo árbol. `handoff` pasa a ser alcanzable, y quien no lo alcanza recibe su razón.

### Fixed

- **Ningún recibo declara `handoff` sobre un paquete que no lo alcanza.** Había dos caminos: juzgar sólo los archivos que la revisión introduce —una revisión de tokens salía handoff mientras el flujo vigente seguía en outline— y filtrar los claims por lo que `currentness` marca, que descarta todo artefacto no enumerado, cosa perfectamente legal. Ahora la vigencia la resuelve el mismo criterio que ya usaba el gate de contenido, que cae a la revisión más alta por artefacto cuando el manifiesto calla.
- **Publicar deja el árbol legible, o no publica.** Nada se escribe cuando la operación se rechaza.
- **Dos diagnósticos recuperados** que sólo tenía la implementación retirada: un paquete roto se distingue de uno inexistente, y una identidad reclamada por dos paquetes se informa en vez de resolverse eligiendo el primero.
- **Una operación fuera de un workspace deja de emitir un contrato insatisfacible**, que quemaba una ronda de autoría sin poder aplicar nunca.

### Notes

- **Las dos operaciones que no acuñan revisión conservan su contrato.** Una proyección la deriva el CLI del manifiesto y una decisión de gobierno se sella dentro de él: publicar sus artefactos sin línea base no es el defecto, el defecto era que el recibo no lo dijera. Publican dentro de un paquete ya indexado declarando que no sellan, y se rechazan sólo cuando no hay paquete donde escribir. Romperlas o retirarlas habría sido la misma mentira movida de sitio.
- **El protocolo de la capacidad se lee en `aw capability --help`** —qué repite cada verbo, qué viaja por entrada estándar y de dónde sale cada digest—, con el precedente de `aw flow --help` y sin costo de presupuesto del bundle.
- **Un hueco que este trabajo destapó y no cierra:** la suite retirada probaba que publicar el documento y su revisión era una transición todo-o-nada. Como la función nunca tuvo llamadores, esa transición **nunca estuvo implementada**; lo que se retira es la prueba de una promesa que nadie cumplía. Queda anotada en el código, en el lugar exacto donde vivían esos casos.

## [21.16.0] — 2026-08-15

**Validar y aplicar una exportación exigían repetir los mismos flags de alcance, y aun repitiéndolos el rechazo por vencimiento llegaba igual por dos causas que nadie controlaba.** El protocolo rearma el pedido desde el workspace en cada etapa —diseño deliberado—, pero el sello cubría además el próximo número correlativo del destino y la fecha del día: numerar en ese directorio entre dos etapas, o cruzar la medianoche, vencía una preparación cuyo alcance no había cambiado. Y el mensaje sugería volver a preparar, que es una pista falsa.

### Added

- **El alcance viaja con lo preparado** y vuelve en el sobre, así que `validate` y `apply` lo leen en lugar de re-derivarlo. Sigue sellado: un eco alterado no pasa. Si la invocación repite un flag con OTRO valor se rechaza en vez de elegir uno en silencio; repetir los mismos valores funciona igual que antes.
- **El destino de una categoría se declara en `[docs]` de `skills.toml`**, con la cascada que ese archivo ya tiene. Un workspace cuyo canon documental difiere del que la política asumía dejaba dos árboles paralelos. Es fail-closed —un canon ilegible no publica— y sólo acepta destinos documentales: apuntar al runtime del CLI habría publicado unidades que el workspace luego enumera como sesiones fantasma.
- **El sobre de `validate` se lee en la ayuda del comando**, con sus cuatro cabeceras obligatorias y su nombre exacto.

### Fixed

- **`apply` ya no puede escribir fuera del destino aprobado.** La renumeración sustituía el primer `NNN-` de la ruta entera: inocuo mientras las carpetas eran literales, pero con un canon numerado (`docs/003-manuales`) se comía ese número y publicaba en `docs/001-manuales` — una carpeta que nadie aprobó, ausente de los destinos permitidos y que nada aguas abajo re-verifica. Ahora se renumera sólo el último segmento.
- **Omitir una cabecera del sobre nombra el campo que falta**, en vez de reportar un valor indefinido o disfrazarlo de vencimiento.
- **El remedio que sugiere un vencimiento corresponde a quien lo lee.** El protocolo lo comparten `persist`, `fix-git`, el recorrido y la capacidad de diseño, y ninguno lleva alcance en su sobre: prometerles uno los mandaba a buscar algo que ahí no existe.
- **Una fecha malformada se rechaza al preparar.** Se aceptaba, se acuñaba el destino con ella, y el reproche caía después sobre quien la había copiado tal cual, como se le pedía.

### Notes

- **Doctrina de estado final neto.** La consolidación de scripts declara ahora qué publica —lo que nace y muere dentro de la secuencia se omite, lo migrado va a su forma final, y la reversión es el inverso del estado final en orden seguro para sus dependencias—. Vive en el contrato del request y no en el bundle: el presupuesto de contexto tenía 121 bytes de margen contra unos 700 que ocupa, y lo único comprimible era resumen legítimo. Límite conocido: quien redacte sin pasar por el comando no la ve.

## [21.15.0] — 2026-08-15

**El bloque que el CLI administra dentro de `CLAUDE.md` y `AGENTS.md` adoptaba lo ajeno o lo borraba, según dónde estuviera escrito.** Su recorrido era posicional: abierta la sección de ramas, cualquier línea con forma de par clave-valor se tomaba como una rama más y el render la devolvía anidada bajo ese encabezado, perpetuándola. Y lo que cayera fuera de esa sección corría peor suerte: desaparecía sin aviso en la reescritura siguiente.

### Changed

- **Una rama se reconoce por su forma más una clave que el bloque ya declara**, no por dónde aparece. Una nota que se parece a un registro deja de convertirse en una rama de trabajo.
- **Lo ajeno se conserva verbatim, en el lugar donde estaba.** Cada línea preservada viaja con el registro que la precedía, así que una nota entre «Última actividad» e «Histórico» vuelve exactamente ahí. Se conserva en vez de declararse perdida porque declarar sigue destruyendo. Una sección propia entera —un `## Notas` con su cuerpo— también sobrevive: las cuatro secciones del bloque se leen por nombre, así que todo lo que viviera bajo otro encabezado era invisible para el parser y no volvía nunca.
- **Lo que el CLI escribió y ya no puede honrar se poda y se declara**, y la declaración aparece en la vista humana, no sólo en el JSON: `workspace-init` tiene proyección humana, así que el JSON no se imprime por defecto y una pérdida declarada sólo ahí no llegaba a nadie.
- **Reconciliar poda las ramas cuya fuente ya no se declara.** Antes la fuente salía de la tabla y su rama quedaba huérfana.
- **Cambiar el nombre del proyecto preserva su descripción.** Pasarlo reemplazaba la sección entera, borrando la prosa con exit 0 y sin advertencia.
- **La vista previa corre el mismo plan que la corrida**, y distingue lo que ya existe de lo que se va a crear. Informaba valores enlatados, idénticos en un workspace virgen y en uno ya inicializado.
- **El bloque vive en dos archivos y ahora se lee de los dos**: una nota escrita sólo en `AGENTS.md` —el que lee Codex— se perdía en la reescritura siguiente.

### Fixed

- **Un retiro que no puede restaurar nada lo dice antes de aplicar.** Ninguna skill declaraba las entradas de su sesión, así que toda sesión nacía sin artefactos y `reset` borraba la sesión, restauraba cero archivos y devolvía éxito. Ahora las entradas las **deriva el CLI** desde el documento que el flujo ya conoce: una skill que puede olvidarse es un contrato que se rompe solo.
- **El rechazo por falta de custodia nombra lo que verificó.** Afirmaba que la sesión «nació antes de que existiera el registro» incluso sobre una carpeta creada después de esa release: era una inferencia por ausencia de archivo vendida como fecha de nacimiento.

### Notes

- **Compatibilidad.** El formato del bloque no cambia y los goldens siguen intactos. Un bloque escrito a mano o por un CLI anterior, con sus entradas sin indentar, se sigue leyendo: la indentación no identifica un registro, sólo decide dónde va una línea con forma de registro y clave desconocida — indentada es residuo propio y se poda declarándolo, al ras es la nota de alguien y se conserva.

## [21.14.0] — 2026-08-15

**Un plan podía prometer una validación que nadie iba a poder ejecutar.** Nada impedía redactar una fase cuya condición de terminado exigiera producción o el producto ya desplegado, y el defecto se descubría tarde y de la peor forma: el plan corría hasta esa fase y quedaba bloqueado sin salida, porque nada en una corrida aplica nada a producción. Pasó dos veces con dos planes distintos — uno cuya fase era «producción recupera el acceso», otro esperando que un tercero normalizara datos allá.

### Added

- **Cert-only es doctrina del chasis.** Un criterio que necesita producción o el producto desplegado **no es una condición de terminado**: nadie en la corrida puede ejecutarlo, así que la fase espera para siempre. Se verifica en cert.
- **Los tres gates que deciden si un documento procede la exigen como evidencia propia** —coherencia del plan, ejecutabilidad del plan refinado y listo-para-plan de la spec—, así que la respuesta devuelve un veredicto para esta regla en vez de disolverla en un «el checklist pasó» genérico. El remedio viaja con el gate: una fase que sólo se valida en producción se reformula para cert, o sale de la fase y se entrega como script + runbook + handoff declarado.

### Notes

- **Por qué no es un módulo.** Un módulo se carga por señal, y cert-only no es condicional: aplica siempre que se redacta. La política de base de datos es un módulo porque sólo rige cuando hay base de datos. Forma distinta para una regla distinta.
- **Qué se comprimió para hacerle lugar.** El presupuesto de contexto es un gate congelado y los tres tramos están en sus techos por diseño. Se comprimieron cuatro pasajes del chasis con redundancia real —una idea dicha dos veces en el mismo documento—, sin re-congelar el baseline. En el camino, el propio guard cazó una frase pinada que la compresión había soltado; se restauró y los bytes se buscaron en otro lado.
- **Lo que NO se embarcó.** Las directivas operativas de alcance literal y de disciplina de commit en un repositorio padre describen cómo trabaja un usuario y cómo está organizado su repositorio, no qué puede prometer un plan: embarcarlas impondría el layout de uno a todos. Quedan en las convenciones de cada workspace.

## [21.13.0] — 2026-08-15

**La ruta por defecto destruía el `CHECKPOINT.md` que un agente acababa de rellenar, y una lectura curiosa redirigía a dónde iba a escribir el cierre.** El centinela que autorizaba sobrescribir era el mismo string que la plantilla emite, así que el único estado protegido era «cero marcadores» y todo relleno parcial se trataba como borrador desechable — con los hooks de compactación y de cierre corriendo esa ruta solos. En paralelo, resolver una sesión ligaba la conversación aunque la superficie fuera de pura lectura, y el registro durable tomaba su fecha del mtime de la carpeta que el propio cierre acababa de tocar.

### Added

- **`aw workspace-migrate`.** Pone al día un hub con serie legacy: reconoce los marcadores del bloque con el prefijo antiguo conservando su contenido, siembra los centinelas de cierre **desde el histórico y con sus fechas** —nunca desde el mtime, que es justo la corrupción que este release cierra— y reserva el rango de números legacy en el correlativo. Es read-only sin `--apply`: lo que una persona lee antes de aplicar es exactamente lo que va a pasar. Cuando el histórico y el disco se contradicen, lo reporta y no toca esa sesión.

### Changed

- **Un solo correlativo.** Convivían tres derivaciones del mismo número: la de creación ignoraba las carpetas legacy sin fila en el histórico, la del histórico sí las contaba, y la que se le publicaba al consumidor sólo contaba las legacy. En un workspace enteramente del modelo nuevo el tablero anunciaba `001` mientras la creación asignaba `004`; con una sola carpeta legacy, anunciaba `002` y asignaba `001`, dejando el código desnudo irresoluble. Ahora las tres superficies comparten una derivación.
- **La fecha de una fila es un hecho de la sesión.** Sale de la custodia que se sella al crearla, no del sistema de archivos. Antes venía del mtime de la carpeta —y como el propio cierre escribe dentro, la fila se auto-envejecía hacia hoy con cada operación—. Una sesión anterior al registro de custodia conserva la fecha que el histórico ya tenía.
- **Un flag que el comando no reconoce deja de ignorarse en silencio.**

### Fixed

- **Un CHECKPOINT rellenado sobrevive.** El render sella un digest de sus propios bytes, así que sólo la plantilla intacta se reconoce como tal: rellenarla es exactamente lo que no puede reproducir ese sello. Regenerar contenido pasa a exigir `--force`, que recupera su sentido, y el resultado dice si escribió o si conservó. Un archivo sin sello —escrito por una versión anterior— se conserva también: ante procedencia desconocida, conservar. El marcador de plantilla queda declarado una sola vez, con un solo significado; existía duplicado en dos módulos, y la copia del camino de escritura lo leía como permiso para destruir.
- **Leer no reclama la línea.** El vínculo conversación→sesión pasa a ser una decisión declarada por cada llamador y no un efecto de resolver. Con el vínculo en una sesión, inspeccionar otra con `checkpoint-read` o con `session-artifacts` lo movía, y el hook de cierre que seguía —que no lleva `--code`— escribía en la sesión equivocada, dejando a la real sin checkpoint.
- **El histórico conserva lo que nadie le pidió cambiar.** Un upsert reemplazaba la línea entera, así que actualizar un estado sin nombrar referencias las borraba. La fila se inserta ahora dentro de la tabla y no al final del archivo, donde acumulaba filas huérfanas que partían la tabla en dos, y cerrar dos veces la actualiza en lugar de agregar una segunda.
- **Sin saber de quién es la fila, no se escribe.** Un `--code` desnudo degradaba la clave de la fila de OTRA sesión y le borraba fecha y referencias — y era la forma que los propios mensajes de error sugerían. Se niega, con los candidatos nombrados. Reparar una fila cuya carpeta ya no existe sigue siendo posible nombrándola entera, que es lo que hace falta después de un retiro.
- **Un cierre que no puede registrarse no se aplica a medias.** Con dos carpetas compartiendo número, el cierre escribía el centinela, invalidaba los vínculos y devolvía éxito con el registro diciendo `active`. Ahora se niega antes de tocar nada y nombra el único remedio.

### Notes

- **Compatibilidad.** El formato de la tabla del histórico y el render de los artefactos de sesión no cambian: las pruebas byte-exactas que los fijan siguen intactas y sin regenerar. Este release preserva valores, no formatos.
- **Cómo se verificó.** Una revisión adversarial encontró dos críticos: el secuestro del vínculo seguía vivo por `session-artifacts`, y el arreglo de identidad había cerrado de paso la única puerta de reparación del registro —una fila cuya carpeta se retiró quedaba congelada—. Ambos cerrados, el primero verificado por mutación sobre las tres superficies de lectura.

## [21.12.0] — 2026-08-15

**Un recorrido trabado dejó de ser un callejón sin salida, y la directiva que el CLI emite volvió a ser ejecutable tal cual.** La invocación se sellaba con el número desnudo de la sesión, que en un workspace con una carpeta legacy homónima casa con dos: ejecutarla verbatim fallaba por ambigüedad y corregirla a mano la convertía en otra invocación que el `submit` rechazaba, así que a los tres intentos la frontera quedaba agotada sin salida. El techo, además, lo gastaban los errores de tipeo del sobre —no las respuestas insuficientes—, una ejecución que fallaba no agotaba ni degradaba sino que se colgaba, y el único reset existente era restaurar a mano una copia del ledger. El contrato del sobre, en fin, sólo se aprendía quemando intentos.

### Added

- **`aw flow recover`.** Devuelve los intentos de la frontera agotada vigente conservando todo lo ya aplicado: recuperar no es reiniciar. Se niega con causa cuando esa frontera ya ejerció efectos, cuando la frontera vigente todavía es contestable y cuando se nombra otra. Y es un evento **registrado**, no un borrado: recuperar y después restaurar una copia vieja tampoco devuelve intentos.
- **El contrato del sobre de `submit` se lee en `aw flow --help`**, por tipo de frontera y con sus trampas nombradas: que `input_digest` es el `state_digest` que la directiva rotula `continuidad:`; que el digest de `--approval` no es ése sino el que la directiva nombra en `siguiente:`; que `validations` son `{id, passed, detail}` y `effects` un registro `{planned, approved, applied}`, no una lista. Descubrirlo a ciegas le había costado once sesiones descartables a un host.
- **Una frontera agotada queda registrada como tal**, distinguible de una contestada y de una salteada por condición, con su causa. Antes aparecía en `applied` junto a las realmente aplicadas y en `skipped` junto a las salteadas, con las degradaciones vacías.

### Changed

- **La directiva liga el folder de la sesión, no su número.** Es la única identidad que resuelve siempre a una sola sesión, y como el registro usa ese hueco en 19 invocaciones —todas en posiciones que aceptan un folder—, ligarlo en el punto donde se liga las repara todas de una vez. Con eso el recorrido deja de depender de la salud del correlativo de sesiones, que se arregla aparte. La proyección de reanudación ya usaba el folder: ahora las dos convenciones son una.
- **Un intento es una respuesta evaluada.** Una tabla cerrada clasifica cada código de rechazo en «el sobre no se pudo entender como respuesta a esta frontera» (no gasta) y «se entendió y resultó insuficiente» (gasta). Un código sin clasificar gasta, para que el techo no se apague por omisión, y un guard recorre el parser, el veredicto y el submit para que ninguno quede sin lado.
- **El cierre de la sesión es del runtime.** La doctrina embarcada le pedía al agente que corriera `session-close`, cosa que el `finalize` ya hace por su cuenta; obedecerla a mitad de recorrido dejaba al siguiente avance parado sobre una sesión cerrada. Ahora el chasis lo dice al revés, y el error de sesión cerrada nombra la operación exacta que la reabre, con el folder adentro.

### Fixed

- **Una ejecución que falla ya no se cuelga.** No agotaba ni degradaba —la excepción salía temprano ante cualquier fila con acción delegada, y una ejecución interna fallida no registraba intento—, así que avanzar cinco veces devolvía cinco veces el mismo error con el ledger vacío. Ahora registra su intento y termina agotando o degradando con causa, sin degradar por su cuenta una frontera que sencillamente todavía nadie ejecutó, y sin degradar nunca una fila con efecto material: ésas quedan agotadas, con `recover` como salida declarada.
- **El techo de intentos dejó de ser evadible.** El contador vive fuera del blob sellado **y fuera de la carpeta de la sesión** —mientras vivía adentro, un `cp -r` de esa carpeta se lo llevaba y la evasión llegaba con la forma de un backup— y va sellado con la clave de la sesión adentro, de modo que editarlo a mano se rechaza como cualquier otro archivo de la corrida. Un contador que perdona más intentos de los que registró también se rechaza, y borrarlo habiendo un piso sellado en el estado falla cerrado en vez de reconstruirse en silencio.
- **Las negativas propias de `submit` cobran intento.** Los rechazos de alcance y de propuesta no lo hacían, así que contestar la frontera de alcance con un alias que el plan no nombra no agotaba, no degradaba y no se recuperaba: un bucle sin techo.
- **Reabrir una sesión deja coherente el bloque que el CLI administra.** Tras reabrir, `aw sessions` la daba por activa mientras el bloque dentro de `SESSION.md` seguía declarándola cerrada — y ese bloque es lo primero que lee un agente al retomar, incluido en el payload de reanudación.

### Notes

- **Compatibilidad.** Los campos nuevos del estado son opcionales: un `.flow-run.json` escrito por la versión anterior se lee, camina y agota, y uno nuevo sin intentos gastados queda byte-idéntico al de antes. Un recorrido cuya sesión no tiene contador todavía asume el valor conservador y lo siembra en la próxima escritura.
- **Cómo se verificó.** Una revisión adversarial rechazó la primera implementación con cuatro bloqueantes —el contador evadible por restore, el contador sin sellar, la guarda de `recover` fail-open y las negativas de `submit` sin cobrar—, todos reproducidos sobre un workspace real. Cada uno quedó cerrado con una prueba que se pone roja al revertir el arreglo.

## [21.11.0] — 2026-08-15

**El launcher de `dbhub` encontraba el DSN sólo si el nombre de la conexión coincidía exactamente con el de la variable, y el doctor de visibilidad señalaba un archivo que podía no existir.** Registrar la conexión como `qtc-cert` derivaba `DB_QTC_CERT_DSN` y fallaba aunque el DSN estuviera en `DB_CERT_DSN` —que es justo lo que escribe `aw bootstrap-dsn`—, y el mensaje nombraba una sola variable sin mencionar las dos salidas que ya existían. Además el banner ASCII del servidor viajaba por el mismo canal que el protocolo JSON-RPC. Del lado de visibilidad, el diagnóstico decía leer `.claude/settings.json` incluso cuando la configuración vivía en `settings.local.json`.

### Added

- **El nombre de la variable DSN tolera el prefijo de organización.** La resolución prueba la clave canónica y después la que resulta de soltar el primer segmento: `qtc-cert` alcanza `DB_QTC_CERT_DSN` y, si no está, `DB_CERT_DSN`. Se suelta **exactamente un** segmento y nunca se llega a un nombre de un solo segmento cuando el alias tiene tres o más: colapsar `qtc-cert-ro` hasta `DB_RO_DSN` haría que aliases de organizaciones distintas compartan una variable genérica, y arrancar un servidor contra la credencial de otro entorno es peor que no arrancar. Cuando resuelve por un nombre no canónico lo dice por stderr, con la variable usada y la que faltaba.
- **`aw visibility doctor` tiene proyección humana.** Era el único comando que imprimía JSON crudo ante `--format human`. Ahora rinde una línea por host con su veredicto, los archivos de los que se leyó y las rutas que faltan o sobran, más los comandos exactos para corregir cada clase de drift presente. `--detail` funciona también en el caso con drift, que es cuando importa.

### Changed

- **El diagnóstico de un DSN ausente enseña las salidas que existen.** El error lista todas las variables probadas y en qué orden, dice dónde buscó —`process.env` y la ruta concreta de `dsn.env`, nombrando la causa cuando ese archivo no se pudo leer— y nombra las dos vías reales de resolverlo: la variable `DBHUB_DSN_VAR` y `aw mcp setup --instance <x> --dsn-var <NOMBRE>`. Un diagnóstico que nombra otra cosa que la que hay que arreglar es el defecto más caro de este proyecto.
- **`aw mcp doctor` prueba la misma cadena que el launcher** y reporta la variable que efectivamente lleva el valor, no la canónica supuesta. Un doctor que declara `missing-dsn` sobre una conexión que el launcher arranca sin problema contradice al runtime, y eso es peor que no diagnosticar.
- **El reporte de visibilidad nombra los archivos que realmente leyó.** `target` deja de ser un nombre fijo y pasa a ser el primer archivo del que salieron las rutas; `targets` lleva la respuesta completa cuando un host lee más de uno. Las rutas registradas se deduplican: una ruta declarada en `settings.json` y en `settings.local.json` aparecía dos veces.

### Fixed

- **El banner del servidor ya no corrompe el canal JSON-RPC.** `stdout` se filtra hasta que arranca el protocolo: las líneas de banner salen por stderr y, desde el primer mensaje, el flujo se entrega crudo sin volver a partirse. El corte reconoce además el caso en que el banner no termina en salto de línea y el primer mensaje viene pegado a su cola —antes ese mensaje se perdía entero— y una línea que ya abre el protocolo se entrega desde su primer byte, blancos incluidos.
- **Ningún byte del protocolo se pierde al terminar.** Pasar de `stdio: "inherit"` a un pipe abrió una pérdida que antes era estructuralmente imposible: el hijo escribía el descriptor del padre, y ahora cada byte se reescribe por el `stdout` propio, que `process.exit()` descarta si todavía hay cola. El launcher espera el cierre del hijo **y** el vaciado de su propio canal antes de devolver. Medido con un lector lento y una carga de 300 KB: sin la barrera el consumidor no recibía nada y el flujo ni siquiera cerraba limpio; con ella llegan los 300 KB completos.
- **`aw bootstrap-dsn` dejó de reescribir `dsn.env` entero.** Escribía sólo sus dos claves y perdía cualquier otra que el archivo tuviera —el archivo es compartido por todas las conexiones que la persona haya registrado alguna vez—. Ahora hace upsert conservando comentarios, líneas en blanco y claves ajenas. Un asignamiento indentado se reemplaza en lugar de duplicarse: dejarlo atrás mantenía viva una credencial vieja en un archivo `0600` que el usuario cree actualizado.

### Notes

- **Compatibilidad.** `target` sigue presente en el JSON del doctor de visibilidad, ahora apuntando a un archivo que existe; `targets` es aditivo. La resolución del DSN sólo agrega un candidato de reserva: una conexión que hoy resuelve por su clave canónica no cambia de comportamiento. `DBHUB_DSN_VAR` sigue siendo exacta y no deriva candidatos.
- **Cobertura nueva.** El launcher y el bootstrap no tenían ningún test; `attachClaude`/`detachClaude` tampoco. El filtro de banner se probó como unidad pura sobre buffers (banner solo, banner con mensaje pegado, mensaje partido entre chunks, entrega cruda posterior y cierre sin protocolo), y la preservación de formato de `dsn.env` caso por caso.

## [21.10.1] — 2026-08-14

**`fix-git` ya no resuelve a ciegas sobre una rama que pudo ser recreada.** Cuando una rama remota se limpia borrándola y recreándola desde `main`, cualquier copia local anterior conserva commits que fueron retirados a propósito; mergearla o empujarla los reintroducía sin que nadie lo pidiera, y el skill no miraba. Ahora la verificación es piso duro antes de cualquier resolución, y las resoluciones a un lado completo sin evidencia quedan prohibidas.

### Fixed

- **`fix-git` frena ante un upstream recreado, antes de tocar el merge.** El primer paso es `git fetch` LEYENDO su salida: una línea `forced update` delata que la rama fue borrada y recreada —la señal sobrevive aunque `main` no haya avanzado, donde el grafo por sí solo es mudo— y `git rev-list --left-right --count HEAD...@{upstream}` con ambos lados en positivo la corrobora. Al dispararse, el skill se detiene y propone la resincronización conservando el trabajo local (rama `respaldo-<fecha>` + `reset --hard @{upstream}`, que la persona decide), en vez de mergear o empujar los commits retirados. La rama entrante de un merge pedido se verifica igual (`<branch>...<branch>@{upstream}`).
- **El piso duro cierra los atajos destructivos.** `--force`, `reset --hard` y `merge --abort` se suman a la lista de movimientos que sólo se proponen y nunca se ejecutan, y tomar un lado completo de un conflicto sin evidencia deja de ser una resolución válida. El blindaje cabe en el presupuesto de contexto del comando: el documento quedó en 2519 bytes, bajo el techo que el guard G1 deriva del baseline congelado.

## [21.10.0] — 2026-08-14

**Dos recorridos concurrentes ya no se pisan, y el probe multihost que lo demuestra encontró tres defectos que ningún test de un proceso podía ver.** Hasta acá `plan-new` reclamaba un correlativo que después su propio guardado rechazaba llenar, `plan-exec` leía y commiteaba el checkout compartido sin adquirir ninguna unidad, y el cierre no miraba si quedaba una unidad viva — así que dos flujos sobre la misma fuente se atribuían trabajo ajeno y dejaban unidades huérfanas. Ahora la reserva pertenece a la corrida, cada `plan-exec` fija su alcance y edita sólo dentro de su unidad, y la integración precede al sello del plan. La conformidad se verificó end-to-end con dos hosts reales (Codex y Claude Code) sobre la misma máquina y el mismo workspace, en el caso limpio y en el conflictivo.

### Added

- **La reserva del correlativo pertenece a la corrida.** `aw next-number --claim <resto> --code <NNN>` materializa el hueco con un marcador que nombra a su dueña. Sólo la propuesta sellada de esa sesión puede completarlo —y sólo mientras los bytes sigan siendo exactamente ese marcador—, así que llenar la reserva propia es aditivo y cualquier otro destino existente sigue siendo un overwrite fuera de contrato. Reclamar dos veces con el mismo nombre devuelve la MISMA reserva en vez de acuñar un segundo número, y cerrar la sesión sin publicar la libera: `docs/plans` deja de acumular archivos vacíos presentados como planes.
- **`plan-exec` fija su alcance y adquiere una unidad antes de editar.** La corrida sella qué aliases va a tocar, lo valida contra el bloque WORKSPACE y lo persiste; antes de la primera edición obtiene un worktree por alias. Rama, cambios y commits se leen y acreditan en esas rutas, con `--code`/`AW_CONTEXT_ID` como identidad fail-closed. Estar dentro de *cualquier* worktree ya no autoriza usar la unidad de otra sesión: `check-branch` distingue `inside_own_unit` de `other_session_unit`.
- **La integración es una frontera del recorrido y precede al sello del plan.** Tras validar y commitear, la corrida integra sus unidades de forma serial sobre la rama de trabajo y recién entonces marca el plan `done`. El cierre interno se niega mientras exista una unidad de la sesión, de modo que ninguna termina huérfana por olvido.

### Changed

- **El merge de una integración se serializa con el lock del workspace.** Dos corridas integrando en el mismo checkout se pelearían por un índice y un `MERGE_HEAD`, y la perdedora encontraría un repositorio a mitad de un merge que nunca empezó. La espera es acotada y prefiere aguardar a fallar rápido, por la misma razón que un reclamo de correlativo espera: cuando se toma este lock ya hay trabajo commiteado sin otro lugar adonde ir. El HEAD previo que el recibo de custodia necesita se lee **dentro** del mismo lock, junto al merge que describe: leerlo afuera dejaba una ventana en la que otra integración se cuela entre la lectura y el merge.
- **Un conflicto conserva sesión y unidad vivas.** Los commits de la unidad son la única copia de un lado del merge, así que liberarla para ordenar los borraría. La integración devuelve los archivos en conflicto y deriva a `aw fix-git`; al reintentar, integra y libera.

### Fixed

- **`plan-new.numbering` emitía su reclamo sin ligar y rompía al agente que lo hacía bien.** La fila declaraba `plan-<slug>.md` con ángulos —la metavariable de la PROSA copiada a una invocación que ejecuta una máquina—: el motor sólo liga huecos con llaves y su guarda sólo reconoce esa forma, así que la plantilla viajaba entera hasta quien ejecuta. El efecto era el peor posible: quien sustituía el slug correctamente dejaba de coincidir con la invocación sellada y agotaba sus intentos, mientras quien corría el template literal creaba en disco un archivo llamado `NNN-plan-<slug>.md`. Ahora `{slug}` pertenece al conjunto cerrado de coordenadas y se liga desde la carpeta de la sesión; una corrida que no pueda aportarlo se niega en la frontera en vez de acuñar un nombre inventado.
- **Un resultado sin `outcome` culpaba al valor en vez de al campo ausente.** Los dos casos compartían una frase que describía sólo el segundo. Un host que había anidado todo su resultado dentro de un objeto corrigió el valor exactamente como el mensaje pedía, conservó el envoltorio, recibió el mismo mensaje y perdió la sesión. Ahora «ausente» y «fuera del vocabulario» son fallas distintas, y cuando el campo viene anidado el mensaje nombra el envoltorio que lo esconde.
- **El rechazo de `validations` nombraba un tipo interno en vez de una forma.** `ValidationOutcome` no existe en ningún documento que quien ejecuta pueda leer, y la frase no decía las tres claves ni los identificadores que la frontera exige. Dos hosts distintos, por separado, mandaron `{name, …, evidence}` donde van `{id, …, detail}`. Ahora el mensaje nombra la forma, lista los ids de evidencia de esa frontera y reporta las claves que la entrada realmente trajo.

### Notes

- **Compatibilidad.** El contrato de la reserva se acota a `plan-new`, el único guardado que rechazaba rellenarla; `spec-new` no cambia porque sus filas ya admitían overwrite. Adoptar o regenerar un plan sigue sin sobrescribir un documento existente que nadie reservó.
- **Cómo se verificó.** Dos escenarios sobre sandboxes desechables con el `dist` y el bundle exactos del candidato, verificados por hash y por invocación: uno con cambios compatibles y otro con una línea incompatible resuelta por `fix-git prepare → apply → commit --confirm`. Las ventanas de solapamiento se midieron **por condición y sin sleeps** —una barrera de dos partes que fotografía el estado con las dos detenidas—, no por tiempos supuestos. Ninguna corrida usó `push`, `--amend`, `--no-verify`, `--force` ni `rebase`.
- **Deuda declarada.** El sobre JSON de `aw flow submit` sigue sin mostrarse en el bundle: `HARNESS.md` lo describe en prosa. Los tres defectos de diagnóstico corregidos acá son síntomas de eso, y sus mensajes ahora guían, pero quien ejecuta todavía tiene que inferir la forma del sobre.

## [21.9.0] — 2026-08-13

**Retirar trabajo deja de ser un `rm -rf` a ciegas.** Hasta acá no había forma de sacar una spec, un plan, un quick o una sesión del tablero: borrar a mano dejaba planes citando specs que ya no estaban, sesiones apuntando a documentos inexistentes, unidades de aislamiento huérfanas y bindings que resolvían a la nada — y nada de eso avisaba. Tampoco había manera de volver una ejecución parcial al estado anterior a la sesión: `plan-refine` avanza desde donde está, que es lo contrario. Ahora hay dos comandos transversales, `/discard` y `/reset`, que resuelven su alcance desde procedencia sellada, lo muestran entero antes de tocar nada y lo aplican todo-o-nada contra una sola aprobación. Sin dependencias npm nuevas y sin migración: la custodia nace con cada sesión desde este release, y las sesiones anteriores siguen funcionando igual.

### Added

- **`aw discard prepare|apply <objetivo>` y `aw reset prepare|apply <objetivo>`**, más los comandos Workline `/discard` y `/reset`. `discard` retira el objetivo y toda su descendencia de propiedad exclusiva; `reset` devuelve las entradas de una sesión incompleta a los bytes que tenían antes de esa sesión y retira la sesión con sus salidas. Los dos son transversales: no abren WorklineFlow ni crean sesión, porque la clausura puede incluir la sesión que los dirigiera. Objetivos por `spec:NNN`, `plan:PPP`, `quick:NNN`, `session:NNN|carpeta` o la ruta exacta; un número abreviado resuelve sólo si un único nodo responde, y si no devuelve los candidatos.
- **`prepare` es read-only y sella una propuesta.** No crea sesión, journal, archivo ni ref — hay una prueba que compara el árbol completo del workspace y `show-ref` antes y después. Devuelve el alcance entero (qué desaparece, qué vuelve a sus bytes previos, qué cambio local se descarta, qué SHA se revierte, qué unidad se reconcilia, qué fila gana `HISTORY`) y su **digest**. `apply` exige ese digest, recomputa todo bajo el lock del workspace y rechaza si algo material se movió: aprobar no es aplicar.
- **Custodia de sesión (v1).** `aw session-create --input <ruta>` (repetible) sella, dentro del mismo lock que acuña el número y crea la carpeta, el estado previo byte a byte de cada documento que la corrida va a modificar, y deriva de esa ruta el padre tipado. Adopción y publicación de flows, `worktree ensure`/`integrate` y los commits tipados registran después sus receipts reales. `SESSION.md/Origin` queda como proyección humana; la custodia es la autoridad, y ninguna atribución lee un mensaje de commit, un autor ni un tag.
- **`status` gana `terminal_events` y `pending_retirements`.** El primero proyecta el ledger append-only de retiros que vive bajo `## Retiros` en `.workflow/HISTORY.md`, keyed por el digest de operación — **sin** reutilizar `discarded`, que significa lo que una sesión postergó o excluyó: uno es recuperable y el otro no. El segundo declara una operación en vuelo con el comando exacto que la converge, porque mientras exista un journal el tablero no es una lectura asentada.

### Changed

- **El correlativo de sesiones es monotónico aun cuando la carpeta desaparece.** `session-create` toma el máximo de las carpetas vivas **y** de `HISTORY.md`, así que una identidad retirada no vuelve a nombrar otra sesión, fila ni rama. Efecto observable en workspaces existentes: si el histórico registra números por encima de las carpetas vivas, la próxima sesión arranca en el máximo de los dos más uno. Además cierra una colisión latente que ya existía — el `001` que entregaba el contador viejo resolvía también a la carpeta legacy `session001-…`.
- **`worktree ensure` sella el baseline de la fuente al tomar la unidad, y se niega si la custodia existe y no se puede leer** (`custody_unreadable`): una sesión que ya prometió poder retirarse no muta bajo un registro roto. Una sesión **sin** custodia —toda sesión legacy— pasa igual que antes.
- **Publicar una propuesta sella los bytes previos de cada destino antes de escribir**, no después: un proceso que muere entre la escritura y el registro dejaría un archivo que nadie puede atribuir a la corrida que lo creó.
- **`GitPort` gana su superficie tipada** para todo lo que un retiro necesita preguntar: `status --porcelain=v2 -z` parseado (rename con sus dos mitades, modos, untracked), HEAD/ref/tree/`ls-tree`, `for-each-ref --contains`, estado de operación en curso, `merge-base --is-ancestor`, worktree desatachado, ensayo de `revert --no-commit`, `read-tree -m` con y sin dry-run, y `update-ref` con old-value esperado. `commit` ahora devuelve un recibo con rama, SHA anterior, SHA nuevo y padres. Ningún servicio arma una línea de comandos: hay una guarda de fuente que lo prueba.

### Notes

- **Nada reescribe historia.** Los cambios locales atribuibles se descartan; los commits sólo se revierten como commits nuevos, ensayados antes de pedir la aprobación. Prohibido `reset --hard`, rebase, amend, force y borrar la ref que sostiene la alcanzabilidad; **ningún push ocurre automáticamente**, y el revert de un commit ya publicado se declara con su push pendiente y externo.
- **Todo-o-nada de verdad, con un solo punto de commit.** Un `update-ref` con old-value esperado es la bisagra; antes de él nada observable cambió y un fallo descarta lo invisible, después de él la reentrada completa el resultado y el ref nunca vuelve atrás. Más de una unidad de publicación Git, un revert en conflicto, una operación git en curso, un árbol que no se puede sincronizar o una colisión con un archivo sin versionar bloquean **antes** de mutar.
- **Compatibilidad.** Sin invocar `discard`/`reset`, cierre, reapertura, reanudación, refinamiento, flow, propuestas, `HISTORY` y worktrees conservan su comportamiento. Las sesiones nacidas antes de la custodia v1 no tienen baseline: `discard/reset prepare` las rechaza nombrando la evidencia faltante, en vez de adivinar procedencia desde nombres, fechas o tags.

## [21.8.0] — 2026-08-13

**El chasis administra sus propios libros, y `/compact` deja de trabarse.** Hasta acá la puerta de autorización decidía solo por clase de efecto, así que la corrida paraba a pedir «Autorizar el efecto» por su propia contabilidad —cerrar su sesión, tildar su plan, correr los criterios ya declarados: 2 paradas por quick, 6 por plan-exec— y el commit de plan-exec se preguntaba DOS veces (la aprobación humana no registraba ningún grant). Y el hook PreCompact bloqueaba `/compact` en un deadlock sin salida cuando la conversación no tenía binding con ≥2 sesiones activas: el remedio que el agente podía correr no ligaba nada y el aviso salía por stdout, que el host no muestra al bloquear. Sin dependencias npm nuevas y sin migración: el estado de corrida persistido sigue en su versión — la custodia se lee del registro al resolver cada frontera.

### Changed

- **Custodia de la corrida (`custody: "run"`)**: las filas cuyos efectos ejercen sobre la contabilidad de la propia corrida —sus artefactos de sesión, su estado, las marcas de avance del doc del flow, correr los criterios que la corrida misma declaró— quedan cubiertas sin preflight: la frontera emitida es directamente la de ejecución, y la salida real sigue siendo obligatoria. Seis filas la declaran (`chassis.finalize`, `quick.convergence-gate`, `plan-exec.task-marking`, `plan-exec.phase-state-transition`, `plan-exec.validation-execution`, `plan-exec.plan-done`). El techo es fail-closed: la custodia **jamás** cubre `destructive` ni `network_external` —declare lo que declare la fila— ni una propuesta sellada (los bytes aprobables son material de alguien, no contabilidad), y la lista de filas con custodia está pinada por test: agregarla a una fila nueva es una edición consciente. La frontera `authorization` sigue existiendo como red para efectos fuera de custodia.
- **Aprobar los commits ES autorizarlos (`authorizes` en el registro)**: `plan-exec.commit-authorization` declara a qué transición autoriza su label afirmativo, y al responder «Aprobar los commits del batch» el submit registra el `EffectGrant` sobre el sello exacto de `plan-exec.commit-execution` — el mismo movimiento que `Aprobar y guardar` ya hacía para las propuestas selladas, ahora para la ejecución delegada. Una decisión, una pregunta: la re-pregunta «Autorizar el efecto» sobre el commit desaparece, y la ejecución sigue exigiendo el estado git real de las fuentes para aplicarse. Un enlace hacia una transición que la jornada no camina no otorga nada: la frontera de autorización aguas abajo queda en pie y el defecto se ve.

### Fixed

- **`/compact` quedaba retenido en un deadlock cuando la conversación no tenía binding y había ≥2 sesiones activas** (`SESSION_AMBIGUOUS` + `--can-pause` → exit 2): la identidad solo se leía de `AW_CONTEXT_ID`, que ningún host exporta, así que ni `session-create` ni `checkpoint-write --code` ligaban la conversación y reintentar no cambiaba nada. `readContextId` ahora cae a las variables que el host sí exporta (`CLAUDE_CODE_SESSION_ID`, lista extensible para el resto de la matriz): cada `session-create` liga la conversación a su sesión al nacer y el PreCompact resuelve por binding aunque haya N sesiones paralelas. `AW_CONTEXT_ID` conserva la precedencia como variable acordada, y una variable de host en blanco no es identidad.
- **Una compactación retenida no le decía a nadie cómo destrabarse**: el sobre con las candidatas salía por stdout, que el host no muestra en un PreCompact bloqueado. La rama `blocked` ahora emite por stderr el aviso accionable con el comando exacto (`compactación retenida: … corré 'aw checkpoint-write --code <NNN>' …`) y las carpetas candidatas; el envelope JSON de stdout queda intacto como contrato máquina.

## [21.7.1] — 2026-08-13

### Added

- **`aw designs` gana `--deep` en el listado**: corre el gate de contenido (madurez y cruce de evidencia visual) sobre las revisiones vigentes de cada package y fusiona los hallazgos en `failures`/`ok`. Sin `--deep` el listado sigue barato: solo valida manifiesto y baseline vía el índice.

### Fixed

- **La ruta package de `design` (`create`/`update`) publicaba los artefactos tal cual los autoraba el consumidor**: sin sellar `baselines/`, sin derivar `design-manifest.json` y sin correr ningún gate, y aun así reportaba `completeness: "complete"` — un árbol inválido quedaba publicado y nadie lo detectaba. Ahora el CLI deriva y sella `design-manifest.json`, `baselines/` y `PACKAGE.md`, como ya hacía la ruta simple, y corre el gate de madurez en `validate`: un árbol inválido sale `blocked` antes de escribirse. El consumidor ya no autora manifiesto ni baseline a mano (incluirlos en `artifacts` sale `DESIGN_FIELD_INVALID`); en `create` el CLI asigna el id (`DES-NNN`) y la carpeta y los publica en el `inventory` del request, y el frontmatter de cada artefacto declara ese id; en `update` el `base` declarado se compara contra la revisión vigente y, si difiere, sale `DESIGN_BASE_STALE`.
- **`aw designs --id <PKG>` reportaba `ok: true` con el contenido roto**: solo validaba manifiesto y baseline, así que un package publicado por la ruta verbatim podía arrastrar violaciones del contrato sin que nadie las viera. Ahora corre además el gate de contenido sobre las revisiones vigentes del catálogo y lo incluye en `failures`/`ok`.
- **Los gaps de `prepare`/`continue` no exponían el `input_digest`**, y contestar exigía reimplementar `canonicalJson`; ahora viaja como línea `input_digest: <digest>` y se copia tal cual. El error `SEMANTIC_STALE` nombra el digest esperado.

## [21.7.0] — 2026-08-09

**Workline pasa a dejar una memoria que una persona puede leer, y a cobrar sólo la complejidad que hace falta.** Hasta acá el motor convertía *toda* `action` en una frontera de ejecución para el host —incluso cuando el CLI podía resolverla localmente y con certeza—, la memoria se repartía entre artefactos internos cuyos consumidores contaban relatos distintos, guardar una propuesta y autorizar su escritura eran dos decisiones separadas, y `design` exigía manifest, revisión y madurez hasta para un cambio de una sola pantalla. Ahora el CLI **ejecuta en proceso** sus operaciones deterministas y registra qué corrió y con qué evidencia; cada sesión se lee **desde una sola entrada** que dice qué pasó, por qué y de qué archivo sale cada dato; specs, planes y diseños comparten **una vista previa sellada y una sola decisión** (`Aprobar y guardar` | `Refinar`); y un diseño cohesivo se publica como **un `DESIGN.md` legible**, con el package completo reservado para una causa registrada. Sin dependencias npm nuevas.

### Added

- **El CLI ejecuta sus propias operaciones internas, y qué puede ejecutar es una unión CERRADA de cuatro.** `workspace.board`, `session.artifacts`, `session.close` y `proposal.publish` corren dentro del servicio de aplicación, con salida y evidencia reales, receipt persistido, y el recorrido continúa hasta la primera frontera de verdad en la misma invocación. Las 26 filas del registro que declaran una acción quedan clasificadas —**13 internas y 13 externas**, cada externa con su razón— y un test de cobertura falla ante una entrada nueva sin clasificar. `invocation.program` y `invocation.args` **nunca se interpretan**: quedan como el comando equivalente que una persona correría para obtener la misma lectura, lo que mantiene comparables las dos. Espías prueban cero workers y cero subprocesos en el camino interno.
- **La finalización es una sola operación recuperable.** Persistir intención → cerrar → confirmar resultado, con reentrada interna si el proceso cae entre esos pasos y sin reabrir la sesión. `FlowRunEvent` (`executed` | `failed`) y `pending_action.attempted` registran transición, resultado y fallo, que es lo que alimenta la narrativa.
- **`SessionNarrative` — cada hecho con su fuente primaria y su estado real.** Objetivo, secuencia material, tareas, decisiones con su razón, resultados, evidencia, pendientes y siguiente paso; cada elemento declara de qué artefacto y de qué encabezado sale, y distingue `planificado`, `aplicado`, `fallido` y `cerrado`. Es una proyección pura, nunca una segunda memoria.
- **`SESSION.md` gana un bloque administrado por el CLI** (`<!-- aw:recorrido -->`), con upsert idempotente. Lo escriben las mutaciones (`checkpoint-write`, `session-close`) y **ninguna lectura**; se quita antes de releer el documento para que la proyección no se alimente de sí misma. Una sesión legacy se proyecta en memoria y no se reescribe ningún archivo.
- **`aw session-artifacts`, `aw status`, `aw resume` e historial contestan desde la MISMA proyección.** `--detail` trae la jerga interna (IDs, digests, revisiones, envelopes, transiciones), `--no-narrative` deja sólo el técnico, y `--dump` sigue devolviendo los artefactos íntegros. `aw status` lleva la `phase` de cada sesión junto a su `state`. Las exportaciones conservan sus artefactos especializados.
- **`ARTIFACT_CATALOG` — tipo, productor, fuente primaria y consumidores públicos**, con una prueba de cobertura que falla ante un tipo o un contrato sin clasificar.
- **`LocalProposal` — el cambio local exacto bajo UN solo sello.** Bytes, destinos, bases de compare-and-swap, alcance y clases de efecto entran en un único digest, y la vista previa se **deriva** de esos mismos bytes en vez de escribirse al lado. `applyLocalProposal` aplica aprobación, CAS, publicación todo-o-nada y reentrada.
- **`EffectGrant { digest, destinations, classes }` — la autorización deja de ser por clase y pasa a ser sobre EL SELLO de esa frontera.** El reintento técnico idéntico reutiliza el grant sin volver a preguntar; contenido, destino, base, alcance o clase distintos lo invalidan antes de aplicar.
- **Un diseño cohesivo se publica como un `DESIGN.md` legible.** `## Objetivo`, `## Diseño propuesto` y `## Validación` siempre; `## Recorrido`, `## Decisiones` y `## Abiertos` sólo si dicen algo —una sección opcional vacía se **rechaza**, porque tolerarla premia imprimir la plantilla siempre—. El CLI deriva identidad, carpeta, revisión, digest y un manifest mínimo: la ruta simple no le pide a nadie administrar un manifest, un id, una revisión ni un nivel de madurez.
- **Vocabulario CERRADO de expansión, con umbral 1.** Tres señales semánticas que declara quien invoca (`--input expansion=design.independent-outcomes | design.functional-blocking | design.clarity-lost`) y dos **estructurales que deriva el CLI** de la propia invocación (`design.governance-or-system-reuse`, `design.special-source-or-effect`). Declarar una estructural se **rechaza**, no se cree. El receipt lleva el modo, las señales que dispararon y la causa en una línea, así que todo artefacto más allá del documento simple remite a la necesidad que cubre.
- **`design-manifest.json` gana `mode: "simple" | "package"`**, opcional y con default `package`: todo dossier publicado antes de esta versión sigue leyéndose y validando **sin migración**. `aw designs` muestra el modo de cada identidad.
- **Una tarea puede fijar un diseño por su RAÍZ** (`DES-001@r1`, sin artefacto) — la única forma que tiene un diseño simple, cuyo contenido entero es un documento. No recorre clausura ni alcanza madurez, y sigue resolviendo identidad, revisión y digest, rechazando una revisión revocada y fallando cerrado cuando los bytes se movieron. Pedirle un artefacto a un diseño simple bloquea y manda a su raíz.

### Changed

- **El estado de corrida subió de la versión 4 a la 6, sin migración automática.** Una corrida de `aw flow` abierta con 21.6.0 **no continúa** en esta versión: se rechaza fail-closed nombrando la acción que lo resuelve (`aw flow advance --flow <flow> --adopt`). Es estado efímero de recorrido bajo `.workflow/`, no memoria durable: ninguna sesión, documento ni artefacto se toca. Migrar en silencio un estado cuyo significado cambió habría sido peor que pedir re-adoptarlo.
- **`save-confirmation` pasa a `Aprobar y guardar` | `Refinar`, y es la única pregunta de guardado.** Aprobar escribe exactamente los archivos de la vista previa —documento, estado, referencias e índices— en un solo acto atómico; `Refinar` no produce ningún efecto y la publicación se **omite diciendo que no se escribió nada**, en vez de avanzar a pedir autorización sobre bytes recién rechazados.
- **Se retiran `spec-refine.status-promotion` y `plan-refine.normalize-on-write`.** El sello `status: ready-for-plan` y la forma normalizada son proyecciones del mismo guardado, así que viajan **dentro** de los bytes propuestos: escribirlas aparte hacía que la persona confirmara una mitad y autorizara la otra. `plan-refine.split-in-place` queda como fila sin efecto, antes de la propuesta: decide qué bytes se proponen, no escribe.
- **`design` deja de exigir `target` en `create` y `base` en `update`.** El destino por defecto documentado (`docs/designs/`) era inalcanzable a través del contrato que lo documenta, y en la ruta simple el compare-and-swap lo **deriva** el CLI releyendo el manifest —más fuerte que una cadena que quien llama puede errar—. La exigencia no se debilitó: se movió al handler, que la aplica fail-closed en la ruta ampliada, donde la base sí es una afirmación de quien invoca. Fuera de un workspace sigue haciendo falta una raíz explícita, y sin ella no se escribe nada.
- **La frontera durable de una capacidad nombra sus dos alternativas y muestra la previa.** Lo que una persona decide no es qué clases de efecto concede, sino si esa vista previa se guarda; las clases siguen viajando en la propuesta, que es donde el grant las lee.
- **`render` y `record` son operaciones de package cualquiera sea la señal.** Proyectar revisiones y sellar decisiones de gobierno son cosas que tiene un catálogo y no tiene un documento.
- **Defectos reales corregidos con estas fases**: los ocho campos de `checkpoint-read` volvían `null` para toda sesión moderna; `decisiones_count` daba `0` con el `DECISION.md` lleno; un marcador `_[AI: …]_` sin llenar se presentaba como resultado aplicado; el tablero derivaba la fase con una regla propia; la observación de destinos abría rutas del payload sin validar su forma; y un destino no observado caía a `overwrite: false` por defecto en vez de rechazarse.

## [21.6.0] — 2026-08-07

**El resultado de Git Flow deja de esconder fuentes.** Cada fuente se expandía a un bloque —encabezado, una fila por paso y bloques extra para conflicto o error—, así que un batch sobre varias fuentes crecía muy por encima del frame. Y como el shell recorta el overflow (`overflowY="hidden"` en `app.tsx` + `ScreenFrame`) y la vista no tenía cursor ni ventana, las últimas fuentes quedaban simplemente fuera de alcance: el scroll del terminal no llega a lo que Ink ya recortó, así que no había ninguna forma de consultarlas. Ahora **cada fuente ocupa exactamente una fila**, no envolvente, que lleva su cadena completa de pasos en orden, y todo se recorre por teclado: `↑/↓` entre fuentes, `←/→` sobre la cadena, `Enter` abre el detalle íntegro de un conflicto o un error. El motor no se tocó: `runGitFlow`, `GitFlowResult`/`GitFlowSourceResult` y la política continue-on-failure son exactamente los de antes — el cambio es todo presentación. Sin dependencias npm nuevas.

### Added

- **`result-detail` — el detalle íntegro de una fuente en conflicto o error.** `Enter` sobre esa fila abre el paso afectado, la rama donde se pausó, **todos** los archivos en conflicto o el mensaje de error **completo**, y `Esc` vuelve al resultado con la misma fuente y las mismas posiciones de navegación. Cuando el detalle excede la altura, `↑/↓` lo recorre sin cambiar de fuente. Las líneas se **pre-envuelven** al ancho disponible en vez de dejar envolver a Ink: la ventana vertical cuenta filas, así que una ruta larga costaría dos filas que nadie reservó — y recortar no es opción cuando la vista existe justamente para mostrar el mensaje entero. `Enter` sobre una fuente exitosa no hace nada: su cadena ya expone todo lo que tiene.
- **Ventana horizontal sobre la cadena de procesos.** `←/→` desplaza 8 celdas con clamp en ambos extremos —el tope deja el último segmento completamente alcanzable—, y la fila seleccionada muestra `‹` cuando hay contenido antes y `›` cuando lo hay después. El alias y el estado no se mueven: sólo se desplaza el segmento de procesos. El offset se acota **en la salida**, derivado en cada render, que es lo que hace correcto el resize: ensanchar el terminal re-ancla la fila en vez de dejar la ventana más allá del final de la cadena. Una fila no seleccionada marca su corte con `…`, así una cadena que no cabe nunca parece completa.

### Changed

- **`Enter` deja de reejecutar en el estado `result`; `r` queda como el único acceso a reejecutar o reanudar.** Eran alias de la misma consecuencia y `Enter` pasa a abrir el detalle, así que una sola tecla no puede significar «mostrame esto» y «volvé a correr git» a la vez. `Esc` sigue volviendo al listado de Project, ahora refrescando.
- **`FlowResultView` pasa a ser la superficie interactiva autocontenida del modo `result`.** La lista de fuentes usa el mismo patrón de cursor y ventana que ya usa SOURCES (`useListWindow`), con 20 filas reservadas para el shell y el chrome del resultado más `notificationStackRows` cuando hay avisos activos; el rango visible viaja en el slot `hint` del `SectionHead` precisamente para no gastar una fila propia. Un resultado nuevo reinicia selección, offset y detalle: arrastrar el cursor entre corridas apuntaría a otra fuente.
- **Las teclas del resultado viven en la vista, no en `ProjectTab`.** Ink entrega el input a **todos** los hooks activos, así que mantener una rama `result` en los dos `useInput` haría que `r` disparara git dos veces. La pestaña conserva la ejecución, el logging y el lock global, y sólo expone `onRerun` / `onBack`.
- **La cadena se rinde como un único `Text` y el estado de cada paso viaja en el glifo.** El offset horizontal recorta una cadena, y para recortarla hace falta tener una: colorear token por token exigiría una fila de hijos y el recorte dejaría de ser exacto. Coincide con la regla de accesibilidad de la TUI —ningún estado depende sólo del color—. El label de `GitFlowStep.step` se rinde **verbatim**: es la fuente canónica de la operación y sus ramas, y volver a interpretarlo acá duplicaría el planner git y quedaría a la deriva la próxima vez que ese planner cambie una etiqueta.
- **La zona fija se dimensiona contra el ancho disponible, no sólo contra el alias más largo.** Si no, un alias largo en un terminal angosto construía una fila más ancha que su contenedor, Yoga la envolvía y una fuente volvía a ocupar dos filas — el defecto exacto que esta vista elimina. El alias se acota entre 4 y 24 celdas: por debajo de 4 quedaría vacío (`truncateCells(s, 1)` devuelve cadena vacía) y la fila perdería la identidad que existe para conservar. En terminales angostos se priorizan alias y estado; los procesos siguen alcanzables con `←/→`.
- **Una fuente sin pasos muestra su motivo en la fila.** Cuando una precondición falla no hay cadena que mostrar, así que la cadena **es** el error: la fila no queda muda.

## [21.5.0] — 2026-08-07

**Dos flujos sobre el mismo repositorio dejan de pisarse.** Hasta acá la concurrencia de Workline llegaba hasta la puerta del código: varias sesiones podían convivir, pero todas editaban el mismo árbol de trabajo, así que el segundo flujo veía los cambios a medio hacer del primero y el invariante git-safe verificaba una única rama por alias que no distinguía a quién pertenecía el trabajo. Además `aw next-number` era una lectura optimista —leía el máximo y devolvía máximo+1, y quien lo pedía escribía el archivo después, fuera de toda sección crítica—, de modo que dos flujos acuñando en paralelo recibían el mismo `NNN` y el segundo pisaba al primero. Ahora cada flujo trabaja en su propia **unidad de aislamiento** —un worktree del source sobre su propia rama—, el correlativo se **reclama** en vez de consultarse, y al cerrar la rama del flujo se integra con los conflictos reportados. Un workspace de un solo flujo, sin unidades, se comporta exactamente como antes. Sin dependencias npm nuevas.

### Added

- **`aw worktree ensure | list | release | integrate` — el ciclo de vida de la unidad de aislamiento.** La unidad vive en `~/.<ns>/worktrees/<clave-workspace>/<alias>/<sesión>` sobre la rama `aw/<sesión>`, y **la convención es el registro**: la ruta ya dice a qué workspace, fuente y sesión pertenece, y `git worktree list` del source es su vista viva. No nace ningún archivo de registro, así que no hay nada que pueda divergir de los árboles que realmente existen. `ensure` es idempotente y da visibilidad multi-root a la raíz; `release` se la quita. La ocupación no se implementa: git ya rechaza la misma rama en dos worktrees, y ese rechazo se reporta con el código `unit_occupied` nombrando al ocupante.
- **`aw next-number --claim <resto-del-nombre>` reclama el correlativo en vez de consultarlo.** El escaneo y la materialización del destino ocurren dentro de **un** boundary del lock del workspace, y la creación exclusiva queda como segunda línea si el lock llegara a expirar por debajo. El descarte es por **número**, no por nombre: dos flujos con slugs distintos ya no pueden quedarse los dos con `020`. Devuelve `claimed_path`. Sin `--claim` sigue siendo la consulta pura de siempre, y `--claim` con `--dry-run` se rechaza —un reclamo escribe, una consulta no—.
- **`aw worktree integrate` — merge y nunca rebase.** Integra `aw/<sesión>` sobre la rama de trabajo declarada del source, en el checkout principal. El puerto git ya tenía merge y las tres etapas de conflicto que `aw fix-git` lee, así que un conflicto tiene a dónde ir; un rebase habría exigido primitivas nuevas y reescrito commits que el flujo ya dio por hechos. El orden lo fija quién cierra: cada integración parte de la rama viva, así que la segunda ve lo que integró la primera.
- **`GitPort` gana las primitivas de worktree** (`worktreeList`, `worktreeAdd`, `worktreeRemove`, `worktreePrune`, `branchExists`) con su parser de `--porcelain`. `worktreeRemove` va **sin `--force`**: un árbol con trabajo sin commitear es del usuario, y borrarlo para que un comando termine bien es justo el fallo que la feature existe para evitar.
- **`FileSystemPort.realPath`** — la ruta canónica del sistema operativo, con la de entrada intacta cuando no existe. Hace falta donde una ruta que construimos se compara con una que git **reporta**: git resuelve symlinks, así que en macOS (`/tmp` → `/private/tmp`) o con un home detrás de un enlace, las dos grafías de la misma carpeta nunca casarían.
- **`aw status` lleva la unidad por sesión activa y la lista de huérfanas.** Una unidad que sobrevive a su sesión aparece en `orphan_units` con el motivo (`session_closed`, `session_absent`, `directory_missing`) y el comando exacto que la libera — reportada, nunca limpiada por su cuenta: lo único peor que dejar una atrás es borrarla con trabajo sin commitear adentro. `aw resume` lleva la unidad en su propuesta, que es lo que distingue dos flujos concurrentes en vez de proponerles lo mismo a los dos.
- **`aw session-close` informa `pending_integration`.** Cerrar no integra ni libera: el trabajo de una unidad son commits que nadie mergeó todavía, y un cierre que dispusiera de ellos en silencio sería la única forma en que esta feature podría perder trabajo. Así que lo dice, con la rama, la ruta y el comando que la integra.

### Changed

- **El invariante git-safe verifica la línea de trabajo del flujo, no la rama del alias.** Con unidades para la fuente, toda edición fuera de ellas se bloquea con el comando exacto que crea la propia, y una edición dentro de la unidad de **otra** sesión se bloquea nombrando ambas. **Sin unidades la verificación es la de antes, byte por byte** — el estado de casi todos los workspaces. La identidad de conversación (el `session_id` del payload del hook) no habilita el bloqueo: lo **afina**, distinguiendo la unidad propia de la ajena, de modo que la protección del checkout principal funciona también en los hosts que no la entregan.
- **El hook `PreToolUse` dejó de calcular su propio veredicto**: llama a `aw check-branch` y solo aporta su mitad —qué herramientas mira, cómo lee el payload y cómo decir «no» de forma accionable—, así que el hook y el comando no pueden divergir en dos respuestas distintas sobre el mismo archivo. El hook sigue sin escribir nada: la resolución de sesión va con `bind: false`.
- **La resolución del source dueño de un archivo reconoce las rutas de unidad.** Antes un worktree colgaba fuera de la ruta declarada de toda fuente y por eso no pertenecía a ninguna: la verificación lo dejaba pasar en silencio.
- **El registro de procesos hace su lectura-modificación-escritura bajo el lock del workspace.** Dos flujos lanzando a la vez leían el mismo array y cada uno escribía su copia, así que el segundo borraba el proceso del primero: el registro mostraba un lanzamiento y la máquina corría dos. `list()` solo toma el lock cuando la reconciliación tiene algo que escribir.
- **`acquireLock` acepta una espera acotada opcional (`waitMs`), con `0` por defecto.** `HISTORY.md` y el bloque del proyecto siguen fallando rápido a propósito: su llamador puede reintentar el comando entero. Un reclamo de correlativo y un registro de proceso no pueden —cuando llegan al lock el número se está entregando o el proceso ya está lanzado—, así que perder la carrera ahí pierde trabajo real. Mientras quede presupuesto de espera, la contención deja de contar como robo de slot: N reclamantes encolados sobre un marcador de liberación ya no reportan todos «ocupado» sobre un lock que nadie tiene.
- **Doctrina**: las reglas git de los loops que editan código nombran la unidad y su integración al cierre; la instrucción de numeración pasa a reclamar el número en `PLAN-INPUT`, `plan-new-loop`, `spec-new` y `quick-loop`; `roles/git` y `hooks/README` describen la línea de trabajo del flujo con la rama de alias como caso «sin unidades». Se retira `## Location` de `CODE-POLICIES`, que repetía lo que el chasis declara «never repeated per link».

## [21.4.1] — 2026-08-06

**Detener un proceso deja de afirmar un éxito que nadie verificó.** `stopProcess` señalaba el árbol y marcaba el registro como `stopped` sin comprobar nada: `killTree` traga todo error a propósito —un pid ya muerto no es un fallo— y SIGTERM es asíncrono, así que un proceso que sobrevivía a la señal quedaba registrado como detenido, desaparecía del conteo de activos y seguía ocupando su puerto. Peor en la ruta de re-lanzamiento: sobre ese superviviente se lanzaba un segundo proceso, y el primero ya no estaba en la vista `running` de nadie. Ahora la detención se confirma contra el estado real del sistema y lo que se ve es lo que pasó. Sin dependencias npm nuevas, sin cambios en `ProcessPort`.

### Changed

- **`stopProcess` devuelve `{ stopped: boolean }` y solo marca el registro cuando el árbol murió de verdad.** La confirmación usa el `isAlive` que el puerto ya exponía (`kill(pid, 0)`): consulta de entrada —camino rápido, cero espera cuando ya cayó— y reintento cada 60 ms hasta 600 ms, porque SIGTERM no es instantáneo. Marcar `stopped` un proceso vivo era la mentira que después repetían el chip por fuente, el tile de procesos y el detector de colisiones.
- **`relaunchProcess` y la ruta de colisión de la TUI ya no lanzan sobre un superviviente**: devuelven el error nuevo `stop_failed` de `LaunchResult` en vez de dejar dos procesos peleando por el mismo puerto.
- **El panel de detalle de [Project] informa el resultado de «Detener»**: `notice` con el PID cuando murió, y aviso explícito cuando sigue vivo («sigue contando como activo; detenelo desde el sistema y refrescá»). El log operativo lo distingue: `info` cuando se detuvo, `warn` cuando no.

## [21.4.0] — 2026-08-06

**El TUI muestra lo que se consulta, el CLI decide cuánto se gasta en modelo, y la evidencia de diseño se pide solo donde hay algo que ver.** Tres frentes independientes. La pestaña [Skills] listaba las 24 recomendadas mezcladas con todo lo detectado en el sistema y [Project] apilaba dos listas de ramas y una de procesos que nadie leía: ahora [Skills] abre proyectada a la semilla con un toggle, y [Project] queda en workspace + StatTiles + Sources, con un indicador por fuente de lo que está corriendo. En paralelo, el host anunciaba primitivas de subagentes y nada decidía cuándo pagarlas —y peor: un agente corriendo dentro de Warp se detectaba como Warp—, así que el gasto pasa a ser una regla del CLI y el host de agente se resuelve aparte del terminal. Y el gate de `handoff` exigía preview estática y renditions a todo criterio no-`not_visual`, incluidos los de interacción: un cambio de control pequeño pagaba un artefacto visual que no agregaba señal de aceptación. Sin dependencias npm nuevas.

### Added

- **Filtro por defecto en [Skills] con toggle `t`** — la lista abre proyectada a `RECOMMENDED_SKILLS` (cualquiera sea el estado de cada skill) y `t` alterna a todo lo detectado. El modo se anuncia en el hint del SectionHead (`recommended only · t show all` / `all skills · t show recommended`) y en las QuickActions, el `count` de la sección sigue al modo y los totales del PageHead siguen siendo globales. Es un `useState` del tab: cada apertura arranca filtrada. El cursor se conserva por nombre al alternar, o clampea si la skill activa queda fuera.
- **Indicador de procesos por fuente en [Project]** — la fila de [Sources] lleva el chip `● N running` cuando esa fuente tiene N ≥ 1 procesos activos, recalculado en cada reload (carga, lanzar, detener, relanzar, refresh). Cuenta solo `state === "running"`: los registros `stopped`/`exited` son historial y no aparecen en ningún lado. El centinela «all sources» no lleva chip.
- **Gestión de procesos desde el panel de detalle de la fuente** — `Detener` / `Re-lanzar` / `Ver log · <perfil> (PID)` por cada proceso activo, entre las acciones de git flow y la destructiva «Quitar del workspace». Reemplaza al modo `p` con las mismas operaciones: quitar la lista no podía costar la capacidad de operar lo que está corriendo.
- **`src/domain/resource-policy.ts` — el gasto de ejecución es una regla del CLI, no del host.** `decideResources` devuelve la única estrategia admisible para una frontera: la determinista no despacha trabajador de modelo alguno, la de ejecución tiene una invocación externa y devuelve su evidencia, y la semántica es inline salvo que haya tres o más particiones independientes —sin dependencias entre sí y sin escrituras solapadas— sobre un host capaz; ahí el tope es 3 subagentes y 4 trabajadores de modelo contando el coordinador. `validateResourceUsage` rechaza un recibo que reclame más de lo autorizado. Las fronteras humana y de autorización nunca abren en abanico.
- **`aw harness` distingue `agent_host` de `terminal_host`** y reporta además la primitiva nativa del host (`execution`) y las dos decisiones que el CLI aplica antes de cualquier trabajo de modelo (`resource_policy.deterministic` y `resource_policy.semantic_default`). El campo `harness` se conserva como deprecado para quien consuma la forma anterior del JSON.
- **`--host <id>` en `aw harness`, `aw capability`, `aw flow` y `aw skills`** — fija el host de agente explícitamente en vez de deducirlo del entorno. Un id que no está en el catálogo se rechaza con el listado válido, nunca se ignora en silencio.
- **`subagent-dispatch` es una capacidad proyectada** — `aw self detect-hosts` la informa por host: `native` nombrando la primitiva y el tope que el CLI permite tras probar particiones independientes, o `unsupported` diciendo que el trabajo semántico se queda inline.
- **`HarnessSpec.execution` por host en el catálogo** — `Task` en Claude Code, `agents` en Codex, Antigravity y OpenCode, `SubagentStart` en Kimi; Oz, Warp y Crush declaran que no tienen despacho directo.
- **Ciclo `compact` / `expanded` del paquete de diseño** — un delta compacto (superficie existente, ≤2 pantallas, sin journey, regla, token, asset, dependencia externa, bloqueo ni adaptación) publica su `handoff` en un solo paso desde SPEC y PLAN lo reusa; lo expandido mantiene el camino de siempre (SPEC en `outline`, PLAN promueve solo la clausura que implementa). La ruta la decide el CLI, no el modelo.

### Changed

- **[Project] se adelgaza a workspace + avisos + StatTiles + Sources.** Salen «Ramas de trabajo actuales», «Ramas QA actuales» y «Procesos lanzados», y con ellas el modo de navegación `p` con su cursor, su handler, su QuickAction y su lock de teclas globales; la tecla `p` queda libre. Las StatTiles conservan los conteos globales que esas listas mostraban. `reservedRows` se recalcula sin las secciones eliminadas.
- **Los wrappers instalados por host atan sus llamadas al CLI con `--host <target>`.** La instalación es el único momento en que el destino se conoce con certeza; preservarlo evita que un marcador de terminal pise al runtime de agente que esa superficie eligió. Los wrappers compartidos en `.agents/skills` quedan deliberadamente sin atar, porque varios hosts los leen.
- **Un marcador de terminal ya no tiene precedencia sobre un marcador de agente.** La detección recorre el catálogo por marcadores propios primero y solo cae al terminal como último recurso.
- **La evidencia visual se exige solo a los criterios `visual`.** Una pantalla `handoff` debe una preview estática de su `default_state` únicamente si declara aceptación visual; un criterio `interaction` se especifica y se verifica por sus estados declarados y su prueba de implementación. Antes todo criterio no-`not_visual` debía renditions, y uno de interacción debía además un prototipo o storyboard con `interaction_evidence`.
- **La fila `subagent-dispatch` de `HARNESS.md` se corrige contra el catálogo**: Crush y Warp pasan a `inline` (la orquestación en la nube de Oz no es un binding directo de trabajador) y Codex y Kimi quedan con la primitiva que realmente exponen.
- **`CHASSIS.md` declara que los tramos deterministas no consumen trabajador de modelo, subagente ni proceso externo**, y que la verificación independiente usa subagente solo cuando la regla de particiones independientes del CLI lo admite.

### Fixed

- **Codex dentro de Warp se identificaba como Warp.** `TERM_PROGRAM=WarpTerminal` ganaba sobre el marcador real del agente, así que el binding, las capacidades y el mecanismo de structured-choice que se aplicaban eran los del terminal. `agent_host` y `terminal_host` son ahora dos respuestas distintas.
- **`CODEX_THREAD_ID` faltaba entre los marcadores de entorno de Codex**, que era justamente el que exporta a sus subprocesos.

### Removed

- **`src/cli/tui/components/process-list.tsx`** — sin consumidores tras el adelgazamiento de [Project].
- **`checkInteractionEvidence`** — el chequeo que obligaba a un criterio de interacción a citar un prototipo o storyboard.

## [21.3.1] — 2026-08-05

**Las listas de la TUI windowean al alto del terminal: la fila activa nunca vuelve a salirse de pantalla.** Hasta aquí ninguna lista windoweaba — todas renderizaban sus filas completas y el shell recortaba el exceso (`overflowY="hidden"`), así que con más filas que viewport el cursor llegaba a filas que nadie pintaba y la navegación era a ciegas; la lista de SOURCES del tab Project era la primera en notarlo. Un hook compartido nuevo acota cada lista al alto real con edge-scroll —la ventana solo se mueve cuando el cursor la abandona— y un indicador de rango (`5–13 de 31`) vive en el encabezado de sección sin gastar filas. Sin dependencias npm nuevas.

### Added

- **`useListWindow(count, cursor, reservedRows, maxVisible?)` + `windowRangeHint`** (`src/cli/tui/use-list-window.ts`) — ventana keyed a `useTerminalSize` con ajuste en fase de render (sin frame con ventana vieja); contrato no-TTY heredado: `rows=0` → la lista renderiza completa, así tests y pipes no cambian. Aplicado a las cinco listas navegables: SOURCES (Project), conexiones (MCP), skills, hosts+destinos (Workline) y logs (Status). Cada lista reserva además la altura del NotificationStack (`notificationStackRows` + `useNotificationItems`), así un toast o el banner de update tampoco recorta filas.

### Changed

- **Homologación de comportamientos entre tabs al patrón MCP/Skills**: cancelar una confirmación (`esc`/`n`) vuelve al panel de detalle en todas partes (Project volvía a la lista); el panel de detalle deja de retener el lock de teclas globales (lo retiene el modo procesos, cuyas `r`/`x`/`o` colisionan con el refresh global); los hints de skills se alinean («esc to close detail» · «esc cancel» en wizards).

### Fixed

- **El cursor de la sección de logs se salía de su ventana**: el cap fijo de 8 filas seguía clampeando al total de entradas, así que pasada la fila 8 ninguna fila se pintaba activa y ⏎ abría una entrada invisible. El cap sigue siendo 8 como decisión de diseño (`maxVisible`), pero la ventana ahora sigue al cursor.

## [21.3.0] — 2026-08-05

**Cada host recibe instrucciones sobre su propio mecanismo, ninguna superficie anuncia lo que el host no sostiene, y un recorrido llega a su fin sin resolver pasos por fuera.** La presentación nativa de una frontera humana era doctrina neutra: los wrappers instalados llevaban el MISMO texto en los ocho hosts, así que nada le decía al agente en qué host corría ni qué mecanismo usar — y la detección en runtime no lo resuelve, porque `aw harness` responde `unknown` dentro de Kimi Code. Ahora el **binding por host se estampa en la instalación**, el único momento en que el destino se conoce, generado desde una fuente canónica única del catálogo. En paralelo, tres defectos que hacían perder trabajo en silencio: la instalación de hooks en Kimi podía escribir una sección que su loader descarta entera, el tablero no veía un diferido escrito en español o con lista numerada, y cuatro filas del motor exigían un efecto que en un batch válido puede no ocurrir. Sondas sobre los runtimes instalados —no sobre la doc— corrigieron además cuatro afirmaciones falsas del catálogo. Sin dependencias npm nuevas.

### Added

- **Binding de `structured-choice` estampado por host al instalar** — cada wrapper nativo, cada skill-as-command sintetizada y la skill de capacidad llevan el mecanismo de SU host: herramienta, techos por llamada, dónde va la oración funcional de cada opción, si el host ya ofrece respuesta libre, y **cuándo** degradar a markdown etiquetado. Generado desde `HarnessSpec.structuredChoice`, con guard que lo ata a la fila de `HARNESS.md`. El bundle canónico `skills/w` sigue host-neutro, y el smoke verifica las dos cosas.
- **`structured-choice` es una capacidad proyectada** — `aw self detect-hosts` la informa por host con su estado (`native` | `degraded` | `unsupported`) y un detalle que siempre nombra la condición de fallback: `native` a secas se leería como «siempre nativo», y en tres de los cuatro hosts nativos no lo es.
- **Validación previa de la sección de hooks de Kimi** — se juzga la sección COMPLETA que quedaría escrita, entradas propias y preexistentes del usuario, contra su esquema estricto. Si algo no valida, el resultado es `blocked`, **no se escribe nada** y el mensaje nombra cada entrada inválida con su índice, su evento y de quién es. Antes se validaba sólo lo propio y se escribía al lado: como Kimi descarta su sección `hooks` entera ante una sola entrada inválida, una entrada mala preexistente desarmaba también los nuestros mientras el install decía «installed».
- **Las degradaciones declaradas de un host son visibles en el estado**, no sólo en el output de install (`reportHookTemplateLosses`), y la TUI las muestra en el detalle del host esté o no armado el hook: «este host no puede cargar X» es verdad antes de instalar.

### Changed

- **Un paso cuyo efecto no aplica se salta declarando su razón, en vez de exigirlo.** Cuatro filas delegadas —`plan-exec.task-marking`, `plan-exec.plan-done`, `plan-exec.commit-execution` y `quick.db-scripts-only`— declaraban su efecto sin condición, así que un batch legítimo sin ese efecto no podía contestarlas con la verdad: la única respuesta honesta era negarlo, y una frontera negada que se re-emite agota sus intentos y detiene la corrida. Ahora dos fronteras semánticas nuevas (`plan-exec.pending-effects`, `quick.db-touched`) declaran **en positivo** que hay algo que hacer, y las cuatro filas condicionan sobre esas señales con su `otherwise`. Las otras doce filas delegadas con efecto no cambian: su efecto sí ocurre siempre.
- **Omitido y degradado son dos canales distintos** en la transformación de hooks: «el hook no está» y «el hook está y hace menos» dejan de reportarse igual. El matcher de `SessionStart` que Kimi no puede llevar se declaraba en silencio; ahora se declara.
- **La matriz `HARNESS.md` separa lo que probó una corrida de lo que sigue apoyado en doc**, re-verificada contra los runtimes instalados y re-fechada; el ledger de verificación se regeneró con las versiones reales.
- **`README.md`** ya no dice «numbered markdown» ni describe los hooks de Codex como pendientes de cablear.

### Fixed

- **`aw sources --verbose` recortaba un carácter del PRIMER archivo cambiado** (`rc/…` por `src/…`): el adaptador hacía `trim()` antes de `split`, comiéndose el espacio inicial de la primera línea del formato porcelain. Ninguna prueba lo fijaba y ningún consumidor dependía de ello, pese al comentario que invocaba «back-compat».
- **Un diferido escrito en español o con lista numerada desaparecía del tablero.** `Deferred` y `Excluded` eran los dos únicos encabezados de la tabla de alias sin forma en español, y el lector de la lista de descartados no consultaba esa tabla; además `listItems` descartaba las listas ordenadas enteras. Los tres arreglos van juntos porque cada uno solo resolvía una parte.
- **Cuatro afirmaciones falsas del catálogo, corregidas por sonda sobre el binario instalado**: Codex ubicaba sus hooks en `config.toml` cuando son `~/.codex/hooks.json` con la forma de Claude; Codex declaraba `request_user_input` disponible cuando su router la niega en Default mode; y Gemini/Antigravity nombraba `ask_user`, que no existe en `agy`, en vez de `AskQuestion`, cuya opción no tiene campo de descripción.

### Notes

- **Codex sigue con hooks no gestionados, y ahora se sabe por qué**: exige una revisión humana interactiva por cada hook nuevo o modificado, persistida como `trusted_hash`. Escribir el archivo no lo arma, y fabricar ese hash sería falsificar una aprobación de seguridad.
- **Los hooks de crush, Gemini y opencode siguen sin armar, y su fila de catálogo sigue sin verificar.** Esta versión corrigió el mecanismo de hooks de Codex y la elección estructurada de los ocho hosts, pero no las filas de hooks de estos tres: Gemini todavía figura con `BeforeTool`, un evento que no existe en el binario `agy`, y crush con «preliminary» en vez de su `crush.json` → `hooks`. Verificarlas y armarlos es trabajo de la próxima versión. Lo único que esta versión garantiza sobre ellos es lo negativo: nadie escribe hooks ahí y ninguna superficie los reporta armados.

## [21.1.0] — 2026-08-04

**El control del recorrido deja de interpretarse en prosa y pasa a dirigirlo el CLI: una sola autoridad por decisión, verificable por comando y equivalente entre hosts.** Las reglas mecánicas de los cinco flows —detección y clasificación de gaps, transiciones de estado de fase, inferencia de execution batches, gates de convergencia— las aplicaba el agente leyendo la doctrina: consumían contexto, dos hosts podían diferir sobre el mismo estado y nada era verificable por comando. Ahora un **motor de dirección** expone `aw flow` (`advance` | `submit`): un registro de autoridad como dato declara para cada decisión y transición de los recorridos públicos una única autoridad (`cli`, `agent`, `human`); `advance` aplica todas las transiciones deterministas consecutivas y devuelve la **directiva** de la primera frontera que no lo es —semántica, humana, de autorización, de ejecución o final—; y `submit` valida la respuesta como dato antes de tocar el estado —fail-closed, con sello anti-staleness y ledger de intentos que distingue reenvío de intento nuevo—. El estado de corrida vive versionado y sellado en la carpeta de sesión, sin cambiar el contrato de `SESSION.md`, `CHECKPOINT.md` ni `BACKLOG.md`. Una transición cuyo trabajo ocurre fuera del proceso se emite como frontera `execution` con su invocación sellada y **solo avanza con un resultado verificable**: una confirmación booleana o una narración sin evidencia no cuentan. La doctrina pierde la regla y conserva la explicación —una guarda sobre el propio Markdown falla si algún documento reenuncia algo `cli-owned`— y el mecanismo de fallback legacy quedó retirado: una transición sin propiedad es error explícito, nunca una vuelta silenciosa a la prosa. La equivalencia entre hosts se verificó por fixture y con recorridos reales idénticos en Codex y Kimi (20/20 transiciones, ninguna omitida). Sin dependencias npm nuevas. Bundle `w` **14.1.0**.

### Added

- **`aw flow advance | submit`** — comando hermano de `capability`, con su familia en la ayuda agrupada y su fila en la pestaña Workflow del TUI. La respuesta de `submit` entra por stdin como JSON y la aprobación de efecto viaja aparte en `--approval <digest>`; las directivas y los rechazos de negocio viajan `ok:true` con el vocabulario de outcome del receipt, y `ok:false` queda para fallos de invocación.
- **Registro de autoridad exhaustivo y probado** — cada decisión y transición declara una sola autoridad y su propiedad; la guarda falla si un comando público queda sin entradas ni exclusión con motivo (`spec-new` quedó clasificado por exclusión: no abre loop ni hay corrida que dirigir).
- **Estado de corrida propiedad del CLI** — versionado, sellado con la canonicalización del sistema, aplicación atómica bajo el lock por sesión, y rechazo fail-closed de estados corruptos, adelantados o de otra versión con acción de reparación o re-adopción explícita.
- **Directiva de frontera compuesta** de los contratos ya entregados (envelope, protocolo semántico, receipt de capacidad), sin campos paralelos —con guarda— e imposible de mentir por construcción: no hay frontera sin acción siguiente, ni bloqueo sin causa, ni efectos permitidos sin autorización que los cubra.
- **Frontera `execution`** — acción delegada con invocación sellada (`program`, argumentos, cwd/target, input y evidencia exigida), idempotencia y recuperación declaradas, y los outcomes del receipt; solo `completed` con evidencia válida aplica la transición, y un efecto parcial queda pendiente con acción de reconciliación.
- **`resume` y `status` proyectan la corrida** — frontera vigente e invocación exacta: una sola autoridad de «qué sigue», reanudable en otro host sin la conversación original.

### Changed

- **QUICK, SPEC, PLAN y las reglas transversales del chasis son `CLI-owned`** — los loops conservan la explicación del contrato y pierden la regla. Las 23 reglas transversales quedaron observables cada una por su forma: atravesada por el recorrido, atribuida al mecanismo que la realiza, o contratada en el comando que la ejecuta.
- **`Compactar` se emite junto a `Cerrar`** en toda frontera con alternativas.
- **`HARNESS.md` declara binding o limitación para cada clase de frontera**, incluida `execution`: el host transporta la acción, el ejecutor devuelve salida real de herramienta y la superficie presenta el resultado — una confirmación booleana se rechaza.
- **Tope de intentos por frontera** — una frontera respondida más veces que su tope degrada en vez de repetirse; y ningún target de acción delegada puede cruzar la frontera de escritura de `docs/`.

### Fixed

- **Reenviar una respuesta ya rechazada se reportaba con outcome `completed`** (`FLOW_ANSWER_RESENT`) — corregido, con guarda propia en `flow-fail-closed`.

## [21.0.0] — 2026-08-03

**El diseño de interfaces deja de vivir dentro de los documentos y pasa a ser un dossier durable con identidad propia, y el camino viejo queda retirado sin ruta de migración.** Antes el diseño se escribía dos veces —la sección `## UI spec` de la spec y un design SPEC por pantalla como artefacto de sesión— y moría con la sesión: sin catálogo, sin identidad estable, sin revisión, sin digest, y sin forma de que una tarea fijara exactamente qué diseño implementa. Ahora cada diseño es un **UI Design Package v1** bajo `docs/designs/NNN-design-<slug>/`: su `design-manifest.json` es el índice mutable, sus `baselines/DES-NNN-r00N.json` sellan una selección cerrada con SHA-256 sobre JSON canónico —sin autorreferencia y sin depender del índice—, y sus `flows/*.md` y `screens/*.md` declaran identidad, grafo, estados, dependencias y trazabilidad en frontmatter versionado, de modo que **nada normativo depende de interpretar prosa**. La spec guarda tres líneas —package, baseline y digest—; el plan fija raíces exactas (`DES-001@r4 / SCR-002@r2#empty`); y `plan-exec` **falla cerrado** antes de implementar si una referencia falta, su digest no coincide, la revisión está revocada o su clausura no alcanza `handoff`, nombrando siempre el artefacto y la acción correctiva. Una revisión superseded pero íntegra solo avisa: publicar `@r5` no invalida el `@r4` que alguien fijó a propósito. Renombrar o mover el dossier tampoco rompe nada — la identidad resuelve por `DES-NNN` y el path es un hint reparable. `status` y `resume` proyectan el grafo `spec → package → flow/screen → plan/tarea` distinguiendo válida, stale, missing y huérfana. Sin dependencias npm nuevas. Bundle `w` **14.0.0**.

### BREAKING

- **`ui-design` y `ui-spec` son nombres retirados y rechazados.** La capacidad pública de diseño es `design`, su implementación por defecto también, y su único formato de salida es el UI Design Package v1. Un binding que nombre cualquiera de los dos **se ignora con aviso** y el role conserva su default incorporado. No hay alias, dual-read, importador, conversión, migrate-on-touch ni migración masiva.
- **Retiradas las cuatro superficies del camino viejo:** `roles/ui-spec/ROLE.md`, `artifacts/artifacts-design/SPEC.md`, `modules/PLAN-DESIGN-SPECS.md` y `modules/PLAN-REFINE-DESIGN-SPECS.md` ya no existen en el bundle, y ninguna doctrina apunta a ellas.
- **Presentar material legacy es `retired/unsupported`.** Una sección `## UI spec`, un design SPEC de sesión (`NNN-SPEC-<SLUG>.md`) o una salida de `ui-spec-generator` se **reporta**, nunca se lee como contrato ni cuenta como evidencia de un gate: el diagnóstico exige **recrear** el resultado sobre el package. **Los archivos históricos quedan físicamente intactos**, byte a byte — retirar un input no es borrar un registro.
- **Sin ruta de migración.** Un workspace con diseño en el formato viejo pierde su camino de diseño en esta versión y debe recrearlo sobre el package desde fuentes vigentes.

### Added

- **`docs/designs/` como categoría durable de `docs/`**, con identidad `DES-NNN` que no deriva de spec, plan, sesión, slug, path ni proveedor, y descubrimiento que resuelve por identidad aunque el dossier se haya renombrado o movido.
- **`aw designs`** — lista los packages (identidad, baseline vigente, ubicación actual), `--id DES-NNN` resuelve uno por identidad, y **`--plan <doc>`** corre el gate de precondición de `plan-exec` por tarea, con salida distinta de cero cuando bloquea. `--require-approval` activa la política de aprobación del workspace, apagada por defecto.
- **Gobierno con cuatro dimensiones independientes** — madurez (`outline`/`handoff`), review, currentness y execution policy se mueven por separado. Un review record vive **fuera** del baseline que decide, se sella con su propio digest y aprueba bytes, no un número: una revisión nueva nace `proposed` porque no existe record que la nombre, así que **la herencia de aprobación es imposible por construcción**. Solo una revocación explícita y auditada prohíbe una revisión.
- **Publicación atómica** — valida el candidato completo antes del primer byte y, ante un fallo o una base concurrentemente modificada, deja el árbol idéntico. El compare-and-swap contra `parent_baseline` es obligatorio. Una spec o plan cuya referencia se mueve viaja **en el mismo lote**, así que nunca queda un documento citando un baseline inexistente ni un baseline sin consumidor.
- **Clausura por tarea** — desde las raíces exactas que una tarea declara se calcula qué flows, screens, estados, rules, tokens y assets consume, y se promueve a `handoff` **solo eso**: diez screens en `outline` y tres promovidas es la forma normal de un package.

### Changed

- **Los cuatro flows referencian en vez de contener.** `spec-new` solo registra la necesidad de UI; `spec-refine` reutiliza un baseline compatible o abre una revisión `outline` y deja únicamente `## Design references`; `plan-new` promueve la clausura que implementa y fija las raíces; `plan-refine` acota las revisiones nuevas al delta y **no reapunta a otros consumidores del mismo baseline**. `quick` lee y valida un package pero escala —a `plan-refine`, o a `spec-refine` si cambia comportamiento o aceptación— conservando la evidencia reunida. `persist` encamina una idea UI durable primero a SPEC.
- **La señal `ui` entrega un solo módulo** (`modules/DESIGN-REFERENCES.md`) a los cinco comandos que lo necesitan, y el presupuesto de contexto sigue cumpliéndose en todos sus ratios.

### Fixed

- **`judgeExecution` validaba media identidad** — comprobaba el package y no la revisión, así que `DES-001@r99` respondía «ejecutable» y, con la política activa, culpaba a una aprobación faltante en vez de decir que esa revisión no existe.
- **`target_digest` era decorativo** — se validaba por forma y ninguna decisión lo consumía: un review que citaba un digest inventado aprobaba igual. Un baseline republicado con el mismo número y otro contenido ya no está aprobado por el record viejo.
- **La política de aprobación no leía la decisión vigente** — preguntaba «¿alguna vez hubo un `approved`?», así que un `rejected` posterior no retiraba nada y una aprobación era irretirable.
- **El índice podía contradecir lo que indexa** — `governance.reviews[]` declaraba id, path, digest y target sin cotejarse nunca contra el archivo en ese path.

## [20.26.0] — 2026-08-02

**Las opciones de Workline dejan de ser coordenadas sin contexto y la mejora llega al árbol que cada host realmente ejecuta.** Cada alternativa tiene ahora una etiqueta semántica y una frase funcional —resultado, trade-off o ejemplo—; Claude Code, Codex, Kimi Code, Gemini/Antigravity, OpenCode y Crush usan su selección nativa cuando puede conservar esa forma, mientras Warp/Oz y cualquier superficie limitada degradan a Markdown etiquetado sin truncar candidatos ni exigir respuestas como `1A, 2A, 3A`. La distribución también queda cerrada: wrappers nativos y sintetizados resuelven sus manuales dentro del `skills/w` instalado y fijan ese mismo árbol en `aw context-plan --root`, de modo que una CLI global con otro bundle ya no puede desviar el recibo. El smoke aislado cubrió 8 hosts + `agents`, 9 bundles idénticos y 144 wrappers. Bundle `w` **13.23.0**.

### Changed

- **Contrato `structured-choice` funcional y progresivo** — toda opción lleva etiqueta + explicación breve; las superficies de un solo campo usan `Etiqueta — explicación`, los hosts que inyectan respuesta libre no reciben un `Other` duplicado y el overflow cae a texto sin perder opciones. El fallback acepta labels o `Aceptar recomendaciones`, nunca coordenadas posicionales.
- **Matriz de bindings actualizada con evidencia primaria** — límites y herramientas concretas viven sólo en `HARNESS.md`; el chasis común sigue expresado por capacidad. Las guardas parsean la matriz contra el catálogo canónico para que un host nuevo no nazca sin binding o limitación explícita.
- **Cada comando fija el bundle de su recibo de contexto** — la fuente del plugin Claude usa `${CLAUDE_PLUGIN_ROOT}/skills/w`; `self install-skill` materializa ese token a la ruta absoluta del target en wrappers nativos y `w-<command>` sintetizados.

### Fixed

- **Los wrappers nativos apuntaban fuera del bundle.** Claude, Gemini CLI, OpenCode y Crush copiaban referencias `../loops`/`../harness` authored desde `skills/w/commands` sin reubicarlas desde sus directorios de comandos. El instalador calcula ahora la ruta relativa al `skills/w` de cada target.
- **`context-plan` podía medir una doctrina distinta de la activa.** Sin `--root`, el diseño determinista del CLI usa su bundle empaquetado; si el host había recibido una versión más nueva, el recibo quedaba stale. Las 16 superficies pasan ahora el root explícito y un guard impide reintroducir llamadas desnudas.

## [20.25.0] — 2026-07-29

**Los hosts vivían en cuatro registros que no coincidían, y la detección respondía con un booleano a cuatro preguntas distintas.** El dominio declaraba 7 harnesses (con `oz`, sin `agents`), los destinos de instalación 8 (con ambos), la TUI mantenía su propia lista de 7 (con `agents`, sin `oz`) y el doctor filtraba por `mcpHostId !== null` y se quedaba en 6 — así que una instalación en Oz era **invisible en toda la TUI** y el directorio compartido `~/.agents/skills` inflaba el conteo de hosts. La detección mezclaba «este host está instalado» con «estamos corriendo dentro de este host»: `~/.oz` se sondeaba aunque ningún host lo cree, y `~/.codex` presente bastaba para responder «codex» y, con eso, para que `aw mcp setup` sin `--host` escribiera en su `config.toml`. Ahora **el dominio es el único catálogo** y todas las superficies derivan de él con guardas que fallan si alguna diverge; la detección separa **cuatro estados observables** por host —config presente · runtime disponible · Workline instalado · capacidades— cada uno con su evidencia; y sobre ese catálogo entra **Kimi Code** como host oficial de punta a punta. Una corrida reproducible (`npm run smoke:hosts`) instala y desinstala cada host oficial en un HOME desechable y **escribe el veredicto**: ninguna superficie afirma una verificación que no corrió. 5/5 oficiales verdes en macOS. Bundle `w` **13.22.0**.

### Added

- **`npm run smoke:hosts`** — valida por nivel de soporte: sonda runtime y versión de los 8 hosts, y para los **oficiales** instala en un `HOME` de sandbox, verifica que en disco esté exactamente lo que el catálogo promete (bundle · superficie de comandos · hooks), desinstala y verifica que **las tres** desaparecieron. Escribe `src/domain/host-verification.ts`, la única fuente de un «verificado el X contra la versión Y» en todo el CLI. `-- --check` corre lo mismo sin escribir.
- **Kimi Code como host oficial** — dominio, detección, instalación, desinstalación, MCP, TUI y documentación. Skills en `~/.kimi-code/skills` (también lee `~/.agents/skills`), comandos como `/skill:w-<command>`, MCP en `~/.kimi-code/mcp.json` (shape `mcpServers`) y hooks en el `[[hooks]]` de su `config.toml`. Todo verificado contra el binario v0.29.2 y con probes en vivo.
- **Metadata de soporte en el catálogo** — `tier` (oficial | best-effort), superficie inestable para los pre-1.0, etiqueta y glifo. La TUI, el README y los describes la proyectan; un host que ninguna corrida cubrió se muestra `unverified`, nunca «verificado».
- **`aw self detect-hosts` con evidencia** — por host, los cuatro estados con el porqué de cada uno («'claude' en el PATH; reportó 2.1.220», «Warp no trae CLI propio — su presencia se juzga por su config dir»), las capacidades reales (nativa · degradada · no soportada) y una acción proporcional cuando queda configuración residual. Los destinos compartidos van en su propia sección.

### Changed

- **`--target all` significa lo mismo en install y uninstall**: todos los hosts. Antes install saltaba `agents` y uninstall lo incluía, así que `all` borraba más de lo que `all` había puesto. Los directorios compartidos se piden explícitos y la salida lo declara.
- **El doctor reporta todos los hosts del catálogo.** El filtro por `mcpHostId` dejaba fuera a Oz —el único que toma MCP por flag de arranque— y con él a cualquier instalación suya.
- **La TUI proyecta el catálogo**: `oz` visible, `agents` como destino compartido fuera del conteo, pill de nivel y versión verificada por fila, hooks **sondeados por host** en vez de un «claude only» global, réplicas y totales derivados. El mcp-tab pregunta en qué host instalar en lugar de escribir siempre en Claude.
- **`aw harness` responde solo por marcadores de entorno.** Se retiró el fallback de filesystem que contestaba «codex» con solo existir `~/.codex`: confundía «está instalado» con «estamos dentro», y por esa vía `aw mcp setup` sin `--host` escribía en un host que el usuario no eligió. `unknown` es ahora una respuesta legítima y documentada — varios hosts no exportan marcador alguno.
- **El escritor de MCP es un switch exhaustivo.** Un `McpHost` sin rama ya no compila.

### Fixed

- **`uninstall --with-hooks` borraba hooks del usuario.** Eliminaba el evento completo cuando su nombre coincidía con uno de los nuestros, contra lo que su propio comentario prometía: quien tuviera su propio `PreToolUse` lo perdía. La propiedad se decide ahora **por entrada** —idéntica a la del template, o con todos sus comandos invocando este CLI—; una entrada mixta se preserva porque partirla sería adivinar. Se recorren todos los eventos, así que un evento nuevo del template queda cubierto sin tocar código.
- **Los hooks de Kimi sobreviven a que el propio host reescriba su `config.toml`.** Kimi re-serializa ese archivo en operaciones normales suyas y **borra todos los comentarios** conservando el array `hooks`: identificar lo nuestro por marcador dejaba los hooks armados y sin forma de quitarlos, duplicándose en cada reinstalación. La propiedad es por dato, igual que en Claude.
- **`mcp setup` sin `--host` en un harness no identificable pide el destino** en vez de escribir en la configuración de todos.
- **`~/.oz` dejó de fabricarse.** Oz no tiene config dir propio —corre dentro del entorno de Warp— y se detecta por su binario.
- **`plugin-doctor` procesaba `hooks/hooks.json` dos veces** (Claude y Codex declaran el mismo directorio) y duplicaba cada hallazgo sobre ese archivo.
- **La degradación de capacidades se informa por la ruta que el usuario recorre.** El aviso de que un hook no es expresable en el host llegaba solo a `self install-hooks`, no a `self install`.

### Removed

- **La copia a mano de los eventos que instalamos** en el desinstalador, y los tres `new Set(["claude"])` que decidían por separado en qué hosts se arman hooks: ahora derivan del catálogo.

## [20.24.0] — 2026-07-29

**La doctrina deja de cargarse entera para dejarse cargar por señal, y el costo del contexto pasa de techo a presupuesto.** Cada comando ordenaba su cadena en prosa —`commands/<c>.md` → `## Run the loop` → `loops/<x>/LOOP.md` → `## Inherits` → `loops/CHASSIS.md`— y toda la doctrina entraba siempre, aplicara o no al caso: un `status` arrastraba el chasis, un plan sin base de datos cargaba las reglas de BD. El costo se fijaba a mano en una tabla de seis flows que solo sabía subir —unos diez párrafos de comentario documentaban cada alza—, dejaba sin presupuesto a los diez comandos sin loop y no medía ningún recorrido. Ahora un manifiesto declara, por comando, el núcleo que se carga siempre y los módulos con la señal que activa cada uno; `aw context-plan` devuelve el read-set ordenado con **rutas absolutas** y su recibo, y `aw context-budget` mide los tres tramos contra un baseline congelado del que se **derivan** todos los techos. La cadena no se profundiza: se **aplana**. Donde había dos saltos de lectura encadenados —y la evidencia dice que el segundo es el que se pierde en modelos débiles— queda una llamada y N archivos al mismo nivel. Discovery −34,5% · activación mediana −40,4% · ejecución mediana −25,3% · ningún recorrido creció. Bundle `w` **13.21.0**.

### Added

- **`aw context-plan --command <c> [--signal <s>]… [--capability <c>]…`** — devuelve qué leer para esta invocación, en orden, con rutas absolutas, y el **recibo** que lo prueba: recorrido, perfil, señales, capacidades declaradas, contenido cargado, saltos de referencia, bytes, disponibilidad de tokens y fallback usado. Local, sin telemetría. El recibo es **salida de comando**, no autodeclaración del agente — que es la única forma que la doctrina de *gate integrity* acepta como prueba. También publica las señales que acepta el comando con lo que significa cada una, así que ningún módulo depende de que 16 archivos listen sus propias señales.
- **`aw context-budget [--root <bundle>] [--baseline <archivo>]`** — mide discovery (las descripciones visibles antes de invocar), activación (el cuerpo de cada comando), ejecución (el read-set completo de un recorrido) y la carga garantizada **de los 16 comandos**. Determinista y offline: bytes de contenido, con el digest del árbol medido. Las dos proyecciones del plan 009 (humana en terminal, JSON en tubería, `--detail`).
- **`skills/w/context/MANIFEST.json`** — el grafo de núcleo, módulos, señales y capacidades. Vive **dentro del bundle** a propósito: un árbol instalado a mano o a medias queda descrito por el manifiesto que viaja con él, no por lo que la CLI cree, y por eso un recibo nunca puede describir un bundle distinto del que el agente lee.
- **`skills/w/modules/`** — 28 módulos condicionados por señal (`db`, `probe`, `ui`, `split`, `shape`, `input`, `resume`, `replan`, `simulation`, `compaction`, `sessions`, `adopted`, `web`, `reconnaissance`, `detection`, `scaffold`, `classification`, `plan-mode`, `authoring`). Cada regla sigue definida **una sola vez**: lo que se movió, se movió; nada se duplicó entre núcleo y módulo.
- **Baseline congelado** (`tests/fixtures/context-baseline.json`) y **corpus** de los seis recorridos representativos (`tests/fixtures/context-corpus.json`), con el read-set esperado y los casos del hard floor —sesión, checkpoint, idioma, structured-choice, write boundary, recuperación— que cada uno debe seguir cubriendo, en perfil compacto **y** en fallback.

### Changed

- **G1 pasa de techo por flow a presupuesto derivado.** La tabla escrita a mano desaparece: los techos absolutos se calculan como baseline × los ratios que declara el manifiesto, así que ninguna cifra que un gate compara fue tecleada. Cubre los **16 comandos**, no los 6 flows — los diez sin loop nunca habían tenido presupuesto. G4 conserva su tope por ítem y gana el **agregado de discovery** que no existía: por eso el discovery pudo crecer de 5 861 a 6 684 B durante el plan 009 sin que ninguna guarda se quejara.
- **Los 16 comandos y el chasis quedan partidos en núcleo + módulos.** El chasis baja de 25 254 a 17 469 B; `spec-refine-loop` de 29 661 a 21 387. Los mayores ahorros no fueron compresión sino **borrado de duplicación**: `plan-exec.md` resumía en 2 850 B el loop que su propio read-set ya entrega, y cada `## Resources` apuntaba a `docs/referencias/…`, una ruta que no existe en un bundle instalado.
- **El perfil se elige por capacidades declaradas, nunca por nombre de host** — condición que la spec 010 hereda, y que se rompería sola si estuviera cableada. Es determinista: misma entrada, mismo perfil.
- **Las guardas de doctrina leen la SUPERFICIE**, no el archivo: un documento **más los módulos a los que apunta**. Es más estricto que la lectura anterior — falla si se borra el contenido y también si se borra el puntero que lo alcanza.

### Fixed

- **Una capacidad ausente se informa, no se paga.** La primera versión ampliaba al perfil completo ante cualquier capacidad no declarada, lo que cancelaba el ahorro justo en los recorridos `db`, `web` y `compaction`. No cambia **qué** leer: cambia qué puede hacer el recorrido con lo leído, y el módulo afectado ya dice cómo degradar.
- **`## Plan mode` dejaba de ser alcanzable** al consolidarse en un módulo que ningún documento enrutaba. Lo resuelve el CLI publicando las señales de cada comando: cero bytes de bundle.
- **El procedimiento de reparación de `HISTORY.md`** (`history_error` → `aw history-update --code <NNN> --state closed`) había desaparecido del árbol mientras el chasis prometía que vivía en el módulo `sessions`. Restituido.
- **Ocho referencias `<archivo> § *Sección*`** apuntaban a archivos que ya no tenían esa sección tras el corte —dos de ellas en `SKILL.md`—. Corregidas, y con guarda nueva: toda remisión de esa forma debe resolver a una sección que ese archivo **todavía** tiene.

### Removed

- **`## Resources` en los 16 comandos** — punteros al loop que el read-set ya entrega y referencias de diseño a `docs/referencias/…`, ausentes de cualquier bundle instalado.
- **Los resúmenes del loop dentro de los comandos** (`## What the loop does`) — duplicaban el documento que la misma invocación carga.

## [20.23.0] — 2026-07-29

**Las diez superficies directas dejan de re-decidir lo que el CLI ya sabe.** Hasta ahora `status` devolvía JSON y la skill lo volvía a interpretar; `resume` asociaba una sesión a su plan **por slug** porque no había otra cosa; y `persist`, `fix-git` y los cuatro `export-*` mezclaban primitivas del CLI con clasificación, numeración, autorización y escritura hechas por la IA — 34,9 KB de manuales cargados en el camino normal solo para los exports. El problema no era el reparto de trabajo sino que **la misma decisión vivía en dos lugares** y se separaban. Ahora hay un único resultado canónico con dos proyecciones —humana en terminal, JSON en pipe, `--detail` opt-in—; un índice documental compartido del que `status` y `resume` derivan lo mismo; y un handshake acotado `prepare → validate → apply` para los recorridos híbridos, donde la IA aporta **una** etapa semántica y el CLI conserva inventario, relación documental, numeración, validación, autorización y escritura. La relación spec→plan pasa a exigir **evidencia explícita** (`Derived from` → path en `## Origin` → `Spec NNN`); sin ella el plan queda visible como procedencia no demostrada, en vez de atribuido al documento que más se le parece. Bundle `w` **13.20.0**.

### Added

- **`aw resume`** — el comando de usuario que faltaba, sobre el índice compartido. Devuelve objetivo, progreso o checkpoint, próximo pendiente o bloqueo, y **el comando exacto** que continúa — que presenta, nunca ejecuta. Sin target ordena spec sin refinar → spec `ready-for-plan` sin plan → plan incompleto → checkpoint no asociado, y dentro de planes uno empezado gana a uno intacto. Un empate devuelve candidatos y **no se rompe por fecha ni antigüedad**. `resume-summary` (hook PostCompact) y `session-resume` (carga de una sesión) siguen intactos: tres nombres, tres audiencias, declaradas en su `describe`.
- **`aw persist`, `aw fix-git` y los cuatro `aw export-*`** como comandos completos, con las tres etapas del handshake. `persist` adopta trabajo de la conversación en `docs/research|specs|plans`; `fix-git` resuelve conflictos de merge inequívocos; los exports publican dossieres validados en su única carpeta.
- **Resolución de salida en el runtime** (`src/cli/output-mode.ts`): `--format human|json`, `--json` y `--detail`. Sin override, un TTY recibe humano y un **pipe conserva el JSON actual** — que es lo que hace que ningún wrapper, hook ni script existente cambie. `QtcCommand` gana un `renderHuman` **opcional**: los ~35 comandos que no optan se comportan exactamente igual que antes, en terminal y en pipe.
- **`workline-index-service` + `parsers/spec-relation`** — una sola lectura de specs, planes, sesiones y checkpoints, con la relación spec→plan y el pipeline pendiente derivados ahí. `StatusOutput` gana `pipeline[]`, `counts.pending` y, por plan, `spec` (`resolved` | `unknown` | `ambiguous`). **Todo aditivo**: ningún campo se retira ni se renombra.
- **`semantic-operation/{protocol,publish}`** — el contrato versionado CLI↔IA: `input_digest` que sella el estado visto, allowlist de destinos comparada **por segmentos**, límites de tamaño y cantidad, `approval_digest` sobre los bytes exactos mostrados, recomprobación de stale dentro del lock y publicación multiartefacto todo-o-nada.
- **`ports/git`** gana `conflictStages`, `stagePath` y `commit` — las operaciones reales del recorrido, no una superficie git genérica. Sin `merge`, sin `push`, sin `--no-verify`, sin `--amend`.

### Changed

- **`status` humano muestra solo trabajo pendiente**: specs `draft`/`refining`, specs `ready-for-plan` sin plan demostrado y planes no `done`. El historial terminado, las sesiones y los descartados siguen en el modelo y vuelven con `--detail`. El filtrado es de la proyección; **el dominio no cambia**.
- **La asociación por slug se retira.** `parseSpecRelation` lee, en orden, `Derived from` en el preámbulo, un path `docs/specs/...` dentro de `## Origin`, o un `Spec NNN` inequívoco ahí mismo — acotado a esa sección, porque los planes nombran specs hermanas en `## Dependencies` y eso no es procedencia. Evidencia ausente o múltiple produce `unknown` / `ambiguous`, nunca una conjetura.
- **`resume` lee sin escribir.** Cuando el target es una sesión resuelve con **`bind: false`**: consulta la asociación conversación→sesión y jamás la graba. `sessionReadRequest` (que sí la graba) sigue siendo el camino de las demás lecturas; la divergencia es deliberada y está fijada por prueba.
- **Los wrappers adelgazan y dejan de cargar los manuales.** `status` 6 976 → 2 636 B · `resume` 8 458 → 4 210 B · `persist` 6 869 → 5 764 B; los cuatro `export-*` ya **no leen su `EXPORT.md`** en el camino normal (34,9 KB), que pasa a ser referencia de autoría. Las diez superficies suman 36 097 B frente a los 50 334 B que costaba solo la doctrina que reemplazan.
- **`workspace-init` y `persist` pierden `Write`/`Edit` de `allowed-tools`**: el CLI escribe, el wrapper relata. `fix-git` pierde `Edit` por lo mismo.
- **El rol `git` conserva el razonamiento y suelta la mecánica**: analizar la intención de cada lado sigue siendo suyo; leer las tres versiones, editar, stagear y commitear pasó al CLI.
- **Confirmaciones proporcionales al riesgo.** `persist` y `export-*` exigen el approval digest que devolvió `validate`; `export-manuals` exige además `--overwrite` para tocar `INDEX.md`, el único archivo sobrescribible de las cuatro categorías. `fix-git apply` se autoriza con la invocación — pero solo si el set es inequívoco **y vigente** —, y cerrar el merge es una acción aparte con `--confirm`.
- **Guards**: ocho guardas de doctrina **reubicadas**, no retiradas — fijaban que `status.md`/`resume.md` hablaran el vocabulario del contrato de fases, y ese lector es ahora el CLI; apuntan a `workline-index-service` y `resume-service`, y en el skill fijan que **delegue**. Dos quedaron más estrictas: el bloqueo fija la marca literal `> Estado: bloqueada` y el read-only fija `bind: false` en código en vez de una frase. Nueva matriz transversal C1–C18 (44 casos) sobre las diez superficies.

### Fixed

- **`--json` y `--detail` habrían tragado el siguiente positional.** `BOOLEAN_FLAGS` en `parser.ts` es un inventario manual y un booleano ausente consume el token siguiente; ambos quedan registrados, con `aw <cmd> --json <positional>` fijado como caso de regresión.
- **`workspace-init` era el único de los diez comandos cuyo `describe` no declaraba su `Usage:`.** Lo detectó la matriz, no una relectura.

## [20.22.0] — 2026-07-27

**El plan gana un tercer eje, y la forma de una spec deja de perderse entre iteraciones.** La ronda anterior separó «implementado» de «validado»; esta separa «validado» de «cerrado» y arregla lo que quedaba mezclado. Un plan con las cinco fases en `validada` se reportaba terminado aunque la **validación final** —un paso propio, el que demuestra la solución completa— no hubiera corrido nunca; y un plan que declaraba `done` con tareas abiertas se leía como cerrado sin que nada señalara la contradicción. Ahora el estado del plan es un eje **derivado** de la declaración *y* de los dos contadores: `open` · `done` · `inconsistent`, con `final_validation_pending` para el caso incómodo. En SPEC, el `change-shape gate` decidía dividir o reemplazar una spec y empujaba la oferta a `pending_human`, la colección que el loop **vacía en cada iteración** y que ni siquiera se construye cuando no queda ninguna brecha bloqueante: la decisión estructural se borraba sola. Ahora se pregunta, se resuelve y se registra en `CHECKPOINT` **antes** del loop de brechas, en su propio paso. Y el ocultamiento de ejemplos —que solo conocía `parsePhases`— pasa a ser un scanner compartido: una marca heredada citada dentro de un fence ya no promueve una spec. Bundle `w` **13.19.0**.

### Added

- **`plan_state` — el cierre integral como tercer eje de `aw status`.** `StatusPlan` gana `plan_state` (`open` | `done` | `inconsistent`), `final_validation_pending`, `phases_blocked` y `blocked_phases[]`. **Aditivo por diseño**: `progress_pct`, `tasks_*` y `phases_*` conservan su semántica y su cálculo, así que ningún consumidor existente cambia. La derivación no infiere nada de un solo lado — un `done` declarado solo cuenta si los contadores lo respaldan, y ningún contador cierra un plan por su cuenta.
- **Motivo de bloqueo hasta la superficie.** `parsePhases` lee la línea `> Bloqueo:` de cada bloque (`blocker`, `null` si no la declara) y cuenta las fases `bloqueada`. `/w:status` renderiza número, nombre y motivo — `• F3 — Persistencia real — bloqueada: falta aplicar la migración`— en vez de un estado sin acción asociada. La doctrina exige el motivo en toda escritura nueva; el parser tolera el bloque heredado que no lo trae.
- **`parsers/plan-status.ts`** — el estado superior se parsea aparte del de las fases, y **la posición es el discriminador**: el de nivel plan vive en el preámbulo bajo el título, el de fase dentro de su `### Fn`. Una sola regla para ambos habría dejado que una primera fase validada cerrara el plan.
- **`scanMarkdown()` en `application/markdown.ts`** — una pasada, una regla: qué líneas están dentro de un fence (backticks y virgulillas, cierre CommonMark) y qué headings son estructura real. Lo comparten `parseMdSection` y `parsePhases`; el frontmatter sigue siendo contrato de inicio de documento.

### Fixed

- **La resolución de forma ya no viaja en `pending_human` (P0).** `spec-refine-loop` empujaba la oferta de `split`/`replace` a la misma lista que las preguntas de brechas: el `batch` la vacía en cada vuelta (`pending_human = []`) y el `break` por cero brechas bloqueantes sale antes de construirla. Una spec que debía dividirse podía terminar refinada entera sin que nadie viera la pregunta. Ahora el gate resuelve en su propio `structured_choice` entre la línea base y el loop, escribe la decisión en `CHECKPOINT` **antes** de actuar, y un resume vuelve con la forma ya decidida.
- **Un ejemplo Markdown ya no promueve una spec.** `parseMdSection` delimita secciones con el scanner: un `## Refinement decisions` o `## Q&A traceability` citado dentro de un fence es documentación *sobre* la marca, no la marca. Alcanza también al conteo de `Open questions` y a `## Deferred` / `## Excluded`.
- **«Todo reemplazo crea archivos» era falso.** `Reformular esta spec` **no crea ningún archivo** — edita el mismo, mismo número, misma ruta; solo `Crear una nueva spec` y un `split` aceptado escriben documentos nuevos. Corregido en el `## Writes` del loop, en `spec-refine.md` y en el índice de loops, que ahora declara las escrituras múltiples posibles por loop.
- **`/w:resume` faltaba en el inventario transversal del README** raíz, donde sí figuraban los otros cuatro comandos sin flujo.

### Changed

- **El cierre del plan se escribe con el valor a solas.** `plan-exec` marca `> Estado: done` y mueve fecha y sesión a su propia línea `> Cierre: YYYY-MM-DD · sesión NNN` —misma razón por la que el motivo de un bloqueo no cabalga sobre el estado de la fase—. Durante la ejecución la línea se mantiene en `open`, y los planes nuevos nacen con ella. La forma heredada (`> Estado: done — fecha · sesión`) se **sigue leyendo**; la primera escritura legítima la normaliza.
- **`/w:resume` enruta por `plan_state`.** `done` es el único estado que no se reanuda. Un plan `open` con `final_validation_pending` reentra **en la validación final**, no en una fase; un plan `inconsistent` reentra a **reparar el estado**, y la propuesta lo dice en vez de fingir que queda trabajo por implementar.
- **La plantilla de fase separa obligatorio de condicional.** Dos bloques en vez de uno mezclado: siempre `Resultado` · `Trabajo` · `Validación de fase` · `Condición de salida`; condicionales `Estado inicial`, `Recorrido afectado`, `Dependencias`, `Límite de simulación` y `Diferido`. **Ninguno se escribe vacío**: un `Límite de simulación: no aplica` invita a inventar un stub para justificar el encabezado. `plan-exec` lo confirma en su entry gate — la ausencia del bloque no es brecha cuando nada introduce comportamiento temporal.
- **Terminología única** en doctrina, runtime y superficies: *tarea completada* · *fase validada* · *plan cerrado* · *fase bloqueada*, y **validación final** como término canónico del cierre (el campo se llama `final_validation_pending`).
- **Guards**: nuevo grupo **G18** (los tres ejes · forma antes que brechas, con la comprobación de orden sobre la propia secuencia · bloques condicionales · `/w:resume` en los inventarios) y G14 reapuntado al contrato de cierre en dos líneas. Nuevas pruebas de comportamiento: scanner Markdown, `parsePlanStatus`, los once escenarios de estado del plan, el bloqueo con y sin motivo, y la marca heredada dentro de un fence.
- **G1 byte-budgets — suben cuatro flujos, y `quick`/`spec-new` no se mueven**: spec-refine 57 700 → 61 300 (medida 60 461) · plan-new 52 500 → 54 400 (medida 53 535) · plan-refine 73 200 → 75 300 (medida 74 476) · plan-exec 62 200 → 64 200 (medida 63 351). El chasis y `CODE-POLICIES` quedan intactos otra vez: no se le cobra nada a los flujos que no ganan nada.

## [20.21.0] — 2026-07-26

**El workflow deja de inferir un estado a partir de otro.** Las tres rondas anteriores (reconocimiento en `spec-new`, `ready-for-plan` en `spec-refine`, fases funcionales en PLAN) dejaron siete desajustes con una sola raíz: en cada uno, una señal *parecida* se aceptaba como prueba de otra. Una fase podía cerrarse como `> Estado: validada — SQL pendiente de aplicar` —el parser conservaba el prefijo, `phases_validated` subía y el plan llegaba a `done` con la verificación sin ejecutar—, así que la ronda que existía para separar «implementado» de «validado» traía su propia excepción con sufijo. Una spec sin frontmatter con `## Decisions` —sección del esquema **nuevo**— se reportaba `ready-for-plan`, y `/w:resume` la mandaba a PLAN sin que el gate hubiera corrido nunca. `parsePhases` contaba cualquier `### Fn` del documento, así que un ejemplo citado en `## Solution` inflaba el total. Varios gates exigían identificar y retirar una simulación aunque el cambio no tuviera comportamiento temporal, empujando al agente a inventar un stub para satisfacer la plantilla. Y `plan-refine-loop` afirmaba que el plan «never mutates by execution» mientras `plan-exec` marcaba casillas y estados en él. Ahora: la línea de estado lleva **un valor exacto y nada más**, el motivo vive en su propia línea `> Bloqueo:`, y una prueba que no se pudo ejecutar deja la fase `bloqueada` y el plan abierto. Ronda de corrección: no cambia ninguna decisión de diseño, alinea doctrina, runtime y pruebas con las que ya estaban tomadas. Bundle `w` **13.18.0**.

### Fixed

- **Una verificación diferida ya no vale como validación (P0-A).** `parsePhases` acepta el vocabulario solo como **valor exacto** tras plegar mayúsculas, tildes y espacios: `validada — SQL pendiente de aplicar` degrada a `pendiente` igual que cualquier otro valor irreconocible. Desaparece la regla de prefijo con anotación que la ronda anterior introdujo por simetría con la línea de nivel documento — la simetría era real, pero la consecuencia (contar como demostrada una fase cuya prueba nadie corrió) no. En doctrina, `plan-exec-loop` reescribe estados intermedios, migración no aplicada, cierre de fase, secuencia y convergencia: la fase **permanece `bloqueada`**, sus tareas terminadas conservan sus casillas, y `Marcar plan done` solo se ofrece con todas las fases `validada` y la validación final pasada. `plan-new-loop` exige validación **ejecutada y aprobada** (antes admitía «or was explicitly deferred») y declara que la línea de estado no lleva comentarios. Se cerró además un resquicio no listado en el diseño: `Marking order` permitía leer que diferir un bloqueo validaba la fase — ahora «a blocker is never deferred into `validada`».
- **La madurez de una spec no se infiere de una sección (P0-B).** `LEGACY_READY_MARKS` queda en las dos marcas históricas reales (`Refinement decisions`, `Q&A traceability`); `## Decisions` sale de la lista. El parser de frontmatter distingue **ausente · presente · malformado**, y la compatibilidad heredada corre **solo** cuando no hay frontmatter: un bloque presente con valor vacío, desconocido o sin cerrar degrada a `draft` y nunca cae hacia una marca heredada. Sin cuarto estado `invalid` — degradar es el cambio mínimo compatible. `refined` sigue siendo el espejo exacto de `status === "ready-for-plan"` y `progress_pct` no cambia de semántica.
- **Un plan anterior al contrato de fases ya no se reporta como «implementado, no validado» (P0-C).** `parsePhases` gana el discriminador a nivel plan que `/w:status` y `/w:resume` ya prometían: un plan cuyos bloques `### Fn` no declaran **ninguna** línea `> Estado:` es anterior al contrato y reporta `phases_total: 0` — se mide solo por casillas, exactamente igual que antes de la serie. Sin él, todo plan legacy terminado (casillas al 100 %, sin marcas de fase) reportaba `N` fases con `0` validadas, caía en la fila «work implemented, not validated» del dashboard y `/w:resume` lo enrutaba a `/w:plan-exec`; la vía de escape documentada (`phases_total: 0`) solo alcanzaba a los planes de la era `## Phases`. Una línea ausente en un plan que sí declara estados sigue leyendo `pendiente` y nada se rellena hacia atrás; los planes nuevos nacen con su `> Estado: pendiente` estampado por la plantilla, así que nunca degradan a legacy.
- **Fases fantasma (P1-A).** `parsePhases` entra en la sección de nivel 2 `Tasks`, reconoce `### Fn` solo dentro y sale en el siguiente heading de nivel 2. Un `### F9` citado en `## Solution`, uno anterior o posterior a `## Tasks` y un ejemplo fenced dejan de contar; un documento sin `## Tasks` devuelve cero fases y los planes heredados con tabla `## Phases` siguen midiéndose por casillas. Tolera las anotaciones de plantilla del heading (`## Tasks (core)`, `## Tasks:`).
- **Los fences se emparejan en vez de alternarse (P1-D).** El ocultamiento de ejemplos trataba cualquier marcador `` ``` `` o `~~~` como apertura/cierre alterno: un ejemplo envuelto en cuatro backticks con un bloque `` ``` `` dentro —o un `~~~` citado dentro de un fence— reabría la visibilidad y filtraba un `### Fn` de ejemplo con su `> Estado: validada` como fase real, sobrecontando `phases_validated` en la única dirección que el parser prohíbe. Ahora un fence solo se cierra con su propio marcador (mismo carácter, longitud ≥ la de apertura, el marcador a solas), como manda CommonMark. Se añaden además los tests que dos mutantes del parser sobrevivían: el cierre de bloque por heading hermano y la primera línea `> Estado:` como única voz del bloque.
- **La contradicción sobre quién muta el plan (P2-A).** «The plan never mutates by execution» se sustituye por la frontera explícita: **`Execution updates progress; refinement changes structure.`** `plan-exec` actualiza casillas, la línea `> Estado:` con su `> Bloqueo:`, los diferimientos declarados y la línea final de estado; contratos, forma y orden de las fases, componentes, evidencia y fronteras de simulación son de `plan-refine`; el comportamiento funcional, de `spec-refine`.

### Added

- **Rama `replace` propia en el change-shape gate (P1-B).** El gate produce **`same` | `split` | `replace`** y solo los dos últimos preguntan. `split` conserva sus opciones; `replace` estrena las suyas — `Crear una nueva spec` | `Reformular esta spec` — porque cuando lo que cambió es el propósito, preguntar por cardinalidad no representa la decisión. Crear una nueva **preserva** la actual (su propósito nunca se reescribe en silencio), acuña con `aw next-number docs/specs`, nace `status: draft`, registra en `## Origin` la spec de origen, el propósito reemplazado y la decisión del usuario, y cierra la corrida reportando `/w:spec-refine <ruta-nueva>`. Reformular conserva número y ruta y **vuelve a pasar el gate completo** antes de cualquier estampado. Ninguna de las dos añade `superseded` ni archiva la spec reemplazada: un cierre histórico necesita contrato de runtime propio.
- **Línea `> Bloqueo:` como quinta escritura permitida** en el plan-doc. La *Plan-doc residue rule* pasa de cuatro a cinco cosas — el motivo de un bloqueo tiene dónde vivir sin contaminar el estado de máquina, y sigue registrándose además en `CHECKPOINT`, `## Open questions` y `BACKLOG`.

### Changed

- **La simulación es condicional en todo el bundle (P1-C).** Se propaga la redacción que `CODE-POLICIES.md` ya usaba («only when the change carries one») al entry gate y al `CHECKPOINT` por fase de `plan-exec`, al coherence gate y la granularidad de `plan-new`, al `## Simulation lifecycle`, el executability gate y el mapa de recorrido de `plan-refine`, y a `SKILL.md`, `CHECKPOINT.md` y los dos comandos. Un cambio de configuración, una corrección local o una migración directa dejan de necesitar un stub inventado para pasar el gate. **Condicional no es opcional**: donde hay comportamiento temporal, el retiro sigue siendo obligatorio y una simulación seleccionable en producción sigue siendo hallazgo bloqueante.
- **Superficies transversales al día**: `/w:status` nombra el caso `bloqueada` (casillas al 100 % con verificación pendiente: el trabajo en `▸ HECHO`, la fase en `▸ FALTA` con lo que espera) y declara el frontmatter como fuente principal de madurez; `/w:resume` enruta una fase bloqueada a `/w:plan-exec`, que reentra **por ella**, y no avanza a PLAN ante un `status` ausente o ilegible. `CHECKPOINT` deja explícito que un conjunto completo de casillas marcadas nunca promueve una fase a `## Completed`.
- **Guards reequilibrados (P2-B)**, sin número máximo ni poda por cantidad. Se añaden los pins de las reglas corregidas (G14 residuo de cinco escrituras · G16 las tres formas del gate, la oferta propia de `replace`, el draft con su origen y el veto a `superseded` · G17 valor desnudo del estado, bloqueo real, frontera de mutación, más el pin negativo de que `SQL pendiente de aplicar` no vuelve a aparecer en ningún `.md` del bundle) y la regla de simulación condicional pasa de estar repetida en ocho documentos a **una sola prueba de consistencia** que los lee todos. Nueva verificación código↔doctrina: `LEGACY_READY_MARKS` se exporta y se contrasta contra las marcas que la doctrina nombra — exactamente la deriva que causó P0-B. Las pruebas de runtime se reescriben como escenarios completos (documento representativo → parser o servicio → resultado relevante).
- **G1 byte-budgets — cuatro flujos suben, y ninguno compra una función nueva**: spec-refine 56 000 → 57 700 (medida 56 893) · plan-new 52 100 → 52 500 (medida 51 680) · plan-refine 71 900 → 73 200 (medida 72 332) · plan-exec 60 900 → 62 200 (medida 61 396). El gasto paga decir con precisión lo que las tres rondas anteriores dijeron con holgura; la regla del bloqueo aparece cinco veces en `plan-exec-loop` porque la ejecución lee esos cinco sitios en cinco momentos distintos. `quick` y `spec-new` no se mueven: el chasis no creció y `CODE-POLICIES` fue la referencia de la ronda, no un costo.

**Decisiones cerradas de la ronda**: la anotación tras separador se **revierte por completo** en vez de restringirse a valores concretos — un estado que admite calificadores es un estado que admite excusas, y el parser no puede distinguir «pendiente de aplicar» de «pendiente de revisar» · el motivo del bloqueo va en una **línea propia** dentro del bloque, no en `CHECKPOINT` a solas, porque quien lee el plan tiene que ver por qué se detuvo sin abrir la sesión · un frontmatter inválido degrada a **`draft`** en vez de estrenar un cuarto estado `invalid`, que habría exigido vocabulario nuevo en tres superficies para el mismo resultado práctico · las fases se cuentan **solo bajo `## Tasks`** con tolerancia a las anotaciones del heading, en vez de exigir el literal exacto · `replace` **no** introduce `superseded` ni archivado: quedan explícitamente fuera de alcance porque necesitan contrato de runtime propio · la simulación condicional se redacta reutilizando la fórmula que ya existía en `CODE-POLICIES` en vez de acuñar una nueva · y los guards de la simulación se **consolidan en uno** en lugar de sumar ocho `toContain` por documento, que era justo el patrón que el documento de corrección pedía evitar. Como en las rondas anteriores, los guards solo evitan deriva textual; la conducta viva se verificó punta a punta contra `aw status` con los dos documentos de la matriz de aceptación (un plan al 100 % de casillas con una fase bloqueada por SQL reporta `1/2` fases validadas y sigue abierto; una spec con `## Decisions` sin frontmatter queda `draft`).

## [20.20.0] — 2026-07-26

**El plan deja de ser una lista de tareas técnicas y pasa a ser una secuencia de estados funcionales verificables.** Hasta ahora la doctrina exigía fases pequeñas y tareas de complejidad atómica (`complexity > S` / `> XS` como señal de brecha), así que un plan podía leerse como «crear un DTO · agregar un método · modificar un mapper» sin decir en ningún momento qué sabía hacer el sistema al terminar la fase, qué parte seguía simulada ni qué evidencia demostraba el avance. A eso se sumaban tres agujeros: `plan-exec` podía rediseñar contratos, orden de fases o límites de simulación dentro de una tarea y dejar el plan mintiendo sobre la ejecución; el progreso se medía **solo** por casillas, así que un plan al 100% con la validación pendiente se veía terminado; y nada frenaba la proliferación de pruebas estructurales (una por método, cadenas de mocks, el mismo camino feliz reafirmado en cada capa). Ahora una fase es un **estado verificable del sistema** con su resultado, su evidencia principal, su condición de salida y su marca de estado; la simulación temporal tiene **ciclo de vida declarado** (dónde nace, cómo se desplaza, qué fase la retira); `plan-refine` converge en un **plan ejecutable** y `plan-exec` **verifica ese mismo gate al entrar**, normaliza solo lo menor con consentimiento y devuelve a `plan-refine` (estructural) o `spec-refine` (funcional) en vez de improvisar. Segunda ronda de la serie que toca **runtime**: `aw status` medía una sola señal. Bundle `w` **13.17.0**.

### Added

- **`## Phase contract (canonical)`** en `plan-new-loop`: la definición **única** de qué es un bloque `### Fn` — un estado verificable, nunca una lista de capas, archivos o clases. Secciones siempre (`Resultado` · `Trabajo` · `Validación de fase` · `Condición de salida`) y condicionales (`Estado inicial` · `Recorrido afectado` · `Límite de simulación` · `Diferido` · `Dependencias`). `plan-refine-loop` y `plan-exec-loop` lo **referencian y nunca lo redefinen** — el mismo patrón que el split gate multi-plan.
- **Estado de fase como estado de máquina**: una línea `> Estado: <valor>` propia bajo cada `### Fn`, vocabulario `pendiente` | `en ejecución` | `bloqueada` | `validada`, actualizada in place. La posición la distingue de la línea de nivel documento (`> Estado: done — …`). Una fase llega a `validada` solo con su prueba principal en verde, su condición de salida cierta, el review gate pasado y los diferimientos declarados — **nunca** por tener todas las casillas marcadas.
- **`## Incremental strategy (reference, never a template)`** en `plan-new-loop`: la secuencia de referencia (cascarón del consumidor → integración mínima → esqueleto vertical → implementación real desde la fuente → endurecimiento → acabado) declarada explícitamente como forma adaptable: backend-only, CLI, batch, librería y cambios solo de base de datos tienen su propio recorrido, y un cambio pequeño puede ser una sola fase. La arquitectura real gobierna; no se inventan capas para llenar una plantilla.
- **Cinco secciones nuevas en `plan-refine-loop`**: `## Functional journey map` (contrato observable · recorrido técnico · estrategia incremental · evidencia, con investigación **acotada** a lo que ordena las fases), `## Simulation lifecycle` (propósito, ubicación, contrato representado, fase de aparición, fase de retirada, mecanismo anti-producción, prueba mínima; regla de desplazamiento `antes → después` y gate de eliminación), `## Evidence by behavior` (tres niveles elegidos, nunca descendidos automáticamente, + gate de necesidad), `## Executability gate` (contrato · recorrido · fases · simulación · evidencia · reanudación) y `## Replanning executed work` (las fases `validada` se conservan y su resultado es el nuevo estado inicial; una fase cerrada que el nuevo diseño invalida recibe una **corrección compensatoria** como fase nueva, nunca una edición silenciosa).
- **`## Entry gate — executability` y `## Deviation gate`** en `plan-exec-loop`. El gate de entrada verifica la forma de la que depende la ejecución y se bifurca: brecha menor → **normalización consentida** (`Normalizar y ejecutar` | `Ir a plan-refine`), que no añade alcance ni mueve fronteras; brecha estructural → `CHECKPOINT` + handoff. El gate de desviación separa **decisión local** (continúa; a `DECISION` solo si no es obvia) de **desviación estructural** (para y vuelve a `plan-refine`) y **cambio funcional** (para y vuelve a `spec-refine`), con su matriz. Vive **solo** en este loop: el chasis no lo carga, así que los otros cuatro flujos no pagan una regla de PLAN.
- **Dos lentes suelo nuevas en el closing review gate** (`CODE-POLICIES.md`, junto a minimalidad): **`Test-value lens`** — toda prueba añadida demuestra comportamiento observable, protege una regla, verifica un contrato, ejercita una integración real o evita una regresión conocida; lo que solo refleja estructura se marca **`overtest`** (prueba por clase o método, cadenas de mocks, el mismo camino feliz en cada capa, getters/mappers triviales, casos por cobertura). Acotada por *Gate integrity*: poda redundancia, nunca una verificación que protege comportamiento, una frontera de confianza, seguridad o accesibilidad. Y **`Temporary simulation check`** — stubs y fakes explícitos y nombrados como tales, en la frontera que el plan declara, imposibles de seleccionar desde una configuración de producción.
- **Runtime `parsePhases`** (`src/application/parsers/phases.ts`, espejo de `parsers/tasks.ts`): bloques `### F<n>` hasta el siguiente heading de nivel ≤3, primera línea `> Estado:` de cada bloque, normalización insensible a mayúsculas y tildes. Degradación siempre segura — valor ausente o irreconocible es `pendiente`, nunca un `validada` falso. Ignora fences (un ejemplo citado no infla el conteo) y la línea de nivel documento, que no vive en ningún bloque. Una anotación tras separador (`validada — SQL pendiente de aplicar`) **califica** el estado en vez de anularlo; texto pegado sin separador es ruido.
- **Guard `G17 · functional phases (PLAN contract) pins`**: contrato canónico y sus secciones · estado de máquina y la regla `Never because all its checkboxes are ticked` · **vocabulario runtime↔doctrina** (`PHASE_STATES` importado y contrastado contra el contrato: la clase de deriva código↔doctrina que nadie ve hasta que el dashboard miente) · los otros dos loops referencian sin redefinir · granularidad semántica · la secuencia sigue siendo referencia · gate de salida de refine = gate de entrada de exec · gate de desviación con sus tres destinos · ciclo de simulación · evidencia y `overtest` · **pin negativo**: nada de esto migra al chasis. **Contrato `Phase contract`** (`skill-consistency.test.ts`): escritor (`plan-exec`) ↔ lectores (`status`, `resume`), las dos señales separadas, degradación heredada idéntica en las tres superficies, y el gate compartido entre refine y exec.

### Changed

- **Taxonomía de brechas semántica**: `Phase too large | complexity > S` y `Task not atomic | complexity > XS` desaparecen como señales. En su lugar: una fase que mezcla estados funcionales distintos o no puede validarse hasta el final, y una tarea cuyo nombre describe una operación de edición en vez de un propósito. Cuatro filas nuevas: recorrido sin mapear, microtareas estructurales, simulación sin ciclo de vida y fase sin evidencia. `XS–S` sobrevive como **orientación de riesgo y alcance**, nunca como mandato de partir una tarea semántica en operaciones mecánicas.
- **Coherence gate de `plan-new` por estado funcional**: cada fase deja un estado verificable con su condición de salida, el orden permite integración temprana, una fase se hace cargo de retirar la simulación, cada fase declara su evidencia principal y el plan es reanudable. La norma queda explícita: **el gate juzga estados funcionales, no tamaño**.
- **`Checkbox-only residue` → `Plan-doc residue`** en `plan-exec-loop`: la regla admite ahora **cuatro** escrituras — casillas, la línea `> Estado:` de la fase, diferimientos en `## Open questions` y la línea final de estado del plan. El nombre viejo había dejado de ser cierto. Se conserva intacta la prohibición de duplicar un bloque `### Fn`, y los resultados por fase, hallazgos y métricas siguen yendo a `DECISION`/`CHECKPOINT`.
- **Artefactos**: `CHECKPOINT` distingue **implementado de validado** (una fase entra en `Completed` solo cuando su marca es `validada`; el trabajo escrito y no probado se queda en `Pending / Next`) y registra el estado funcional alcanzado más el límite de simulación vigente — ese par, no la lista de archivos tocados, es lo que un resume necesita. `DECISION` declara que una desviación estructural **no** se salda con una entrada suya.
- **Runtime `aw status`**: `StatusPlan` gana `phases_total` y `phases_validated`. **Aditivo por diseño** — `progress_pct`, `tasks_total` y `tasks_done` conservan su semántica y su cálculo, así que ningún consumidor existente cambia y un plan heredado reporta exactamente el mismo porcentaje que antes, con `phases_total: 0`. Sin agregado global en `counts`: no tenía consumidor.
- **Superficies transversales**: `/w:status` muestra las dos señales y nombra el caso incómodo — un plan al 100% de casillas con `phases_validated: 0` es **trabajo implementado, no validado**; `/w:resume` lee el plan en ambos ejes y enruta a `/w:plan-exec` un plan con fases sin validar aunque no le queden casillas. `SKILL.md` y README raíz actualizados.
- **G1 byte-budgets — los tres flujos PLAN suben juntos**: plan-new 46 600 → 52 100 (medida 51 287) · plan-refine 58 000 → 71 900 (medida 71 075) · plan-exec 49 100 → 60 900 (medida 60 066) · quick 48 600 → 49 700 (medida 48 882, solo por las dos lentes de `CODE-POLICIES` que hereda sin pedirlas). `plan-refine` paga dos veces porque también carga `plan-new-loop`, y con 71 075 B se convierte por amplio margen en el flujo más pesado del bundle: ese es el precio consciente de definir el contrato **una vez** en lugar de en los dos plan-loops. `spec-new` y `spec-refine` no se mueven — el chasis **no** creció esta ronda, que es exactamente para lo que el gate de desviación se quedó en `plan-exec-loop`.

**Decisiones cerradas de la ronda** (las diez abiertas del diseño): el estado de fase se **persiste en el plan-doc** como marcador parseable más `CHECKPOINT` — dejarlo solo en la sesión habría mantenido el runtime intacto a cambio de un plan que no distingue implementado de validado, justo el problema que la ronda corrige · `aw status` **suma** fases validadas en vez de reemplazar el porcentaje, porque cambiar la semántica de `progress_pct` rompería a sus consumidores sin necesidad · `plan-exec` **puede normalizar** lo menor con consentimiento (un bloqueo duro por una condición de salida derivable sería burocracia) pero nunca lo estructural · el gate de desviación vive **solo en `plan-exec-loop`**: `quick` ya tiene su propia puerta de escalación y subirlo al chasis cobraría a los cinco flujos · la simulación se declara en **prosa normalizada** con nombres `Stub…`/`Fake…`, sin token doctrinal tipo `temporary-runtime`, que habría sido convención dependiente del stack · la sobreprueba es un **finding** del gate, coherente con la mecánica existente de corregir-o-justificar, no un rechazo automático · la evidencia principal vive **dentro** del bloque `### Fn` y `## Validations` queda para lo transversal · una fase con verificación operativa pendiente reutiliza el patrón de la migración no aplicada (`validada — SQL pendiente de aplicar` + diferimiento en `## Open questions`), en simetría con la línea de nivel documento · solo el estado de fase y sus contadores pasan a runtime; recorrido, simulación, gates y estrategia de pruebas se quedan como doctrina · y `plan-new` **entra en esta ronda** en vez de quedar para la siguiente, porque generar planes con el contrato viejo habría obligado a pasar por `plan-refine` cada vez, contradiciendo que sea auxiliar. Como en las rondas anteriores, los guards solo evitan deriva textual: la conducta viva (una fase que no se valida con las casillas marcadas, una desviación estructural que efectivamente para la ejecución, un plan heredado que degrada sin ruido) se valida por smoke tras reinstalar el bundle.

## [20.19.0] — 2026-07-26

**`spec-refine` deja de perseguir una spec sin incognitas y persigue una spec suficiente para planificar.** Hasta ahora el loop convergia cuando **no quedaban brechas**, con `Unexplored solution space` como fila universal de la taxonomia. Esa meta arrastraba a SPEC decisiones de arquitectura, libreria y division de tareas que `PLAN` puede resolver sin tocar el contrato, ofrecia ideacion aunque el resultado pedido ya estuviera claro, y convertia la spec en un plan prematuro. Ademas la madurez colgaba de prosa: la **presencia** de `## Refinement decisions` — una seccion que podia existir vacia, o existir con bloqueos funcionales abiertos, y que mezclaba contrato con expediente. Ahora la meta es **`READY FOR PLAN, NOT PERFECTLY CLOSED`**: cada brecha se **clasifica por destino** antes de elegir su resolver, se cierra lo que puede cambiar **que** se construye, y lo que solo cambia **como** viaja a `PLAN` declarado en `## Open questions`. La madurez pasa a **frontmatter `status`** (`draft` | `refining` | `ready-for-plan`) — estado de maquina, no prosa — y la traza de la spec pasa a `## Decisions`, solo decisiones materiales. Inspirado en [OpenSpec](https://openspec.dev/) en cuatro ideas (spec como contrato de comportamiento, trabajar desde el comportamiento actual, separar lo funcional del diseno tecnico, explorar solo ante incertidumbre real); **sin** adoptar specs canonicas, deltas formales ni ciclo de archivado. Primera ronda de esta serie que toca **runtime**: `aw status` implementaba la marca vieja. Bundle `w` **13.16.0**.

### Added

- **`## Convergence target`** en `spec-refine-loop`: la regla doctrinal `READY FOR PLAN, NOT PERFECTLY CLOSED` como bloque citado, con su corolario — cerrar *toda* brecha convierte la spec en un plan prematuro.
- **`## Current-behavior baseline` (brownfield first)**: establecer el comportamiento vigente sobre el que se apoya el cambio **antes** de describirlo (que pasa hoy, que actor lo inicia o recibe, que capacidades participan, que reglas y limites observables condicionan la solicitud, con su fuente). Con limite explicito: **para cuando la linea base alcanza para formular y aceptar el cambio funcional**, no cuando el sistema esta documentado. Greenfield la salta — y eso es justo lo que hace que `## Behavioral changes` se gane su lugar o no.
- **`## Change-shape gate`**: valida la **forma** de la spec despues de la linea base y **antes** de cerrar detalles, porque la investigacion puede revelar que el corte inicial estaba mal. Seis salidas (misma spec · split · spec nueva · refactor como consideracion para `PLAN` · refactor fuera del contrato · evidencia insuficiente → una sola spec). Reutiliza **el criterio de separacion de `spec-new`**, nunca uno propio. **Semantica in-place**: la original conserva numero y ruta reducida a su resultado remanente, los resultados extraidos se acunan con `aw next-number docs/specs` y **nacen `status: draft`** — no se elaboran en la corrida, a diferencia del gate multi-plan, donde `plan-exec` se rompe con un plan sin `## Tasks`; aqui un draft es entrada legitima de este mismo loop. Accion de cierre en esa rama: `Guardar specs`.
- **Eje de destino en la taxonomia de brechas**: cada fila declara **resolver + destino**, y aparecen cuatro filas nuevas que **nunca se cierran en SPEC** — arquitectura, implementacion, riesgo tecnico ejecutable (probe de `PLAN`, salvo que la respuesta cambie el contrato) y detalle no bloqueante. Con la definicion de bloqueante: una brecha retiene la convergencia solo si su respuesta puede cambiar el resultado, el alcance, una regla de negocio, un actor, un criterio de aceptacion o la decision de mantener o separar la spec.
- **Secciones opcionales condicionadas** en el esquema: `## Affected capabilities` (fronteras funcionales, **nunca** una lista de repos — esos van a `Context` como evidencia o ubicacion) y `## Behavioral changes` (comportamiento anadido / modificado / retirado / conservado), ambas solo cuando el cambio toca comportamiento que ya existe.
- **Guard `G16 · ready-for-plan (SPEC contract) pins`**: meta de convergencia verbatim · clasificacion por destino y "una pregunta de `PLAN` **nunca** hace fallar el gate" · **orden** linea base → change-shape → taxonomia (juzgar la forma despues de cerrar detalles seria re-litigar un contrato ya endurecido sobre el corte equivocado) · linea base acotada · ideacion con disparadores **y** no-disparadores · split in-place con hermanas `draft` · marca como estado de maquina, con tolerancia heredada y sin exencion del gate · `refining` se lee pero no se escribe · **pin negativo**: el gate no migra al chasis. **Contrato `SPEC readiness`** (`skill-consistency.test.ts`): productor (`spec-new` emite `draft`) ↔ promotor unico (`spec-refine` estampa al guardar) ↔ consumidor (`plan-new` lee la marca, tolera la heredada y **nunca bloquea**) ↔ escalacion quick ↔ superficies transversales ↔ asimetria declarada con `plan-refine`.

### Changed

- **Marca de madurez: de seccion narrativa a frontmatter.** `status: ready-for-plan` reemplaza a la **presencia** de `## Refinement decisions` como contrato SPEC→PLAN. **Compat**: una spec sin frontmatter que lleve `## Refinement decisions` (o la mas antigua `## Q&A traceability`, o ya `## Decisions`) sigue contando como lista — pero la marca heredada **no exime del gate** al re-refinar.
- **`## Refinement decisions` → `## Decisions` en la spec**, con cambio de semantica, no solo de nombre: solo las decisiones materiales con su porque. **Sin transcripcion** — la notacion `Q: <pregunta> → <respuesta> — <razon>` sale de la spec y se queda en la sesion (`CONCLUSIONS`). La seccion **conserva su nombre en `plan-refine`**, donde sigue siendo traza de auditoria sin gating y no tiene un `status` que la reemplace como marca de trabajo previo: la asimetria es deliberada y esta declarada y fijada por guard.
- **Ideacion condicional**: `Unexplored solution space` deja de ser brecha universal. Seis **disparadores** (el usuario conoce el problema pero no el resultado deseado · varias direcciones funcionales con consecuencias materialmente distintas · la spec adopto la primera alternativa prematuramente · una eleccion puede cambiar el alcance · las alternativas cambian experiencia, reglas o aceptacion · el usuario pide explorar) y cinco **no-disparadores** explicitos (existe mas de una solucion tecnica · falta elegir libreria · hay varias tecnologias · toda implementacion admite alternativas · la solicitud ya es funcionalmente clara). Las alternativas puramente tecnicas son de `PLAN`.
- **`analyze gate` → `ready-for-plan gate`**, con checklist propio y una regla nueva: lo que falla vuelve como brecha, pero **una pregunta con destino `PLAN` nunca hace fallar el gate** — se registra, no se cierra.
- **`plan-new` advierte, nunca bloquea**: modos 1/2 de *Input resolution* discriminan por `status`; `draft`/`refining` → soft-suggest. Las preguntas abiertas con destino `PLAN` son **entrada** de ese flujo, no motivo para devolver la spec.
- **Runtime `aw status`**: `StatusSpec` gana `status` (`draft` | `refining` | `ready-for-plan`) con precedencia frontmatter → marca heredada ⇒ `ready-for-plan` → `draft`; un valor desconocido cae a la marca heredada y un bloque sin cerrar no cuenta como frontmatter. `refined` **se conserva** como espejo booleano de `status === "ready-for-plan"` (contrato con `/w:status` y el routing de `/w:resume`); `counts.specs_refined` sin cambios. Parser de frontmatter minimo y local, sin dependencias nuevas.
- **Chasis parametrizado, y mas corto**: las dos lineas que nombraban `## Refinement decisions` como si fuera de todos los loops de refinamiento pasan a ser genericas — el registro de decisiones es "el que cada heredero nombra" y la marca de trabajo previo se enumera por heredero (spec-refine keya por frontmatter `status`; plan-refine por la seccion; plan-exec por los `- [x]`). Neto **25 392 → 25 272 B**, que es lo que permite que los otros cuatro flujos absorban sus ediciones dentro de la holgura existente.
- **Superficies transversales**: `/w:status` (tablero: *lista para plan* / *borrador*) y `/w:resume` (marcas de etapa y tabla de routing) dejan el vocabulario *refinada / sin refinar*. `spec-new` emite `status: draft` y suma un quinto punto al hard floor de `spec-refine` (converger no es cerrar todo). `SKILL.md` y README raiz actualizados.
- **G1 byte-budgets — `spec-refine` 46 200 → 56 000 (medida 55 192)**: la subida mas grande de un solo flujo hasta ahora, y conviene decirlo sin diluirlo. El LOOP pasa de **16 425 a 25 575 B** (+56 %) y la carga garantizada del flujo de 45 410 a 55 192 (+21,5 %). El plan de la ronda habia estimado +3,5 a +4,5 KB: la estimacion se quedo corta — el costo real es **+9,8 KB**, repartido entre **cinco** funciones doctrinales (meta de convergencia, linea base, change-shape gate con semantica de split, eje de destino, contrato `status`/`Decisions` con migracion), no entre las dos que se habian dimensionado. Se aplico una pasada de compresion sobre repeticion (26 833 → 25 575 B) antes de fijar el numero. Referencia para juzgar la proporcion: `plan-refine` ya carga **57 309 B**, asi que `spec-refine` queda **por debajo** del flujo mas pesado del bundle. Los otros cinco presupuestos no se mueven (medidas: quick 47 895 · spec-new 13 769 · plan-new 46 055 · plan-refine 57 309 · plan-exec 48 348).

**Decisiones cerradas de la ronda** (las ocho abiertas del diseno mas dos que apareceron al revisar el codigo real): `status` en **frontmatter YAML**, porque como seccion Markdown seria prosa fingiendo ser estado — el problema que la ronda corrige · **`refining` se reconoce pero no se escribe**: ningun escritor puede emitirlo sin romper el invariante "la spec solo se escribe en `Guardar`, con confirmacion", asi que queda en el vocabulario de lectura en vez de crear estado muerto · `Affected capabilities` y `Behavioral changes` **opcionales con condicion declarada** · el split se materializa **en el loop, in-place**, espejo de `plan-refine`, porque devolverlo a `spec-new` perderia el refinamiento hecho · `plan-new` **advierte, nunca bloquea** (bloquear contradiria que `plan-refine` sea auxiliar y que `plan-exec` corra cualquier plan) · las preguntas de `PLAN` se quedan en **`## Open questions` con destino**, sin seccion nueva (que costaria guard propio, parseo, y quedaria invisible para `countOpenQuestions`) · la migracion `Refinement decisions` → `Decisions` ocurre **solo al re-refinar**, y solo en la misma escritura que estampa `status`, para que la spec nunca quede sin marca · el gate vive **entero en el loop**; el chasis solo se despersonaliza · `## Decisions` **sin transcripcion `Q:`** · la **asimetria de nombres** con `plan-refine` es deliberada y esta fijada. Como en la ronda anterior, los guards solo evitan deriva textual: la conducta viva (converger con preguntas tecnicas abiertas, no converger con decisiones funcionales bloqueantes, ideacion que no se ofrece sola, spec heredada que pasa el gate al re-refinar) se valida por smoke tras reinstalar el bundle.

## [20.18.0] — 2026-07-26

**`spec-new` mira el terreno antes de decidir el corte: reconocimiento contextual acotado, previo al split gate.** Hasta ahora el comando decidía una-spec vs specs hermanas leyendo **solo el prompt**, bajo una regla dura `NO RESEARCH` que prohibía incluso abrir un manifiesto: el corte podía ser coherente con la redacción y equivocado para el sistema real — partes que forman un único recorrido funcional salían separadas, y capacidades con aceptación independiente salían juntas. Ahora el comando adopta lo ya establecido en la conversación, identifica las fuentes candidatas y da **una** pasada superficial (techo declarado **≤5 lecturas + ≤3 búsquedas**, con condiciones de parada por intención, no solo por conteo) para formar una **hipótesis de alcance interna**; recién entonces corre el split gate, cuyo criterio principal pasa a ser el **resultado funcional independiente** — repos distintos, front/back, microservicios o una migración habilitante son **evidencia secundaria**, nunca razón de división por sí solos. Sigue siendo atómico: una pasada, sin loop, sin sesión, sin subagentes, sin web, sin ejecutar nada y con **una sola interacción**. Solo doctrina + guards (cero código de runtime; `allowed-tools` intacto — `Bash`+`Read` ya bastaban); chasis, harness y `persist` intocados. Bundle `w` **13.15.0**.

### Added

- **Sección `## Bounded reconnaissance`** en `commands/spec-new.md`, **antes** del split gate: *scope* (dispara **solo con prompt crudo**) · orden de la pasada (adoptar → identificar fuentes → mirar superficie → parar) · **fuentes permitidas** como permiso, no obligación (`aw sources --no-git` o el bloque `WORKSPACE`; instrucciones principales y cabecera del `README` de cada fuente; manifiestos `package.json`/`pom.xml`/`build.gradle`/`requirements.txt`; listado de primer nivel; uno o dos puntos de entrada que el prompt nombra) · **presupuesto** con techo explícito, encuadrado como *cap, never a target* · **6 condiciones de parada** por intención · lista **Never** (cadenas de imports/llamadas, ejecutar algo, consultar BD, buscar en web, abrir fuentes sin motivo) · **hipótesis de alcance interna** (resultado funcional · fuentes probables · responsabilidad aparente · acoplamiento · aceptación independiente · forma recomendada · confianza) declarada *reasoning, not an artifact* — nunca persistida ni mostrada literal · **degradación segura** (sin workspace, fuentes inaccesibles o evidencia contradictoria → una sola spec + supuesto declarado + incertidumbre a `spec-refine`; nunca un corte especulativo).
- **Aterrizaje declarado de los hallazgos** en las *filling notes*: `Context` recibe los hechos que ubican la solicitud con **máximo una ruta por componente** como ancla (nunca un inventario técnico), `Assumptions` las inferencias que permiten avanzar y `Open questions` lo que exigiría recorrer la implementación, una decisión humana o una fuente no disponible. El código encontrado **no amplía `Scope`** y **no se convierte en requisito**: los acceptance criteria siguen derivando de la intención del usuario (el repo presta vocabulario, actores y límites; no inventa comportamiento ni impone una implementación como criterio).
- **Guard `G15 · bounded reconnaissance pins`** (`doctrine-guards.test.ts`): sección + contrato acotado + techo + condiciones de parada · **orden reconocimiento → split gate** (el pin del orden es el punto: mirar después de decidir sería teatro) · independencia funcional y evidencia secundaria · degradación a una sola spec · hipótesis interna (**pin negativo**: no nace una sección `## Scope hypothesis`) · sitios de aterrizaje de los hallazgos · **pin negativo** de que la pasada no migra al chasis. **Contrato `Reconnaissance contract`** (`skill-consistency.test.ts`, espejo del QUICK escalation contract): scope de prompt crudo + interacción única; las entradas de reutilización conservan `NO RESEARCH` y declaran el no-re-disparo; `spec-refine-loop` declara la frontera; la orientación raíz registra la pasada.

### Changed

- **Regla dura reencuadrada**: `Single-pass — NO RESEARCH` → **`Single-pass — BOUNDED RECONNAISSANCE, NO DEEP RESEARCH`**, con la lista `FORBIDDEN` explicitada (sub-agentes/workflows, sesiones de research, búsquedas web, seguir cadenas de implementación, ejecutar código/tests/apps, consultar bases de datos). `NO RESEARCH` **no desaparece**: sigue siendo el token estricto de las **entradas de reutilización** — escalación quick→SPEC y adopción `persist` llegan con el contexto ya establecido, así que el reconocimiento **no se re-dispara** (adoptar es transcripción, no investigación). Dos contratos explícitos en vez de uno ambiguo.
- **Split gate por independencia funcional**: divide **solo** cuando cada parte puede refinarse, aceptarse y planificarse por separado (propósito propio, criterios propios, entregable aunque la otra se descarte); señal nueva en el ≥2 (usuarios o valor que no dependen entre sí); borderline **o evidencia insuficiente** → una sola spec sin preguntar, con la hipótesis a `## Assumptions` y la duda a `## Open questions`.
- **Segunda content question acotada**: la interacción sigue siendo **una** structured-choice, pero puede llevar ≤2 content questions — la oferta de split y, solo si aplica, **una** ambigüedad funcional con dos lecturas incompatibles que cambiarían la cantidad de specs. Confirmar tecnologías observables, cerrar detalles de implementación o subir la confianza de media a alta **no** se preguntan.
- **Frontera declarada** en `loops/spec-refine-loop/LOOP.md` (§ *Reads*): el borrador llega de una pasada de superficie — **hipótesis, no hechos verificados**; recorrer dependencias, comprobarlas y cerrar lo aparcado en `## Open questions` es trabajo de ese loop. La línea de la puerta de ideación deja de decir «no research» y dice «bounded reconnaissance at most, no web».
- **G1 byte-budgets**: **alta de `spec-new`** en la tabla (14 300; carga medida **13 444 B**, antes 8 289) — no tiene loop, así que su carga garantizada **es** el archivo de comando, y hasta ahora era el único doc de hot path sin presupuesto, justo donde gasta esta ronda; `spec-refine` 45 800 → 46 200 (medida 45 410, por la nota de frontera). `quick` absorbe su línea dentro de la holgura existente y no se mueve.
- **Orientación**: `SKILL.md` (one-liner de `/w:spec-new` + § *The 3 flows*: el corte se decide **después** del reconocimiento y sigue el resultado funcional independiente) y README raíz (línea SPEC del modelo).

**Decisiones cerradas de la ronda** (del diseño previo): techo cuantitativo **sí**, subordinado a las paradas por intención · hipótesis **solo interna** (sin YAML, sin sección nueva) · las specs hermanas se siguen **creando** tras consentimiento (solo se movió el momento de decidir) · rutas en `Context` como anclas, ≤1 por componente · **sin marca nueva** de «pendiente de reconocimiento profundo» (`Open questions` y la ausencia de `## Refinement decisions` ya lo dicen) · impacto de contexto medido por G1 · interacción única **absoluta**, con la excepción funcional dentro de la misma structured-choice. La conducta viva sigue siendo del modelo: los guards solo evitan deriva textual; los casos funcionales se validan por smoke tras reinstalar el bundle.

## [20.17.0] — 2026-07-20

**La pestaña [Project] gana contador de commits propios y acción a Desarrollo; el workspace gana ramas por defecto y `--all` deja de abandonar fuentes.** Origen (spec 008 · plan 007): [Enviar a QA] fallaba con «No QA branch declared for this source» porque la rama QA solo existía per-source y el TUI nunca pasa `--target`; `--all` era fail-stop deliberado, así que una fuente sucia dejaba al resto sin tocar; y la lista SOURCES no decía cuánto trabajo llevaba cada rama. Ahora el bloque WORKSPACE tiene una entrada `- Ramas por defecto:` (principal/desarrollo/qa) editable desde [Config], **cada rol resuelve per-source → default del workspace → piso** (`main`/`development`/`qa`) por una cadena única que comparten git-flow y el TUI, existe la acción **to-dev**, y `--all` procesa **todas** las fuentes agregando el peor estado.

### Added

- **Ramas por defecto del workspace** (`parsers/project-block.ts` · `render/project-block.ts` · `project-md-upsert-service.ts`): campo `default_branches` con round-trip completo y merge por rol en el upsert. La entrada se emite **antes** de las listas de ramas del Status: un parser viejo solo ignora una línea `- ` desconocida mientras no hay sección abierta; después la tragaría como rama de trabajo.
- **Resolutor de roles compartido** (`branch-resolver.ts`): `resolveSourceBranches` devuelve `prod`/`work`/`qa`/`dev` ya resueltos (per-source → default → piso). Lo consumen `git-flow-service` y `project-tab-data`, así que lo que muestra el TUI es sobre lo que actúan los flujos. Desaparece `validateBranches`: con todos los roles resolviendo siempre, sus dos errores eran inalcanzables.
- **Sección «RAMAS (workspace)» en [Config]**: [Rama principal] · [Rama de desarrollo] · [Rama QA], edición inline (↑↓ · ⏎ · esc) con el patrón de Namespace. Visible solo con workspace detectado. Persiste en el bloque WORKSPACE de CLAUDE.md/AGENTS.md — nunca en las prefs de usuario— y **solo adopta el valor si la escritura aterriza** (el upsert señala el fallo resolviendo con `{error}`, no lanzando: un lock ocupado dejaba la fila mintiendo).
- **Contador de commits propios en la lista SOURCES**: `+N` = commits alcanzables desde la rama actual y no desde la principal resuelta, **sin merges** (`rev-list --count --no-merges <base>..<rama>`), junto al chip dirty/in sync, que se conserva. Solo refs locales (sin fetch): `<base>` → `origin/<base>`. Muestra «—» si la rama ES la principal, si no hay base, o con HEAD desacoplado — `rev-parse --abbrev-ref HEAD` imprime el literal `HEAD` con exit 0, así que sin ese centinela un rebase a medias mostraba un número parcial.
- **Acción `to-dev` («Enviar a Desarrollo»)**, espejo de to-qa: `aw git-flow to-dev` y 2ª entrada del panel del TUI. Destino = default `desarrollo` del workspace (`--target` para un destino puntual); sin cadena per-source. Termina ok sin merges redundantes cuando la rama de trabajo ya ES la de desarrollo.

### Changed

- **`--all` pasa de fail-stop a continue-on-failure** (sin flag: es el comportamiento único). Toda fuente declarada se intenta y el resultado trae una entrada por cada una con su motivo; el estado global es el **peor caso** (`error` > `conflict` > `ok`), así que un ok posterior no tapa un fallo anterior. Exit codes intactos: 1 · 2 · 0. `docs/design/git-flow-per-source.md` queda enmendado (resolución de ramas + semántica de lote + 4ª acción).
- **El fallo de una fuente ya no tumba el lote**: las precondiciones `isMerging`/`isDirty` **lanzan** en el adaptador real cuando el path no es un repo usable; esa excepción se llevaba por delante todas las fuentes restantes. Ahora es el error de esa fuente.
- **Una celda «Rama principal» vacía significa «usa el default del workspace»**, y deja de escribirse el literal legacy `certificacion` (que la spec ya declaraba solo compat de parseo). `workspace-init` no estampa rama base cuando el usuario no la declara: hacerlo dejaba el control [Rama principal] inerte —el valor per-source siempre ganaba— y un re-init pisaba la celda vacía. `main_branch` pasa a `string | null` (`aw check-branch` lo refleja; es pass-through, no alimenta lógica).

## [20.16.0] — 2026-07-14

**Los artefactos pierden la duplicación estructural y el andamiaje write-only: traza de refinamiento única, plan-doc consolidado, runtime slim.** Origen (análisis empírico sobre family-rag): `## Q&A traceability` restablecía 1:1 lo ya dicho en `## Refinement decisions` (~13% de las specs), los Scenarios re-expresaban los acceptance criteria (~31%), el plan narraba el mismo delta 4–5 veces (Summary/Solution/AS-IS/TO-BE/Final behavior) con `## Phases` duplicando los headers de fase y `## Estimated time` que nadie leía, la ejecución dejaba residuo en el plan-doc (tablas de resultado, bloques de fase duplicados), y SESSION/CHECKPOINT/HISTORY cargaban ~44% de chrome derivable. Ahora: **una sola traza** (`## Refinement decisions` absorbe las preguntas al humano como entradas `Q: … → … — …`; la marca de refinada pasa a ser esa sección a solas — las specs legacy con ambas siguen contando), **Scenarios solo cuando aportan** (setup GIVEN o semántica de borde; nunca restatement 1:1), **plan-doc consolidado** (`## Solution` absorbe resumen + delta AS-IS→TO-BE + bloque Final behavior; los `### Fn` dentro de `## Tasks` son la única fuente de fases; mueren `Summary`/`AS-IS`/`TO-BE`/`Final behavior`/`Phases`/`Estimated time` como secciones; `## Open questions` se omite vacía), **exec checkbox-only** (el plan-doc solo recibe flips `- [ ]`→`- [x]` y UNA línea `> Estado: done…` al cierre; resultados a DECISION/CHECKPOINT; nunca duplicar un bloque de fase), y **runtime slim** (SESSION sin `## Type` — derivable del sufijo del nombre, con fallback en el resolver —, CHECKPOINT con `## Open questions` condicional, BACKLOG sin `## Followups`, HISTORY de 7 a 4 columnas con migración lazy de tablas legacy). Lectores backward-compatible en todo el corpus viejo; sin cambio de superficie de comandos. Bundle `w` **13.14.0**.

### Added

- **Guard `G14 · artifact-slim pins`** (`doctrine-guards.test.ts`): marca refinada = `## Refinement decisions` a solas + formato `Q:` + tolerancia legacy · anti-restatement de Scenarios en ambos esquemas · Delta 1 de plan-new sin `## Summary`/`## Current state`/`## Target state`/`## Final behavior`/`## Phases`/`## Estimated time`/`## Q&A traceability` (con los bloques absorbidos anclados: `AS-IS → TO-BE`, `"Final behavior" block`, `### Fn`, `OMIT the section when empty`) · regla checkbox-only + `NEVER append a duplicate ### Fn block` + línea única de estado done en plan-exec.
- **Migración lazy de HISTORY.md** (`history-table.ts`): el upsert detecta cabecera legacy (7-col con `Flujo` o 6-col sin) y reescribe la tabla completa al formato slim `| Sesión | Fecha | Estado | Refs |`, re-keyando la celda `Sesión` con su `#` (`001-dev-foo`) para no perder la clave de fila; upserts posteriores matchean por prefijo de código sin duplicar filas. Tests nuevos en `history-table.test.ts`.
- **Fallback de tipo por sufijo** (`session-resolver.ts`): sin `## Type` en SESSION.md, el tipo se deriva del sufijo del descriptor (`-spec-refine|-plan-new|-plan-refine`→`refine` · `-plan-exec`→`exec` · `-quick`→`quick`); una sección `## Type` legacy sigue ganando.

### Changed

- **SESSION.md sin `## Type`** (template doctrinal + renderer `templates/session.ts`): el flag `--type` de `aw session-create` se mantiene obligatorio (los hard floors G7 lo pinnean) pero ya no se renderiza.
- **Contrato CHECKPOINT**: `## Completed` · `## Pending / Next` fijos; `## Open questions` solo mientras haya dudas vivas (nunca placeholder "None"). G6 pinnea el condicional. Los hard floors de los 5 comandos de flujo reflejan el contrato.
- **BACKLOG sin `## Followups`**: `## Deferred` absorbe (una entrada puede llevar nota de follow-up); `aw status` ya solo leía `Deferred`.
- **`aw status`**: `refined` = presencia de `## Refinement decisions` a solas (retrocompatible con specs que además tienen `## Q&A traceability`).
- **Exports/punteros re-anclados**: export-diagrams/export-manuals y sus comandos, `exports/README.md`, `SKILL.md` y `artifacts/README.md` leen ahora los bloques de `## Solution` del plan-doc (nota de tolerancia: plans legacy con secciones separadas).
- **G1 byte-budgets re-anclados** a medido + ~0,8 KB (quick 48 600 · spec-refine 45 800 · plan-new 46 600 · plan-refine 58 000 · plan-exec 49 100): los esquemas encogen pero la doctrina exec ganó las reglas checkbox-only/never-duplicate y las notas de compat.
- **Goldens/fixtures**: SESSION sin `## Type`; HISTORY golden migrado a 4-col (la fixture legacy 7-col queda como input de migración).

## [20.15.0] — 2026-07-14

**El gate de cierre gana el `Tooling check` y la orientación el `Tools pointer`: el tooling auxiliar reutilizable deja de morir sin casa en las sesiones.** Origen (spec 007): en family-rag las tools de medición/soporte nacieron dentro de `.workflow/sessions/` o como scripts de repo sin ficha — la skill ambient `creating-tools` existía y estaba habilitada, pero nada la disparaba de forma fiable (la mención in-flight vive solo en plan-exec) y nada user-visible apuntaba a ella («no lo encuentro»). Ahora el cierre de los dos loops code-editing atrapa el miss como red de seguridad, y la orientación dice dónde viven las tools y quién las escribe. Encuadre estrictamente ambient (auto-descubierta; Workline no la enlaza — el review adversarial del propio release cazó y corrigió el acoplamiento inicial) y degradación **declarar-y-diferir**: en hosts sin la skill el loop **nunca** escribe `docs/tools` — la carencia va declarada a `Open questions` + `BACKLOG` (invariante 2 intacto). Solo doctrina + guards (cero código de runtime); chasis intocado — el impuesto cae solo en los dos flujos code-editing. Bundle `w` **13.13.0**.

### Added

- **Bullet `Tooling check`** en `loops/CODE-POLICIES.md` § *Closing review gate* (6º, tras la minimality lens): ¿la corrida creó tooling auxiliar reutilizable (scripts/CLIs/generadores/configs de soporte — no código de producto, no probes de sesión)? → el host aplica la skill ambient `creating-tools` (auto-descubierta por su `description`; Workline no la enlaza) y la tool obtiene su casa `docs/tools/<slug>/` (README + estructura de runs/output según el contrato de la skill + fila de índice). Host sin la skill → el loop nunca escribe `docs/tools`: carencia declarada y diferida — nunca silenciosa.
- **`Tools pointer`** en `SKILL.md` § *The 3-layer architecture + `docs/` zone*: el puntero user-visible que faltaba — casa `docs/tools/<slug>/`, autora la skill ambient `creating-tools`, el gate de cierre como red; el plugin `tool-builder@qtc-marketplace` se menciona **solo como locator no vinculante** («Workline does not depend on it»).
- **Guard `G13 · tooling gate pins`** (`doctrine-guards.test.ts`): el bullet anclado a la sección del gate (`Tooling check` · `creating-tools` · `auto-discovered` · `docs/tools/<slug>/` · `never writes docs/tools itself` · `declare the gap`) + **pin negativo** `not.toContain("qtc-marketplace")` en el gate (el id de marketplace vive solo en el pointer) + asserts del pointer anclados a su blockquote, no whole-file (un contain global era tautológico: `creating-tools` preexistía en la orientación).

### Changed

- **G1 byte-budgets** de los dos flujos code-editing recalibrados (solo ellos cargan CODE-POLICIES; el chasis no ganó bytes): quick 47 900 → 48 500 (carga medida 47 735 B) · plan-exec 47 300 → 48 000 (medida 47 199 B); ~0,8 KB de holgura.
- **Bullet de convenciones del gate acotado**: «Workline names and binds no concrete **conventions** skill» — deja de ser el absoluto que el nuevo Tooling check habría contradicho en la misma sección.

## [20.14.2] — 2026-07-13

### Fixed

- **Windows: el fallback background ejecutaba mal los wrappers JVM** — `winLaunchCommand` emitía `./mvnw.cmd`, válido en PowerShell pero no en cmd.exe (el fallback corre por `cmd /c` → «"." no se reconoce…» y el servicio nunca arrancaba, ni siquiera invisible). Ahora emite `.\mvnw.cmd`/`.\gradlew.bat`, válido en **ambos** intérpretes (afecta también `run.ps1`).
- **Windows: cascada de lanzadores** — si el hop `Start-Process` no logra abrir la consola (EDR/AppLocker sobre la cadena powershell→powershell, u otro bloqueo ambiental), se intenta un segundo hop vía `conhost.exe` (CreateProcess directo, sin ShellExecute) antes de caer a background. Cada hop usa pidfile y abort-marker propios (7 s por hop); los archivos stale de sesiones previas se limpian antes de cada intento (los nombres `aw-launch-<pid>-<seq>` se repiten cuando Windows recicla PIDs) y el pidfile se consume también en el éxito.
- **Diagnóstico del fallback visible** — cuando el lanzamiento cae a background, la TUI muestra «Motivo: …» (error de spawn · «salió con código N» · timeout del pidfile, por hop) y el log operativo registra `launch/relaunch X → fallback background: <motivo>` como `warn`; el relanzamiento (tecla `r` y resolución de colisión) ahora reporta el modo y el motivo igual que el lanzamiento.

## [20.14.1] — 2026-07-13

### Fixed

- **Windows: lanzar un source desde la TUI no abría ninguna consola** (el registro decía `ok` pero la app corría invisible o nada aparecía). Causa raíz: `spawn(powershell, {detached:true})` mapea a `DETACHED_PROCESS` en libuv, que arranca el hijo **sin consola** — el "own console window" de la doc de Node no existe. Ahora un PowerShell oculto efímero hace el salto vía `Start-Process` (ShellExecute), que sí crea la consola visible; el cuerpo del lanzamiento viaja **inline por `-Command`** (nunca como `.ps1`: la ExecutionPolicy por GPO no lo gobierna y no hay archivo que limpiar) con `-NoProfile` (arranque determinista) y escribe su `$PID` (la consola visible, que parenta la app) al pidfile que el adapter ya sondeaba en *nix — `taskkill /T`, cerrar-para-detener y liveness intactos. Un **marker de aborto** evita el doble lanzamiento si una consola tardía aparece después del fallback a segundo plano, y el modo terminal deja una línea marcador en el log para que «Ver log» no muestre una corrida vieja como actual. Limitaciones documentadas: sin tee del log en modo `server` (la salida vive en la ventana) y el PID registrado sigue vivo tras salir la app (la ventana `-NoExit` queda abierta).

## [20.14.0] — 2026-07-13

**Los puntos de autoría ganan puertas de división consentida: `spec-new` puede dividir un prompt multi-requerimiento en N specs hermanas, y los plan-loops un plan en N planes hermanos.** Hasta ahora la cardinalidad era singular en toda la doctrina (un spec por invocación, un plan por spec) aunque ninguna invariante lo exigiera: el prompt que agrupaba varios requerimientos salía como un solo spec, y las tranches independientemente entregables quedaban presas de un único plan. Ahora ambos puntos ofrecen — con consentimiento vía structured-choice y solo ante señales claras (≥2; borderline sigue en singular sin preguntar) — dividir el trabajo en hermanos cross-referenciados por path, atacables en diferentes momentos y orden. Solo doctrina + guards (cero código de runtime: `aw next-number` secuencial basta — mint antes de cada write, sin colisión); el chasis y el harness quedan intocados — los gates viven en los herederos. Limitaciones conocidas: un pase multi-write interrumpido (spec-new no tiene sesión) deja los drafts ya escritos válidos — la recuperación es re-invocar con el resto del corte, sin rollback (minimality); y `spec-refine` no divide en v1 (se resuelve re-corriendo `spec-new` con la parte extraída — candidato a futuro). Bundle `w` **13.12.0**.

### Added

- **Sección `## Split gate (multi-spec)`** en `commands/spec-new.md`: tras leer `$ARGUMENTS` y antes de escribir nada, evalúa si el prompt agrupa varios requerimientos independientes (señales ≥2: entregables/objetivos independientes · enumeración explícita de features distintas · momentos/orden distintos pedidos · subsistemas no relacionados). Si dispara: la única interacción del comando — un structured-choice con el corte propuesto (nombre+slug, alcance 1 línea, orden), labels `Dividir en varias specs` | `Una sola spec`, `Cerrar` = abortar sin escribir; respuesta libre ajusta el corte. Al aceptar sigue single-pass NO RESEARCH: acuña con `aw next-number docs/specs` inmediatamente antes de cada write (números consecutivos ⇒ paths hermanos conocidos tras el primer mint); `## Origin` lleva `split (part i/N)` + siblings por path + orden sugerido, y cada `## Scope` Out apunta a la hermana. Nunca dispara en las entradas de reutilización (escalación quick→SPEC, adopción persist).
- **Gap `Plan splittable` + sección `## Split gate (multi-plan)`** en `loops/plan-new-loop/LOOP.md` (definición canónica para ambos plan-loops): oferta como content question del batch (`Dividir en varios planes` | `Un solo plan`) con recomendación; declinar = exhausted (sin re-oferta en el run); corte aceptado sembrado en CHECKPOINT (resume no re-pregunta); anti-duplicado por `## Origin` (recomendar reanudar hermanos, nunca un segundo set). Al aceptar: los N hermanos salen **completos** del mismo run y la misma sesión (una fila de HISTORY) — cada uno con el esquema Delta 1 entero, inmediatamente ejecutable; `## Dependencies` lleva el orden inter-plan (acíclico, advisory — plan-exec no lo verifica). Coherence gate re-encuadrado: cada acceptance criterion traza a exactamente un hermano — partición completa y disjunta. Cierre de la rama split: `Guardar planes` (la rama singular conserva `Guardar plan`).
- **Sección `## Split gate — refine semantics`** en `loops/plan-refine-loop/LOOP.md` (referencia el gate canónico, nunca lo redefine): el plan original conserva su número/path y se reescribe reducido a su tranche restante; las tranches extraídas nacen como planes hermanos acuñados nuevos; el gate también dispara en planes **parcialmente ejecutados** — las tareas completadas (`- [x]`) nunca se mueven a un hermano (el historial de ejecución queda anclado al path original); la división se registra en `## Refinement decisions`. Cierre de la rama split: `Guardar planes` (la rama normal conserva `Guardar plan refinado`).
- **Guard `G12 · split gates pins`** (`doctrine-guards.test.ts`): fija los 3 headings de gate, los labels canónicos, el orden antes-de-escribir, el scoping de escalación/adopción y el chasis limpio de split (espejo G11). **Contrato `Split contract`** (`skill-consistency.test.ts`, espejo del QUICK escalation contract): única interacción pre-write en spec-new; gate multi-plan definido una sola vez (labels de oferta y fila de gap viven solo en plan-new-loop); `siblings by path` en ambos productores; partición pinneada; regla `- [x]` pinneada; `Guardar planes` en ambos § Sequence; orientación raíz al día.

### Changed

- **G1 byte-budgets** de los dos flujos de plan recalibrados (solo ellos se mueven — el chasis no ganó bytes): plan-new 42800 → 46200 (carga medida 45397 B) · plan-refine 52200 → 57600 (carga medida 56763 B); ~0,8 KB de holgura sobre lo medido.
- **Orientación**: `SKILL.md` § *The 3 flows* registra la capacidad de división de ambos puntos de autoría (split ≠ escalación: misma línea de trabajo); README raíz (líneas SPEC/PLAN del modelo); descriptions de `spec-new`/`plan-new`/`plan-refine` mencionan el split (≤500 chars, G4 verde).

## [20.13.0] — 2026-07-11

**`spec-refine-loop` gana su primera puerta divergente: la puerta de creatividad (ideation gate), con búsqueda web opcional.** Hasta ahora el loop solo convergía (cada resolutor cierra gaps) y la doctrina era 100% offline: si la spec nació casada con el primer enfoque, nadie proponía alternativas. Ahora el loop detecta esa señal y ofrece — con consentimiento explícito — una ronda de brainstorming que propone y combina ideas, buscando en la web donde el host lo permita. Solo doctrina + guards (cero código de runtime, cero config nueva); el chasis queda intocado — impuesto solo-SPEC. Bundle `w` **13.11.0**.

### Added

- **Gap `Unexplored solution space` + sección `## Ideation gate (creativity)`** en `loops/spec-refine-loop/LOOP.md`: oferta como content question (`Explorar ideas` | `Seguir sin ideación`) con recomendación y anti-refire (declinar = exhausted; a demanda siempre disponible; alternativas ya adoptadas de la conversación suprimen el disparo) · ronda de ideación consentida (ideas nuevas + combinadas; hallazgos y fuentes → `CONCLUSIONS`) · veredictos top ≤3 (`Adoptar` → integra + traza en `## Refinement decisions` con fuente · `Descartar` → una línea + motivo · `Aparcar` → `## Open questions`) · divergencia acotada por Minimality; solo fase SPEC (`spec-new` sigue single-pass sin web; plan/quick no heredan nada). Rama en § Sequence + línea en § Integration + apunte en el esquema del entregable.
- **Capability opcional `web-research`** en `harness/HARNESS.md` (patrón `host-memory`): fila de catálogo + fila de matriz (Claude Code `WebSearch`/`WebFetch`; Codex `web_search` opt-in; Gemini `google_web_search`+`web_fetch`; resto `~`) + nota de consumidores — el consentimiento va empaquetado en la aceptación de la puerta (nunca browsing libre fuera de una ronda consentida); en degradación el loop idea offline y **lo declara** (a diferencia del silent-omit de host-memory).
- **Guard `G11 · creativity/ideation gate pins`** (`doctrine-guards.test.ts`): fija la puerta en el LOOP, la capability en HARNESS, el **scoping** (el chasis no contiene `web-research` ni ideación) y la prohibición de web de `spec-new`.

### Changed

- **G1 byte-budget de spec-refine** recalibrado 42500 → 45300 (solo ese flujo se mueve — el chasis no ganó bytes): carga medida 44525 B + ~0,8 KB de holgura.

## [20.12.0] — 2026-07-11

**Los loops se autorregulan: compactación proactiva de contexto (modos `confirm`/`auto`) + `/w:resume` dirigido por artefacto.** Hasta ahora `Compactar` era puramente reactivo (solo se disparaba si el humano lo elegía en la structured-choice) y `/w:resume` no aceptaba argumentos. El delta es proactividad sobre mecánica existente: el loop detecta la presión de contexto y levanta (o ejecuta) la compactación él mismo, con CHECKPOINT garantizado antes; y el reenganche se dirige por artefacto. Solo doctrina + plantilla + guards (cero código de runtime nuevo, cero CLI nueva, cero cambios de resolver). Bundle `w` **13.10.0**.

### Added

- **Subsección `Self-regulation (proactive compaction)`** en el chasis (`loops/CHASSIS.md` § Compact / resume): señal del host + fallback cualitativo en fronteras de batch/fase (sin umbrales numéricos — doctrina agnóstica), modos `confirm` (default, también sin config: structured-choice proactiva con `Compactar` recomendada; el consentimiento nunca se salta) / `auto` (opt-in: CHECKPOINT + binding del host sin preguntar; **degrada a `confirm`** si el host no tiene mecanismo no-interactivo), e invariante CHECKPOINT-antes-de-compactar. Heredan los 5 loops; cero ediciones por-loop. Nota de levantamiento proactivo del `flow` control en § Structured-choice.
- **Nota `compaction (signal & self-regulation)`** en `harness/HARNESS.md` (+ señal en la fila del catálogo): hechos por-host — señal de presión de contexto, viabilidad de `auto` (mecanismo no-interactivo) y degradación; ejemplo Claude Code (el agente no puede invocar `/compact` él mismo → `auto` degrada; el auto-compact nativo ya está amortiguado por los hooks Pre/PostCompact). La semántica de modos queda single-source en el chasis.
- **`/w:resume <artefacto>` — reenganche dirigido**: argumento opcional (spec `docs/specs/…`, plan `docs/plans/…` o sesión `NNN`) — deriva el slug → `aw sessions --state all` / `aw resume-summary --include-recent-closed` → confirma la asociación por el `## Origin` de las SESSION.md → propone la ruta exacta vía structured-choice según la tabla `## Routing`. Hard floor read-only intacto (con o sin argumento); sin argumento, el flujo de siempre. Cero CLI nueva.
- **Scaffold `[compaction]`** comentado en la plantilla de `.workflow/skills.toml` (`mode = "confirm" | "auto"`, par adyacente tras los roles de `[skills]`): el resolver ya tolera tablas top-level extra — cero cambios de resolver; `confirm` es el default sin tocar el TOML (el opt-in real es `auto`).
- **Guards nuevos**: `chassis-consistency` (subsección + modos + checkpoint-antes + sin umbral numérico + presupuesto ≤15 líneas + harness single-source) · `skill-consistency` (resume: argumento opcional declarado, hard floor read-only conservado, resolución vía CLI existente + `## Origin` + `## Routing`) · `workspace-init-service` (adyacencia y orden de la sección `[compaction]` en la plantilla).

### Changed

- **G1 byte-budgets** recalibrados para acomodar la subsección (cargan los 5 flujos; ~0.8 KB de holgura sobre lo medido): quick 47900 · spec-refine 42500 · plan-new 42800 · plan-refine 52200 · plan-exec 47300.
- **Orientación raíz (`SKILL.md`)**: el one-liner de `/w:resume` menciona el argumento opcional y la capability `compaction` la señal que alimenta la autorregulación.

## [20.11.0] — 2026-07-09

**Las puertas de convergencia ganan un lente de minimalidad (anti-over-engineering) internalizado, sin depender de skills externas.** Hasta ahora los gates verificaban correctness (tests) y coherencia (trazabilidad), pero nada chequeaba si el entregable estaba sobre-especificado o sobre-ingenierizado; y donde esa revisión medio existía (el closing review gate) dependía de convenciones ambientales externas. Ahora es piso built-in: la esencia de `ponytail-review` (`delete`/`stdlib`/`native`/`yagni`/`shrink`) internalizada como propiedad compartida del gate — no como skill ni rol nuevo, sino como un lente en las puertas que ya existen. Solo doctrina + guards (cero código de runtime). Bundle `w` **13.9.0**.

### Added

- **Propiedad compartida `Minimality (anti-over-engineering)`** en el chasis (`loops/CHASSIS.md` § Verification-first, junto a `Gate integrity`): pasar los `Success criteria` es necesario pero **no suficiente** — la puerta rechaza un entregable más pesado de lo que exigen, a la altitud del entregable (escalera lazy: ¿existe? / ¿ya está? / ¿más chico?). Piso built-in con cero skills externas; las ambientales solo lo **elevan**. Acotado por `Gate integrity` (nunca recorta correctness/seguridad/validación).
- **Instanciación por heredero**: `spec-refine` (gap "over-specified requirement" + analyze gate), `plan-new`/`plan-refine` (gap "over-engineered solution / needless phase-task" + coherence gate + nota generativa "build-lazy"), `plan-exec`/`quick` (piso "Minimality lens" con tags `delete`/`stdlib`/`native`/`yagni`/`shrink` en el closing review gate de `CODE-POLICIES.md`).
- **Guard `G10 · minimality pins`** (`doctrine-guards.test.ts`): fija `§ Minimality` en el chasis + su instanciación por heredero, para que una compresión futura no lo tire en silencio.

### Changed

- **`roles/README`**: aclara que la minimalidad **no es un rol** — es propiedad built-in del convergence gate; no reabre el rol `review` descartado.
- **G1 byte-budgets** subidos para acomodar `§ Minimality` (que cargan los 5 flujos): quick 46400 · spec-refine 41000 · plan-new 41300 · plan-refine 50700 · plan-exec 45900.

## [20.10.0] — 2026-07-08

**Nuevo comando transversal `/w:resume` (hermano accionable de `/w:status`) + `/w:status` entiende también el historial del host.** `/w:resume` compone `/w:status` para el resumen priorizado de lo pendiente (señales workline + contexto del host) y propone cómo continuar vía structured-choice, enrutado al comando destino. `/w:status` gana una sección "CONTEXTO DEL HOST" oportunista (cheap tier; se omite en silencio si el host no expone memoria barata). Ambos read-only. Capability nueva compartida `host-memory`. Solo doctrina (cero código de runtime). Bundle `w` **13.8.0**.

### Added

- **`/w:resume`** — comando transversal read-only: compone `/w:status` para el resumen priorizado (orden fijo: sesión con CHECKPOINT > plan a medias > spec sin refinar > contexto de host) y propone retomar vía structured-choice (`Retomar` recomendada + `Descartar`/`Cerrar`), enrutado a `spec-refine`/`plan-new`/`plan-exec`/reopen. Nunca ejecuta el trabajo ni escribe `docs/` o `.workflow/`; respaldado por `aw status` + `aw resume-summary` (sin CLI nueva — auto-empaquetado a los 8 hosts por el glob del instalador).
- **Capability `host-memory`** (`harness/HARNESS.md`, catálogo + matriz binding, 2 tiers): recuperar estado/pendientes desde el historial que el host expone. Cheap (Claude Code: auto-memory `MEMORY.md`) + deep (transcripts/`--resume`); fallback universal (git/`docs/` + preguntar). Consumida por `/status` (cheap, oportunista, nunca pregunta) y `/resume` (compone `/status`; escala a propuesta solo si workline no explica lo pendiente).

### Changed

- **`/w:status`** — el dashboard read-only gana una sección "CONTEXTO DEL HOST" **oportunista y aditiva** (solo cheap tier; se omite en silencio si no hay memoria barata; nunca pregunta ni ralentiza el dashboard por defecto). Antes era `aw status` puro; ahora compone la capability `host-memory`. Divergencia consciente con el spec 002 (que lo dejaba intacto), incorporada en el plan 001 (refine).

## [20.9.0] — 2026-07-08

**+1 skill recomendada de arquitectura: `structurizr-c4`** (diagramas C4 as-code con la DSL de Structurizr, sin Docker). Publicada como repo/paquete propio `Tacuchi/structurizr-c4-skill` y sembrada en el catálogo del TUI. Bundle `w` sin cambios.

### Added

- **Seed `recommended-skills.ts`**: `Tacuchi/structurizr-c4-skill@structurizr-c4` — genera, valida y visualiza diagramas C4 as-code con la DSL de Structurizr (viewer local, validación, export a Mermaid/PlantUML), sin Docker. Complementa la doctrina `w` (no la duplica): dónde aterriza un diagrama lo decide `/w:export-diagrams`, esta skill provee el motor DSL.

## [20.8.1] — 2026-07-07

**Las descripciones de los comandos `/w:` ganan una cláusula "Use when…" de intención y un seam explícito entre comandos hermanos.** Antes decían solo el QUÉ; ahora front-loadean el CUÁNDO (los contextos y keywords que las disparan) y marcan el límite contra el comando vecino (spec-new↔spec-refine, plan-new↔plan-refine↔plan-exec), mejorando el ruteo por intención. Refinamiento de wording alineado con el best-practice oficial + comunidad de autoría de skills (research 004 del workspace); solo doctrina, dentro del cap G4 (≤500 chars). Bundle `w` **13.7.1**.

### Changed

- **Descripciones de los comandos `/w:`** — los 10 comandos de flujo y transversales (`quick`, `spec-new`, `spec-refine`, `plan-new`, `plan-refine`, `plan-exec`, `fix-git`, `persist`, `status`, `workspace-init`) anteponen una cláusula **"Use when…"** con los disparadores de intención y un **scope negativo** contra el comando hermano. Sin cambios en el comportamiento del loop; mejora la activación por intención. Guards G1-G9 verdes.

## [20.8.0] — 2026-07-07

**Los loops saben proponer pruebas de concepto (probe/PoC) y los SPECs ganan escenarios GIVEN/WHEN/THEN/AND.** El riesgo deja de ser algo que solo se declara: cuando una suposición es ejecutable (conexión externa, SDK, comportamiento UI) el agente propone sondearla temprano con un experimento atómico, en vez de descubrir la falla al final. Y el comportamiento de un spec puede concretarse en escenarios Gherkin trazados a sus criterios. Solo doctrina (cero código de runtime). Bundle `w` **13.7.0**.

### Added

- **Doctrina probe (PoC)** — chasis § *Proof of concept (probe)*: **cuarto resolutor** de la regla ask-vs-research (adopt · research · **probe** · ask) — research *lee*, un probe *ejecuta*: experimento atómico, descartable por defecto, que responde **una** pregunta falsable. Verification-first aplica al probe (pregunta + check pass/fail sembrados ANTES); el código vive en la **carpeta de sesión** (gitignored — nunca el source tree, nunca commiteado; DB probe = solo lectura); **probe fallido = hallazgo, no fallo**.
- **plan-new Delta 5 — probe tasks tempranas**: unknown que moldea el plan → probe **inline ahora** (el veredicto alimenta `Solution`/`Risks / impact`); riesgo de ejecución → **probe task explícita temprana**, antes de las tareas que dependen de su veredicto. El gap "Unaddressed risks" gana probe como resolutor (deja de ser humano-only). Surfacing en `commands/plan-new.md` (§ *Risky assumptions → probe (PoC) tasks*).
- **plan-exec Delta 7 — ejecución de probes**: seed check → código descartable en la sesión → veredicto en `CONCLUSIONS`/`DECISION` (tagged por task); un probe fallido **no falla la fase** (structured-choice; reshape → `Open questions` + `BACKLOG` o `/w:plan-refine`); **promoción** solo como edición normal de tarea (branch-check + review gate). quick y plan-refine ganan probe en su línea de resolutores.
- **`## Scenarios` en los SPECs** (draft + refined schema, **opcional**, tras `Acceptance criteria`): bloques **GIVEN/WHEN/THEN/AND** que concretan los criterios conductuales. Trazabilidad bidireccional como cláusula nueva del analyze gate (escenario → ≥1 criterio · criterio conductual → ≥1 escenario · sin contradecir `Scope`) + gap "Scenario missing". Los criterios siguen siendo el checklist que anclan los gates (plan-new los cubre transitivamente, sin cambios). `plan-exec` los usa como test cases listos: GIVEN=arrange · WHEN=act · THEN=assert.
- **Guard G9**: pins del probe (sección del chasis + cuarto resolutor + Delta 5/7) y del acuerdo draft↔refined del schema `## Scenarios`.

### Changed

- **Guard G1** (presupuestos de carga por flujo): subidos conscientemente (+~1.6-2.9 KB por flujo) por la doctrina probe + Scenarios; comentario en la tabla documenta el porqué.
- **Ordinales de resolutores** corregidos ("the same third gap-resolution mode" → modo de capacidad compuesta, junto a *research*, *probe* y *human*) en plan-new Delta 4 y spec-refine § Composes — la clase de deriva que el cuarto resolutor destapó.

## [20.7.0] — 2026-07-06

**El sistema se llama Workline (`w` = *workline*) y los flujos adoptan trabajo nacido en el host (host-as-producer).** Dos colisiones resueltas: "workflow(s)" chocaba con la feature homónima de Claude Code y "harness" estaba doble-reservado (sistema vs host) — desde ahora *harness* nombra SOLO al host. Re-gloss sin breaking: `/w:`, skill `w`, npm, bins `aw`/`agent-workflow` y `.workflow/` intactos. Y la doctrina deja de ser "componible por omisión": el host pasa de ejecutor sustituible a **productor legítimo de insumos** (spec 009 del workspace). Bundle `w` **13.6.0**.

### Added

- **`/w:persist`** (transversal, solo-doc — cero código por host): persiste trabajo **ya hecho en la conversación** (análisis, conclusiones, un plan) hacia `docs/`, clasificando por forma: análisis → `docs/research/NNN-research-<slug>.md` · requisito → draft de spec (procedimiento `spec-new`) · plan → adopción (`plan-new` modo 4). Con `## Origin` + atribución (host · modelo · fecha), anti-duplicado (structured-choice `Actualizar` / `Agregar perspectiva` / `Documento nuevo`) y hard floor propio (adopt-don't-re-derive, confirmar antes de escribir, `aw next-number`, nunca sesiones). Es la contraparte host→`docs/` de `export-*` (que sigue siendo la única vía sesión→`docs/`).
- **`docs/research`** — categoría nueva del zone `docs/`, dueña de análisis standalone (ni spec ni plan). Declarada en SKILL.md (diagrama + invariante 2), `artifacts/README`, `exports/README`. Schema fijo con `## Perspectives` para vistas multi-agente.
- **Patrón multi-host docs-mediado** (persist § *Multi-host cross-analysis*): N hosts analizan lo mismo → cada uno persiste su perspectiva atribuida (carve-out del anti-duplicado: misma pregunta + perspectiva declarada ≠ duplicado) → un host fuerte cruza los N docs y persiste la síntesis referenciando fuentes. Las sesiones (gitignored, machine-local) quedan fuera del intercambio — sin doctrina de concurrencia.
- **`plan-new` modo 4 — adopción de plan externo**: contenido que *ya es un plan* (plan mode del host, hand-written, otro agente) se materializa single-pass NO RESEARCH como `docs/plans/PPP-plan-<slug>.md` (`## Origin` = "adopted from <source>" + atribución), sin regenerar sobre planes existentes; luego ofrece `plan-refine`/`plan-exec`. `plan-refine` gana paridad con spec-refine (procedencia irrelevante: generado, hand-written o adoptado) y **degradación spec-less** del gate de coherencia (los criterios anclan al `## Final behavior` propio del plan; "spec criteria uncovered" y "plan↔spec drift" no aplican).
- **Doctrina adopted-context** (chasis § *Adopted context* + SKILL.md § *Host as producer*): lo ya establecido en la conversación (análisis con feature nativa del host, respuestas ya dadas) cuenta como **research completado** — se adopta (transcripción con procedencia, verificada por gate integrity), nunca se re-deriva ni se re-pregunta. Tercer resolutor de la regla ask-vs-research; scope de research incluye la conversación; quick lo reconoce en Reads/secuencia y el size gate no dispara señales ya resueltas por contexto adoptado; `spec-new` documenta la reutilización por adopción.

### Changed

- **Naming Workline** (re-gloss, sin breaking): prosa de doctrina ("the workflow"/"agent-workflow harness" → Workline), tab del TUI `[2] Workflows` → `[2] Workline`, header del TUI `WORKLINE`, subtítulo "stages + loops + artifacts **system**", README/AGENTS/package.json reposicionados (Workline = el sistema; `agent-workflow` = el runtime que lo implementa). "harness" queda reservado para el host en todo el corpus.
- **Guard G1** (presupuestos de carga por flujo): subidos conscientemente (+~1.5-3.6 KB por flujo) por la doctrina host-as-producer; comentario en la tabla documenta el porqué.

## [20.6.0] — 2026-07-05

**El registro de skills soporta el layout canónico `.claude/skills/` y ya no clona el repo entero para descubrirlas.** Instalar `checklist-discipline` desde `erichowens/some_claude_skills` fallaba con `la fuente no contiene la skill` (disponibles: solo un suelto): el repo movió sus ~200 skills a `.claude/skills/<skill>/` y el scanner ignoraba todo dot-dir. Además ese repo pesa ~670 MB, así que aun encontrándola el clone traía todo. Solo CLI (bundle `w` sin cambios).

### Fixed

- **Scanner de fuentes** (`skills-manager` `walkSkillDirs`): desciende a `.claude` — el home canónico de skills de Claude (`.claude/skills/<skill>`) — manteniendo excluidos los demás dot-dirs (`.git`, `.github`, estado de editores) y `node_modules`. Un repo que empaqueta sus skills de la forma estándar vuelve a ser descubrible.

### Changed

- **Descubrimiento sin bajar el repo** (`fetchSourceCandidates` + `install-plugin-skills-git`): el clone de una fuente git ahora es *blobless + sparse* (`--filter=blob:none --no-checkout` + `sparse-checkout` de solo los `SKILL.md`). Descubrir las skills de una fuente cuesta unos MB en vez del repo completo (verificado: `erichowens/some_claude_skills` pasó de ~670 MB / timeout a ~2 MB en segundos). El directorio completo de la skill elegida (con sus `references/`/assets) se baja bajo demanda al instalar, vía `sparse-checkout add`; una fuente cuyo repo raíz **es** la skill restaura el árbol completo. Un servidor que rechaza el partial/sparse clone cae a un clone completo (sigue siendo correcto).

## [20.5.0] — 2026-07-04

**`generate-launch` distingue modo interactivo (TUI) de servidor — la TUI ahora levanta al lanzar.** El wrapper backgroundeaba + redirigía stdout a `tee` (no-TTY), así que una app interactiva (Ink) caía a su salida de comando/help en vez de la UI. Bundle `w` **13.5.0**.

### Fixed

- **Modo de lanzamiento** (`source-launch-scripts-service` + `terminal-launch`): el descriptor gana `mode: "interactive" | "server"`. `interactive` corre la app en **foreground dueño del TTY** (`exec`, sin tee/background) — la TUI aparece; `server` mantiene el comportamiento actual (background + tee al log + ventana monitoreable). Heurística: entrada `bin`/`main` (CLI) → `interactive`; `dev`/`start`/`serve`/`bootRun`/`spring-boot:run` → `server`. El modo fluye por `resolveLaunch` → `spawnInTerminal` → wrapper *nix.

### Added

- **Overrides** `aw generate-launch --mode interactive|server` y `--command "<cmd>"` (un solo source; reemplaza command+args, descarta el build auto).
- **Structured-choice al generar** (skill `/w:generate-launch`): el manual instruye confirmar el modo/comando por fuente lanzable antes de escribir (recomendado = el detectado), con la advertencia del fallo TUI-como-server.
- **Campo `mode`** en el resumen por fuente (`SourceArtifactResult`).

## [20.4.0] — 2026-07-04

**`generate-launch` detecta CLIs y apps compiladas, no solo dev-servers.** Reportaba `Lanzable: No` (stub `exit 1`) para un proyecto que corre localmente sin problema (p.ej. este CLI: `bin` → `dist/cli/main.js` + script `build`). Bundle `w` **13.4.0**.

### Fixed

- **Detección npm** (`source-launch-scripts-service`): además de `dev`/`start` reconoce `serve` y, sin script de arranque, la **entrada `bin`/`main`** ejecutada con `node`, **compilando antes** (`npm run build`) cuando existe script `build` — un CLI TypeScript corre desde su `dist/`. Antes esos proyectos quedaban como stub.

### Added

- **Paso `build` en el descriptor de lanzamiento**: lo ejecutan antes del comando tanto los scripts generados (`run.sh`/`run.ps1`, fail-fast si el build falla) como el spawn del TUI (wrapper *nix, consola win32, fallback headless) — consistencia entre ambos caminos.
- **Campo `run` en el resumen por fuente**: muestra el comando detectado (`npm run build && node dist/cli/main.js`), no solo `launchable` sí/no.

## [20.3.0] — 2026-07-04

**Nuevo comando transversal `/w:generate-launch`**: (re)genera/actualiza los scripts de lanzamiento de las fuentes (`.workflow/launch/<alias>/`) sin esperar al primer "Lanzar". Bundle `w` **13.3.0** (14 wrappers en los hosts skill-as-command).

### Added

- **Comando `aw generate-launch`** (+ skill `/w:generate-launch`): lee las fuentes del bloque WORKSPACE y (re)genera `launch.json` + `run.sh` + `run.ps1` detectando el stack de cada una. Transversal (sin flujo/sesión, no toca `docs/`); complementa la generación on-demand del primer lanzamiento. Flags: `--source <alias>` (repetible), `--force` (sobrescribe scripts editados a mano), `--dry-run`, `--workspace <dir>`. Fuentes sin comando de arranque (`launchable:false`) o con path ausente se reportan y saltan.
- **Doctrina `w`**: manual `commands/generate-launch.md` + entradas en la sección transversal de `SKILL.md` y `commands/README.md`. Se auto-empaqueta a los 8 hosts (el instalador itera `commands/*.md`).

### Changed

- **`source-launch-scripts-service`**: separada la *decisión* de la *escritura* (`classifyWrite`/`writeArtifact`) para soportar `--dry-run` y `--force` sin duplicar lógica; nuevo outcome `overwritten` (edición de usuario sobrescrita por `--force`). El camino on-demand del lanzamiento no cambia de comportamiento.

## [20.2.1] — 2026-07-04

**Fix: la firma de `session-create` en el hard-floor omitía `--objetivo` (obligatorio).** Copiada literal, fallaba en el primer intento con `--objetivo es obligatorio` — justo el modo de fallo que el hard-floor debe evitar en modelos débiles. Bundle `w` **13.2.1**.

### Fixed

- **Hard-floor de los comandos-trampolín** (`skills/w/commands/{quick,spec-refine,plan-new,plan-refine,plan-exec}.md`) y **`loops/CHASSIS.md`**: la firma `aw session-create --type … --name …` ahora incluye `--objetivo "<one-line objective>"`, alineada con el contrato del servicio (`--type`/`--name`/`--objetivo` obligatorios). `spec-new` no crea sesión (sin cambios).
- **Guard G7** (`doctrine-guards`): antes solo exigía el prefijo `aw session-create --type`, por eso no cazó el `--objetivo` faltante; ahora exige también `--objetivo`. Budget de bytes de `plan-new` +100 B (contenido obligatorio, no bloat).

## [20.2.0] — 2026-07-04

**+1 skill recomendada de comportamiento: `checklist-discipline`** (promovida de "por caso" a seed). Verificada instalando.

### Added

- **Seed `recommended-skills.ts`**: `erichowens/some_claude_skills@checklist-discipline` — guarda contra omitir pasos en procedimientos/runbooks largos. Portable, sin conflicto con la doctrina. Espejada en el README del marketplace.

## [20.1.1] — 2026-07-04

**Fix: 2 skills recomendadas del seed no instalaban** (mismatch pick-vs-slug de skills.sh, detectado con instalación real). Sin cambios de conducta.

### Fixed

- **`recommended-skills.ts`**: `condition-based-waiting` movida de `obra/superpowers-skills` (cuyo pick es el display name `"Condition-Based Waiting"`, no un slug) a `nickcrew/claude-ctx-plugin`; `filesystem-context` → `context-engineering-collection` (el pick real de `muratcankoylan/agent-skills-for-context-engineering`, que empaqueta una sola skill). Ambas verificadas instalando; espejadas en el README del marketplace.

## [20.1.0] — 2026-07-04

**5 skills externas recomendadas nuevas en la tab [Skills].** Curación con workflows multi-agente (descubrimiento + verificación adversarial de encaje/conflicto/portabilidad) sobre skills.sh, cruzada contra la cobertura interna (dev-conventions/qtc-conventions/harness). Detalle en `docs/research/001` (stack) y `002` (comportamiento) del proyecto agent-workflow. Bundle `w` sin cambios.

### Added

- **Seed `recommended-skills.ts` (+5)**, espejadas en el README del marketplace (§ Skills externas recomendadas):
  - Stack: `github/awesome-copilot@spring-boot-testing`, `@postgresql-optimization`, `grafana/skills@prometheus`.
  - Comportamiento: `obra/superpowers-skills@condition-based-waiting`, `muratcankoylan/agent-skills-for-context-engineering@filesystem-context`.

## [20.0.0] — 2026-07-04

**Revisión final ponytail: −5.2k líneas netas sin cambio de conducta.** Auditoría de over-engineering de todo el proyecto (CLI + marketplace) con `/ponytail` + `/ponytail-review`: workflow de 16 finders × verificación adversarial (135 hallazgos confirmados) → aplicación en 8+6 agentes → segundo gate adversarial de 7 revisores buscando deriva de conducta que los tests no cachan. **204 archivos, +1.9k/−7.1k (neto −5.2k).** Suite 1049→**1099** (helpers de test compartidos + poda de tests redundantes), biome 36→**35 warnings**, tsc limpio. **BREAKING**: se retira la entrada de librería npm (`main`/`types`/`exports` + `src/index.ts` + tipos `domain/{session,project,plugin}.ts`) — el paquete es un CLI puro (bins `agent-workflow`/`aw`), sin consumidores programáticos conocidos; nada del uso por línea de comandos cambia. Bundle `w` **13.2.0** (limpieza de docs de doctrina).

### Removed

- **Entrada de librería npm** (`main`/`types`/`exports` de `package.json`, `src/index.ts`, `src/domain/{session,project,plugin}.ts`, `declaration`/`declarationMap` de tsconfig): re-exportaban tipos con cero importadores en cualqui repo; el `w` skill y las skills sueltas nunca se cargaron como módulo JS. **Breaking** para un hipotético `import … from "@tacuchi/agent-workflow-cli"`.
- `marketplace-codex.json` + su test tombstone y la regla de sync en AGENTS/CLAUDE (marketplace): manifiesto espejo que ningún host consumía (Codex lee `.claude-plugin/marketplace.json`); se recreará como `{url,ref}` si los plugins pasan a repos standalone.
- Docs históricos `docs/agent-workflow-flujos.md` + `docs/guia-artefactos.md` movidos a `docs/archive/` (documentaban el sistema v11 pre-rediseño).

### Fixed

- **Regresión del parser** (hallazgo del gate): `PLUGIN_FLAG_KEYS` era un objeto plano, así que un comando homónimo de un miembro de `Object.prototype` (`hasOwnProperty`, `constructor`, `toString`, …) se tomaba como flag de plugin y se tragaba el token siguiente. Ahora es un `Map` — `aw hasOwnProperty x` vuelve a resolver como comando desconocido. Test de regresión añadido.
- **`mcp dbhub` — error de lectura de `dsn.env`** (gate): un `dsn.env` existente pero ilegible (es un directorio / EACCES / carrera) lanzaba un error fs crudo (`UNHANDLED`) en vez del `DBHUB_LAUNCHER_FAILED` con guía; se restauró el swallow-to-absent envolviendo la lectura en `resolveDsn`.

### Changed

- **Dedup y stdlib en `src/`** (−2.3k líneas): `node:util.isDeepStrictEqual` reemplaza 4 deep-equal a mano (mcp-writer/reader, install-hooks, mcp-config); `structuredClone` por el clon manual de perfil; `node:path.basename`/`node:stream/consumers` donde se reimplementaban. Helpers únicos extraídos: `readWorkspaceBlock` (12 sitios que pegaban el bucle CLAUDE.md→AGENTS.md), `mcp-scope-common` (resolveScopeDir/hint/refusal/error de setup/remove/doctor), `dates.ts` (6 formateadores de fecha local), `hook-common.parseHookPayload` (3 hooks), `runtime/version.ts`, `fail()` (envoltura de error en ~45 sitios), factory `set-branch` (working+qa), `findUpward`/`copyDir` compartidos en la familia install. Mapas `TARGET_ROOTS`-derivados en vez de listas a mano (buildDestByTarget, ALL_TARGETS, USER_COMMANDS_RELPATH, HOST_ORDER).
- **Código muerto eliminado**: emisor MCP de Warp/Oz nunca cableado (~200 líneas), picker `GitFlowActions` de producción-muerta, claves muertas de `theme.ts` (~40%), campos `SessionState`/`ProjectTabData` sin lectores, `GitPort.log`, plumbing de canal `preview` de MCP (aplanado a stable), capa `core-config` del runtime sin productor.
- **TUI**: `useLockWhile`/`useOnMount`/`useListDetailKeys`/`truncateCells`/`toneColor` compartidos reemplazan copias pegadas entre tabs/componentes; el header de sesiones se computa in-process (sin re-spawn de `aw sessions`, se retira `AW_INTERNAL_CALL`). Se quita el hint constante «N backed · 0 pending» (siempre 0; concepto `backed` retirado).
- **`aw self detect-hosts`**: el orden del array `hosts[]` pasa al canónico de `INSTALL_TARGETS` (`agents` sube al índice 2). Solo cambia el orden de un array de diagnóstico; ningún consumidor lo indexa por posición.
- **`mcp dbhub` — parseo de `dsn.env`** unificado con el resto de consumidores de DSN (doctor/connections vía `readBootstrapDsn`): ahora recorta valores y tolera indentación (antes un parser estricto local). Un valor solo-espacios pasa a resolver «no visible» en vez de lanzar dbhub con un DSN basura.
- **Consolidación de fixtures de test**: `class FakeEnv/FakeFs/RealFs/FakeProcess` pegadas en ~50 archivos → 4 helpers en `tests/helpers/` (`fake-env`, `mem-fs`, `real-fs`, `fake-process`), −~1.5k líneas; tests redundantes/subsumidos podados; fixture muerta `sample-workspace-en/` eliminada.
- **Bundle `w` 13.2.0** (docs de doctrina, sin cambio de conducta): refs de `## Source` de roles apuntando a archivos inexistentes → carpeta; `CONCLUSIONS.md#Open`→`## Details`; `Contexto operativo`→`Operating context`; puntero de invariante #6 muerto → chassis §Convergence; dedup de `plan-refine-loop`/`loops`/`exports`/`artifacts` README contra el chasis; plantilla PlantUML fuera-de-contrato eliminada.
- Raíz `CLAUDE.md` de ambos repos reducido a `@AGENTS.md` (import) — fin de la deriva del par byte-idéntico mantenido a mano.

## [19.2.0] — 2026-07-04

**Crush lee skills solo de XDG + revisión integral multi-host.** Revisión de compatibilidad de los 6 hosts (workflow de 34 agentes: 52 checks, 11 hallazgos confirmados adversarialmente) tras el smoke completo del usuario. Hallazgo central, verificado contra `charmbracelet/crush` v0.81.0 (`config/load.go` `GlobalSkillsDirs`): los roots globales de skills de crush son **XDG** — `~/.config/crush/skills` + `~/.config/agents/skills` + ancla + `~/.claude/skills` — en todo OS; **`~/.crush/skills` no se lee jamás** (`.crush/skills` es solo de proyecto). ≤v19.1.0 instalaba el bundle en ese root muerto y crush veía `w` solo por el cross-read de `~/.claude/skills`. La paleta de crush (tab [User], `user:w:*`) quedó verificada como superficie correcta — el filtro es por-tab y abre en [System]. Bundle `w` **13.1.0** (matriz de capacidades de HARNESS.md corregida). Segundo review gate adversarial (15 agentes) sobre el propio fix: 11 confirmados corregidos pre-commit, incluida la ampliación del fingerprint a bundles v14.5–v18.

### Fixed

- **`TARGET_ROOTS.crush` → `~/.config/crush/skills`** (portable: el `home.Config()` de crush es `$HOME/.config` incluso en Windows; `LOCALAPPDATA` es solo un extra legacy). `~/.crush/commands` no cambia — sí es root real de comandos.
- **Migración del root muerto `~/.crush/skills`** en install y uninstall con ownership verificada (`isOwnedBundleDir`): fingerprint del bundle en sus formas históricas — frontmatter `name: w`|`workflow` + manual `harness/HARNESS.md`|`SKILL.md` (v14.5–v18 incluidas) — nunca se borra un dir ajeno por nombre; el root vaciado se poda.
- **Prune de parents vacíos, gated**: el inerte `~/.codex/commands` desaparece al vaciarse; un `~/.claude/commands` vivo ya no puede borrarse con `--skill-only` (el prune solo corre si el legacy child existía y se removió).
- `clean-legacy --target crush` ahora escanea los roots XDG reales (antes solo el muerto + los compartidos).
- `HARNESSES.crush.skillsDirs` refleja los roots XDG (alimenta el resolver de visibilidad).

### Added

- **Guard G8 — contrato de empaquetado multi-host**: pin literal de `TARGET_ROOTS`, simetría de relpaths de wrappers install↔uninstall (asimetría codex documentada) y tabla «Command packaging» de HARNESS.md contra el código.
- **Guard G8b — contención scan⊇roots**: todo install/legacy root de cada target debe estar en la tabla de scan de clean-legacy (la lección v14.5.1, edición tablas).
- `COMMAND_SKILLS_HOSTS` pasa a **fuente única** en `install-targets.ts` — install y uninstall simétricos por construcción — y el sweep `w-*` con ownership queda testeado en los 4 hosts.
- Guard positivo de wrappers claude: `.claude/commands/w/<cmd>.md` passthrough byte-idéntico (antes solo había assert negativo bajo `--skill-only`).

### Changed

- **Limpieza de comentarios** en `src/` y `tests/` (dev-conventions): ~446 comentarios es→en + poda de narración/changelog-style/tombstones en 115 archivos; verificada **comment-only** (código byte-idéntico, 0 violaciones). Los comentarios de constraints/gotchas/invariantes se conservan.

## [19.1.0] — 2026-07-04

**Réplicas gemini para las skills sueltas del motor [Skills].** Las sueltas se materializan en el ancla `~/.agents/skills` con réplica symlink a `~/.claude/skills` — pero Antigravity (agy) **no lee el ancla a nivel usuario** (sus tiers: Workspace `<repo>/.agents/skills` · Global `~/.gemini/antigravity-cli/skills` · Shared `~/.gemini/skills`), así que las sueltas eran invisibles ahí mientras Codex/Warp las veían directo del ancla. Bundle `w` sin cambios (sigue 13.0.0).

### Added

- **Réplica por host generalizada** (`REPLICA_HOSTS`): claude symlink-first como siempre + **gemini copy-siempre** a `~/.gemini/skills` (tier Shared de agy). Copia y no symlink a propósito: el walker de agy no es verificable y `filepath.WalkDir` de Go no sigue symlinks de dir por default — la copia garantiza el descubrimiento.
- **Marker de propiedad `.aw-replica`** en las réplicas copy (contraparte del symlink, que se autentica apuntando a la canónica): install/uninstall/reinstall solo tocan réplicas probadas propias; un dir ajeno homónimo bloquea con `FOREIGN_REPLICA` (ahora por host) y se preserva. Las copias legacy de claude (pre-marker, Windows) se siguen autenticando por el `mode` registrado.
- `MaterializeData.replicas[]` (host/path/mode por réplica); `SkillListItem.replicas.gemini` + render en el detail de la TUI (`agents ✓ · claude ✓ · gemini ✓`). El `mode` registrado sigue siendo el de la réplica Claude: el badge "(copy)" señala SU degradación, no el copy by-design de gemini.

## [19.0.0] — 2026-07-04

**Superficie de comandos multi-host real.** En Codex el `$` popup mostraba los loops internos y ningún comando; OpenCode/Crush además indexaban los internos **cruzado** desde `~/.claude/skills`/`~/.agents/skills`; en Antigravity solo aparecía la skill `w`. Causa raíz verificada contra fuentes (openai/codex tag `rust-v0.142.5` con fact-check adversarial; binario `agy` 1.0.16 + sus docs embebidas): Codex no lee ningún commands dir (custom prompts removidos del runtime) y escanea skills **recursivo** ≤6 niveles; OpenCode/Crush también recursivos; agy **no tiene comandos de usuario** (slash solo de sistema, el TOML muere con Gemini CLI). Bundle `w` **13.0.0** (major en lockstep: manuales internos renombrados). Review gate adversarial de 18 agentes: 14 hallazgos confirmados corregidos pre-commit (incluye 2 high del propio fix). Verificado en disco en los 6 hosts + smoke del usuario en Claude/Codex/Warp/Antigravity.

### Changed (⚠ breaking)

- **Los manuales internos del bundle dejan de llamarse `SKILL.md`**: `loops/*/LOOP.md` · `roles/*/ROLE.md` · `exports/*/EXPORT.md` · `harness/HARNESS.md`. Ningún host — recursivo o no, presente o futuro — vuelve a indexarlos como skills invocables (cierra también el leak cruzado hacia OpenCode/Crush). Superficie canónica = **13 comandos + la skill `w`**. Referencias de doctrina y guard tests actualizados en lockstep.
- **La skill de orientación pasa de `name: workflow` a `name: w`** (Crush rechaza skills cuyo `name` ≠ dir). `BUILTIN_DEFAULT_SKILLS.overview` = `"w"` — un binding explícito `overview = "workflow"` en `skills.toml` debe actualizarse a `"w"`.
- **Murió el flatten de loops en Warp/Oz** (≤v18 exponía loops/exports/roles como skills top-level — violaba la doctrina "un loop no es invocable por nombre"). Reemplazo: **skill-as-command** — cada `commands/<cmd>.md` se sintetiza como skill hermana `w-<cmd>/SKILL.md` (descripción del comando, refs `../` → `../w/`, marker de propiedad) en codex/warp/oz/gemini.
- **Codex ya no recibe `~/.codex/commands/w`** — el dir era inerte (Codex jamás lo leyó; la suposición "Claude + Codex misma convención" era falsa). Se limpia como legacy en install y uninstall.
- **JSON del install**: `flattened_subskills`/`flattened_warnings` → `command_skills`/`command_skills_warnings`.

### Added

- **Wrappers nativos por host** donde sí existe commands dir: gemini `~/.gemini/commands/w/<cmd>.toml` → `/w:<cmd>` (`{{args}}`; queda como compat del **Gemini CLI legacy** — Antigravity lo ignora) · opencode `~/.opencode/command/w/<cmd>.md` → `/w/<cmd>` · crush `~/.crush/commands/w/<cmd>.md` sin frontmatter → palette `user:w:<cmd>`. Claude sin cambios (`/w:<cmd>`).
- **Antigravity CLI (`agy`)**: `gemini` entra a COMMAND_SKILLS_HOSTS — las 13 `w-*` se sintetizan en `~/.gemini/skills/` (su tier *Shared*, junto al bundle); detección con los markers reales `ANTIGRAVITY_CONVERSATION_ID`/`ANTIGRAVITY_PROJECT_ID` (extraídos del binario).
- **Sweep con propiedad verificada**: install/uninstall solo borran dirs `w-*`/`agent-workflow-*` **probados propios** (marker del wrapper sintetizado, o fingerprint del flatten ≤v18: `name` == dir sin prefijo) — los skill roots son namespaces compartidos (ancla `~/.agents/skills`, sueltas) y un dir ajeno jamás se toca. `registerSkill` rechaza el prefijo reservado `w-` (`RESERVED_SKILL_PREFIX`).
- **Guards nuevos**: el único `SKILL.md` del bundle es el raíz (anti-regresión del rename) · `name` raíz == dir de instalación · toda description de comando parsea limpia (`splitCommandDoc` ahora soporta block scalars `>-`/`|` y quoted) · escapes TOML del cuerpo (`"""`, backslash) cubiertos por tests.
- `--skill-only` / `--no-commands` gatean también las skills sintetizadas, en install y uninstall (los wrappers son la superficie de comandos de esos hosts).
- **Canon**: `harness/HARNESS.md` § *Command packaging* con la tabla por host implementada; field research 2026-07 (matriz de descubrimiento comandos/skills por host, con citas a fuente) espejado en el workspace.

### Fixed

- **uninstall barría solo el prefijo viejo `agent-workflow-`** y dejaba huérfanos los `w-*` del modelo actual (bug latente desde el rename del bundle).
- `explainSkipReason` de codex/warp/oz decía "user-level commands install not implemented yet"; ahora explica el modelo skill-as-command real.

## [18.0.0] — 2026-07-03

**Workspace-init mínimo + exports completados** (spec 008 / plan 005 del workspace). El init deja de crear estructura por adelantado (todo nace on-demand desde el CLI), el `.gitignore` pasa a ser propiedad del CLI, `HISTORY.md` por fin se escribe, y la familia `export-*` quedó ejercitada sobre un corpus real con su formato fijado en el canon. Bundle `w` **12.0.0** (major en lockstep: doctrina de init/CHASSIS/exports reescrita). Review gate adversarial de 41 agentes sobre el diff: 17/17 hallazgos confirmados corregidos pre-commit.

### Changed (⚠ breaking)

- **`aw workspace-init` es MÍNIMO**: crea solo `.workflow/sessions/` (marca de activación del contexto operativo), `.workflow/skills.toml`, el bloque `WORKSPACE` y el `.gitignore`. Ya **no** crea las 6 carpetas `docs/*` ni sus `.gitkeep`, ni `docs/logs/`, ni pregenera `.workflow/launch/<alias>/`. Cada `docs/<categoría>` nace on-demand en `aw next-number docs/<cat>`; los artefactos de launch los genera el primer lanzamiento.
- **Re-run de init = reconcile con prune**: poda el scaffold legado (carpetas de taxonomía `.gitkeep`-only, `.gitkeep` sueltos, `docs/logs/` vacía, `.workflow/.lock` liberado/expirado — un lock vivo jamás se toca). `--dry-run` previsualiza el prune read-only (campo `scaffold.pruned`).
- **`aw next-number` crea el directorio destino cuando falta** (campo `created` en el JSON) y gana `--dry-run` (consulta pura, para plan-mode). Resolución de paths absolutos con `isAbsolute` (fix Windows).
- **`aw session-close` upserta la fila de la sesión en `.workflow/HISTORY.md`** (in-process, no-fatal: `history`/`history_error` en el JSON; un lock ocupado no bloquea el cierre). Revierte el desacople deliberado del modelo "internal/light": las sesiones quedan gitignoradas y HISTORY es el registro durable que el bloque anuncia.
- **`.gitignore` CLI-owned completo**: `.workflow/sessions/`, `.workflow/.lock`, `.workflow/processes.json`, `.workflow/launch/`, `docs/logs/` (siempre) + `.claude/settings.local.json*` / `.codex/config.toml*` con fuentes externas (los patrones cubren los `.bak.<epoch>`). El append es block-aware (mergea bajo el header existente, nunca lo duplica) y preserva el EOL del archivo (CRLF intacto).
- **`aw release-data`**: se removió el flag muerto `--skip-content`; un `--source` con alias desconocido ahora es `INVALID_INPUT` exit 1 (antes ok:true con `{error}` embebido).

### Added

- **Launch on-demand**: sin descriptor, el lanzamiento lo genera en el momento (resolver alias→path del bloque); un descriptor legacy pristine con `command:null` se re-detecta (writeIfPristine protege ediciones del usuario); descriptor corrupto = error explícito `corrupt_descriptor` (nunca se regenera encima). La TUI detecta lanzabilidad por stack cuando no hay descriptor y diagnostica siempre vía beginLaunch.
- **`aw release-data --standalone-sql`**: lista los `.sql` sueltos de `docs/scripts` (source B de export-scripts) con `is_rollback` (case-insensitive) y size; `--include-graduated` reconoce el naming moderno `NNN-export-scripts-YYYY-MM-DD` además del legacy (campo `kind`).
- **Backups keep-latest**: los `.bak.<epoch>` de los configs de host se podan al escribir (queda solo el más reciente); mecanismo único compartido entre multiroot y mcp-host-writer.
- **refs de HISTORY**: texto libre y URLs se conservan tal cual en la fila (antes se perdían o mutilaban).
- **Doctrina/canon**: `workspace-init.md` reescrito (mínimo + política de versionado por artefacto + reconcile), CHASSIS documenta el close→HISTORY, las 4 SKILLs de exports fijan `release-data` como enumerador del corpus (no `aw sessions`), plan-mode vía `next-number --dry-run`, mermaid.ink opcional con advertencia de privacidad; banners HISTÓRICO en los análisis pre-rediseño; guard tests nuevos (contrato código↔doctrina de gitignore/init/exports). Formato fino de los 4 exports **fijado** en el canon tras ejercicio real aceptado.

### Fixed

- `--standalone-sql` registrado en `BOOLEAN_FLAGS` del parser (sin esto, el flag se tragaba el token siguiente y desaparecía en silencio).
- El init ya no deja `.workflow/.lock` huérfano de 0 bytes (limpieza al final, respetando el protocolo del marker).

## [17.1.0] — 2026-07-03

### Added

- **`[Skills]` muestra las canónicas fuera del registro como `unmanaged`** (glyph `◈`, pill warn): dirs de `~/.agents/skills` sin entrada en el registro v17 — p.ej. instaladas por el instalador de skills.sh o a mano — con la fuente recuperada en solo-lectura del lock compartido `~/.agents/.skill-lock.json` (`readSkillsShLockSources`; constante única `AGENTS_LOCK_REL`). Fila informativa: el detail lo explica y no ofrece acciones del motor (el guard de ownership las rechaza a propósito). Excluidos del scan: el bundle `w`, su namespace `w-*` del flatten y los nombres legacy (los administra `[Workflows]`); symlinks-a-dir del usuario sí se listan (los hosts los siguen). Con registro ilegible el scan se apaga (nada se etiqueta como ajeno) y un ancla ilegible nunca vacía la tab (best-effort). Una semilla cuyo nombre choca con una canónica existente se oculta (ofrecer Install garantizaría `SKILL_NAME_COLLISION`).
- **7 semillas nuevas** en las recomendadas del `[Skills]` tab, todas verificadas instalables en vivo: `find-skills` (vercel-labs/skills), `ponytail` + `ponytail-review` (DietrichGebert/ponytail), `c4-architecture` + `skill-judge` (softaworks/agent-toolkit), `react-best-practices` (vercel-labs/agent-skills), `grill-me` (mattpocock/skills). Espejadas en el README del marketplace (§ skills externas recomendadas).

## [17.0.0] — 2026-07-03

**Reorganización de la TUI + administrador de skills sueltas** (spec 007 / plan 004 del workspace). Cuatro frentes: MCP a user scope, `[Workflow]`→`[Workflows]` con la administración por host, motor de skills sueltas (modelo skills.sh) y `[Skills]` reescrito sobre él. Cada fase pasó un review gate adversarial multi-agente antes de su commit. **Major** por el cambio de comportamiento de `self mcp`.

### Changed (⚠ breaking)

- **`self mcp` (TUI e interactivo) instala/remueve/diagnostica en el scope de usuario** — el config global por host (`~/.claude.json` · `~/.codex/config.toml` · Warp por plataforma · `~/.gemini/settings.json` · opencode/crush XDG) en vez del `.mcp.json` del workspace. La acción explícita del usuario equivale al consentimiento del guard `global_requires_force`. Los MCP proyecto-scope existentes **no se migran ni se tocan**; `aw mcp setup/remove` (workspace por defecto; `--workspace <dir>` / `--global` con su guard `global_requires_force`) conserva su comportamiento. El estado instalado/drift se evalúa contra los archivos globales.
- **`[Workflow]` → `[Workflows]`** (id interno y atajo `2` estables — prefs sin migración): absorbe la administración por host del bundle `w` que vivía en `[Skills]` (extraída como `HostAdminSection`); el informativo queda en overview de 1 línea + strip compacto de flows (FamilyCards/PhaseCards eliminadas). El tile "hosts" de `[Status]` navega a `[Workflows]`.
- **Remove de conexiones MCP con guard de ownership**: solo borra entradas dbhub (una entrada global homónima del usuario se conserva y se reporta); el legacy-cleanup de `~/.claude/settings.json` aplica el mismo guard.
- Banner de update: aplicar pasó de `i` a `u` (ink despacha cada tecla a todos los handlers activos; `i` chocaba con el atajo de install del empty-state).

### Added

- **Motor de skills sueltas** (`application/self/skills-manager.ts` + registro `~/.agents/.skills-registry.json`): `register` (git `owner/repo`/URL/`file://` con `#ref`, o path local absoluto; cherry-pick cuando la fuente trae varias; encuentra skills anidadas `skills/<categoría>/<skill>`), `install` (canónica `~/.agents/skills/<n>` vía staging+swap con `.bak` restaurable + réplica symlink `~/.claude/skills/<n>`, fallback copia → `mode:"copy"`), `update` (re-fetch del ref registrado; un fallo deja la instalación previa intacta), `reinstall` (repara la réplica offline), `uninstall` (conserva el registro), `remove`. **Guards**: nunca toca dirs que no registró/materializó (protege el bundle `w` y skills de plugins), réplicas ajenas se preservan (symlink verificado por target), registro corrupto aborta mutaciones, `copyDir` no sigue symlinks de repos de terceros, clones sin prompts interactivos (`GIT_TERMINAL_PROMPT=0`).
- **`[Skills]` reescrito** como administrador de sueltas: lista única con badges (`installed`/`registered`/`recommended`) y counts derivados, detail con acciones por estado (Update solo fuentes git), wizard `[a]` fuente → picker → **warning de terceros antes de registrar** (`probeSkillSource`, inspección sin efectos). Semilla: las skills externas recomendadas del README del marketplace (`data/recommended-skills.ts`, espejo con nota de drift).
- `FileSystemPort.symlink/lstat` + adapter (junction en Windows, sin admin); escritura atómica tmp+rename en todos los configs MCP de host (a scope global son archivos vivos).
- Sección **TUI** en el README (tabs + destinos user-scope).

### Fixed

- El test de setup MCP global con `--force` escribía en el **home real** del desarrollador; el scope global ahora resuelve vía `EnvPort.homeDir()` (inyectable) y los tests corren en sandbox.
- Strings de la TUI que citaban `profile.json` donde el archivo real es `mcp-connections.json`.

## [16.2.0] — 2026-07-03

**Ronda 6 del informe 003 (menor, derivada del smoke empírico de la ola 5).** El smoke con modelos débiles reales probó que la cadena de referencias puede cortarse en hop 2 (el loop se lee, el chasis no → sin session, sin CHECKPOINT, sin opciones canónicas del gate, respuestas en inglés a usuarios en español). Fix: cada comando-trampolín gana un bloque **"Hard floor"** inline y autocontenido — mismo patrón del resumen git/BD inline de los loops de código. Bundle `w` 11.1.0 → **11.2.0**.

### Added

- **Bloque "Hard floor — applies even if you read nothing beyond this file"** en los 5 comandos de loop (`quick`, `spec-refine`, `plan-new`, `plan-refine`, `plan-exec`): session-first con el `aw session-create` exacto + contrato del CHECKPOINT · git/BD o write-boundary según el flujo · ask-don't-invent (≤3 + `flow`) · **idioma del usuario**. En `quick`, además las **3 opciones canónicas del gate verbatim** (`Cambiar a SPEC` · `Seguir en quick` · `Recortar alcance`) y "gate antes de cualquier session".
- **Guard G7** en `doctrine-guards` (3 asserts): los 5 comandos llevan el hard floor (marker + `aw session-create --type` + "user's language"); `quick` lleva las 3 opciones verbatim; `spec-new` pinea el idioma del contenido del borrador.

### Changed

- `spec-new`: nota de llenado "contenido del borrador en el idioma del usuario". `fix-git`: línea de idioma user-facing.
- Cargas garantizadas post-bloques (G1 verdes, y midiendo el costo como corresponde): quick 40,1 kB (≤40,5) · plan-exec 39,0 (≤39,5) · plan-refine 42,6 (≤43,0).

Verificación: suite 999/999 (996 + G7). La re-corrida empírica del smoke quedó **parcial** por infraestructura (opencode+flash con stalls intermitentes; cuota free de deepseek agotada) — registrada como pendiente en la tool `weak-model-smoke` del workspace.

## [16.1.0] — 2026-07-03

**Ola 3 del informe 003: contrato de artefactos.** El esquema del `CHECKPOINT` adopta la **forma que los runs reales demostraron** (headings canónicos `Completed` · `Pending / Next` · `Open questions`; `Excluded` y el snapshot máquina del hook quedan como opcionales documentados) con **reglas duras nuevas** en el chasis: *forma fija* (headings exactos de la plantilla, update **in place**, **nunca** duplicar una sección — mata el bug de append detectado en la sesión real 011) y *flip de criterios* (el **convergence gate marca `- [x]`** los `Success criteria` en verde; un criterio sin marcar al `finalize` exige motivo explícito). Los comentarios-guía `<!-- … -->` de las plantillas se **reemplazan** al llenar la sección. Bundle `w` 11.0.0 → **11.1.0**.

### Added

- **Guard G6 — contrato de artefactos** en `doctrine-guards` (3 asserts): headings canónicos + regla no-duplicar en la plantilla CHECKPOINT · el chasis pinea forma-fija y flip · **el template de SESSION del CLI (`renderSessionMarkdown`) y el schema doc concuerdan en headings** (contrato código↔doctrina verificado de verdad).

### Changed

- `artifacts-core/CHECKPOINT.md`: esquema nuevo con § *Contract (hard rules)* — reemplaza los 6 headings que la práctica real nunca usó (Activity/Critical context/Excluded/Pending/Next separados).
- `artifacts-core/SESSION.md` + `templates/session.ts` (CLI) + golden `session-create-exec`: nota del flip ("flips each to [x] at the convergence gate; replace this comment when filling").
- Chasis § *Artifacts as a live log* (regla de forma fija) y § *Convergence / exit* (flip de criterios).

Sin cambios de parsing en el CLI: `status-service` (`## Excluded`) y los readers de checkpoint ya eran tolerantes; el snapshot del hook `checkpoint-write` queda documentado como **dialecto máquina** aparte.

## [16.0.0] — 2026-07-03

**Ola 2 del informe 003: la doctrina del bundle `w` migra COMPLETA a inglés** (44 docs — chasis, políticas, 5 loops, 14 commands, roles, exports, harness, artifacts y READMEs), con **política de idioma por superficie** documentada en `SKILL.md` § *Language policy*: doctrina y headings de esquemas en inglés; TODO lo user-facing (structured-choice, reportes, dashboard, contenido de artefactos y entregables `docs/`, mensajes de commit) en el idioma del usuario (español); labels literales (`Compactar`, `Cerrar`, `Guardar plan`, …) como strings canónicos verbatim; términos de dominio QTC en español. Cierra el hallazgo nº 1 del informe 003 (corpus bilingüe por capas). **BREAKING** para consumidores de la doctrina del bundle: todo el texto normativo cambió de idioma (la semántica es la misma, verificada por los guards migrados en lockstep). Bundle `w` 10.3.0 → **11.0.0**.

### Added

- **Guard G3 — política de idioma** en `doctrine-guards`: cero diacríticos españoles fuera de code fences e inline-code en `skills/w/**.md` (el patchwork bilingüe no puede volver).
- `SKILL.md` § *Language policy (per surface)* — la tabla normativa de qué idioma va en qué plano.

### Changed

- Los pins de los guards migraron en lockstep: `chassis-consistency` (heading instanciado EN), *QUICK escalation contract* ("exceeds a quick" · "NO RESEARCH" · `/PLAN[^\n]*deferred/` · `/accepted escalation|explicit consent/`), G5 (Inherits canónicos EN).
- Token de estado unificado: `inconcluso` → **`inconclusive`** (CONCLUSIONS, chasis y research usaban dos grafías).
- Spanglish eliminado ("keya off" → "keys off", "gamear", "bindea", "soft-suggest" normalizado, …).
- Cargas garantizadas: quick 38,5 kB (acumulado olas 1+2: **−6,5%** vs v15.1.0); corpus del bundle 251,1 kB. Presupuestos G1 sin cambios (quedan con más holgura).

Espejo: `docs/referencias` **permanece en español** como canon de diseño (decisión del usuario) — la correspondencia pasa a ser "diseño ES ↔ runtime EN" por sección.

## [15.2.0] — 2026-07-03

**Ola 1 del informe 003 (claridad para modelos débiles):** la norma del bundle `w` se reestructura a forma imperativa — reglas numeradas, pseudocódigo y fuente única — con dieta de racional y **presupuesto de carga defendido por tests**. Bundle `w` 10.2.0 → **10.3.0**.

### Added

- `## Sequence` (pseudocódigo operativo) en `plan-new-loop` y `plan-refine-loop` — los 5 loops comparten ahora el mismo esqueleto ejecutable.
- **Guards de doctrina** (`tests/unit/doctrine-guards.test.ts`): G1 presupuesto de carga garantizada por flujo (quick ≤40,5 kB, etc. — subir un techo es editar la tabla, nunca drift silencioso) · G2 techos de legibilidad en loops/commands (línea ≤900 chars, oración ≤60 palabras) · G4 presupuesto de descriptions por área · G5 forma canónica exacta del `## Inherits` (mata el parafraseo del motor).

### Changed

- **Regla de continuidad → 6 reglas numeradas** en `SKILL.md` § *Contexto operativo* (fuente única); el chasis referencia en 1 línea — muere la triple declaración con wording distinto.
- **Chasis**: nueva § *Resolución de referencias* (regla global de layouts aplanados — reemplaza el boilerplate "(instalación normal) o …" repetido por link); § *Structured-choice* marcada **regla canónica** (los ~10 restatements de "≤3 + 1 flow" en roles/exports pasan a referencias); ciclo gap-driven en 5 pasos numerados; racional (analogía `/goal`) movido al diseño.
- `## Inherits` de los 5 loops → forma canónica corta (pineada por G5); **descriptions de loops −38%** (490–561 chars); bullets de escalación de `quick-loop` → pasos numerados.
- **Artefactos**: `SESSION.md` y `artifacts/README.md` vuelven a plantilla pura (doctrina por referencia al chasis/raíz); `TECHNICAL-NOTE.md` a esquema mínimo (2,9 kB → 1,1 kB).
- **Roles**: parenteticals de structured-choice → referencia a la regla canónica; secciones `## Source` arqueológicas → puntero al diseño.
- Precisión de contrato CLI: `aw next-number` "devuelve JSON — usá el campo `next`" (antes "solo devuelve el número").

Cargas garantizadas: quick 41,1 → 39,1 kB (−5,0%) · plan-exec −3,9% · spec-refine −4,6%. El recorte mayor llega con la ola 2 (migración EN).

## [15.1.0] — 2026-07-03

**Escalación en vivo QUICK → SPEC.** `quick-loop` gana un **gate de tamaño a la entrada** (corre ANTES de crear la session): si el objetivo excede un quick (≥2 señales claras), pregunta vía structured-choice — `Cambiar a SPEC` (recomendada) / `Seguir en quick` / `Recortar alcance` — y al aceptar la línea de trabajo pasa al flujo SPEC: borrador vía el procedimiento de `spec-new` + `spec-refine-loop` directo, sin re-invocar comandos. La escalación **mid-loop a SPEC** pasa de handoff diferido ("retomar ahí") a la misma transición en vivo tras el `finalize`; **a PLAN queda diferida** como hoy (siembra + puntero). Cambio de pura doctrina (más 1 string espejo de la TUI). Bundle `w` 10.1.0 → **10.2.0**.

### Added

- **Gate de tamaño a la entrada** en `quick-loop` § *Delta QUICK* + § *Sequence*: señales claras (≥2), borderline sigue sin preguntar, un resume no re-dispara; si escala, **no se crea la session quick** (trazabilidad en el `## Origin` del spec y de la session `NNN-<slug>-spec-refine`). **Anti-duplicado**: si ya existe spec/session spec-refine del mismo objetivo, la recomendada pasa a retomar (`/w:spec-refine`) — nunca un segundo borrador.
- **Transición en vivo a SPEC** (compartida por gate y mid-loop): el consentimiento en la structured-choice equivale a invocar el flujo destino (**excepción consentida** a la regla de continuidad, documentada en `skills/w/SKILL.md` § *Contexto operativo*); borrador por el procedimiento single-pass de `spec-new` (reuso documentado allí, regla dura intacta) + carga de `spec-refine-loop` con referencias tolerantes al layout aplanado warp/oz (`../w-spec-refine-loop/SKILL.md`).
- **Guard tests**: `skill-consistency` gana el describe *QUICK escalation contract* (7 asserts: refs dual-layout, targets en disco, gate antes de `create_or_resume`, `Started by` de spec-refine-loop, regla dura de spec-new, asimetría SPEC-vivo/PLAN-diferido, excepción de continuidad en la raíz).

### Changed

- `spec-refine-loop`: segunda vía de arranque (escalación desde quick) + nota de `## Origin` por escalación; `commands/quick.md` (gate + sesión condicional + plan mode), `commands/spec-refine.md`, `commands/spec-new.md`, `skills/w/SKILL.md` (cadena de flujos + regla de continuidad + catálogo), README raíz y TUI (phase card QUICK) alineados al nuevo comportamiento.
- CHANGELOG: restaurados los headers perdidos de `14.12.0` y `14.11.0` (los cuerpos existían sin header, fix cosmético).

## [15.0.0] — 2026-07-03

**BREAKING — retiro de los comandos legacy sin consumidor `history-data` y `compress-checkpoint`.** Decisión de producto que cierra el último resto del informe de auditoría (001 § Ronda 3): el inventario confirmó cero consumidores funcionales (doctrina, hooks, TUI, diseño). `HISTORY.md` lo genera `history-update`; la disciplina de checkpoint vive en `checkpoint-write`/`checkpoint-read`.

### Removed

- **`aw history-data`** + su servicio completo (`history-data-service.ts`, la skill `diagrams` ya lo marcaba legacy descartado).
- **`aw compress-checkpoint`** + `runCompressCheckpoint` y sus tipos/consts en `checkpoint-service.ts` (el resto del servicio queda: lo comparten write/read).
- Entradas de ambos en el help agrupado y en el catálogo del TUI (guard test `help-groups` sigue verde por ambos lados).

## [14.12.0] — 2026-07-02

**Ronda backlog-low de la auditoría integral (cierre del informe): hooks portables a Windows, paths por plataforma, tipo público alineado al registro, TUI sin ruido, y Oz documentado en doctrina.** Tercera y última ronda del informe `docs/reports/001` del hub de diseño (~19 ítems low, cada uno re-verificado contra v14.11 antes de tocar). Bundle `w` 10.0.0 → **10.1.0**.

### Added

- **`aw self namespace --pin <name>`**: pin global del namespace cross-platform vía Node `fs` (valida con el normalizador compartido; JSON `{pinned, path}`). Reemplaza en `hooks.template.json` el único hook que shelleaba (`sh -c` + `$HOME`, no corría en Windows); la TUI usa la **misma** función de escritura (fuente única del path/formato).
- **Doctrina: Oz documentado** en la matriz del harness como familia **Warp / Oz** (existía en el registro y en el flatten, no en doctrina): detección `OZ_RUN_ID` prioritaria, MCP por flag `--mcp` de `oz agent run` (sin archivo de config), sin plugin/hooks (advisory como Warp).

### Fixed

- **`self install-hooks`**: los targets derivan de `INSTALL_TARGETS` (cierra otra instancia de la familia clean-legacy) — gemini/opencode/crush recibían `INVALID_TARGET` genérico; ahora `unsupported` explicativo como codex/warp/oz.
- **`detect-hosts`**: el config dir de Warp se resuelve por plataforma desde el registro (`resolveWarpGlobalMcpPath`) — asumía `~/.warp` también en Linux (`~/.config/warp-terminal`) y Windows (`%LOCALAPPDATA%`).
- **Tipo público `Harness`** (re-exportado por `src/index.ts`): existía un gemelo stale de 3 valores (`'claude'` incluido); ahora re-exporta el canónico del registro (8 hosts).
- **`relFromCwd`** (status): rutas relativas correctas en win32 — comparaba prefijo string con `/` y nunca matcheaba, mostrando rutas absolutas.
- **`history-update --session`** canónico (`--sesion` queda como alias legacy); **hints de export** alineados a los flags reales de sus SKILLs (`--audience`/`--engine`/`--mode` — `--tipo`/`--audiencia`/`--period` no existían).
- **Log diario sin auto-contaminación**: `Logger` gana `enabled` y `main.ts` respeta `AW_INTERNAL_CALL=1`; el spawn re-entrante de `aw sessions` del TUI lo setea (mergeando `process.env`, que `RunOptions.env` reemplaza).
- **TUI**: sección Recent del tab MCP (muerta desde que `McpTab` no recibe `recentEvents`) retirada + 3 módulos huérfanos borrados (`activity-feed`, `data/activity`, `inline-wizard`); los warnings de project-tab (subfetch parcial) ahora se muestran y loguean; cleanup de todos los timers de toasts al desmontar el provider; el update-check del boot degrada a log silencioso sin red (toast solo en recheck manual).
- **Doctrina**: vocabulario capacidad-no-tool en 3 READMEs (el tool `Skill` marcado como binding de Claude Code con puntero a `harness/SKILL.md`); `export-reports` ya no documenta `--period`.

### Notes

- Inventario de comandos huérfanos (decisión de producto pendiente): `history-data` y `compress-checkpoint` sin consumidor funcional (candidatos a deprecar); los otros 6 (`history-update`, `skill-index`, `bootstrap-dsn`, `visibility`, `profiles`, `project-md-upsert`) son agent/manual-facing documentados — se mantienen.
- Marketplace (repo aparte, mismo round): LICENSE AGPL-3.0 íntegro + coherencia de licencias, guía de verificación post-install para OpenCode, referencia rota `conventions-map` corregida, y **tool-builder 1.1.0** (scripts portados de bash a Node `.mjs` single-source + 8 subtests).

## [14.11.0] — 2026-07-02

**Refactor estructural del chasis: motor único `loops/CHASSIS.md` + `loops/CODE-POLICIES.md`, unbundling de quick, flatten Warp/Oz con docs compartidos.** Cierra el diferido mayor de la auditoría integral (informe `docs/reports/002` del hub de diseño: dup re-confirmada + modelo de ahorro corregido). Bundle `w` 9.7.0 → **10.0.0** (reestructura doctrinal mayor).

### Added

- **`skills/w/loops/CHASSIS.md`** (motor común, 20.1 KB): objetivo persistente + verification-first, gap-driven, session única + research inline, structured-choice + control `flow`, compact/resume, artifact-first, numeración, convergence gate, docs/ boundary — antes embebido en `spec-refine-loop` (27.8 KB) y re-narrado 6-8 veces (SKILL.md raíz ×2, loops/README, `## Inherits` de cada heir): ese patrón fabricaba drift.
- **`skills/w/loops/CODE-POLICIES.md`** (doc hermano): git seguro · BD solo-scripts · gate de revisión de cierre — **solo lo cargan `plan-exec-loop` y `quick-loop`**; los loops de documento ya no pagan ~1k tokens/run de políticas que no usan (hallazgo de la verificación post-refactor).
- **Flatten Warp/Oz inyecta los `.md` hermanos compartidos** (`copySharedSiblingDocs`: archivos sueltos no-README del parentDir) en cada copia aplanada `w-<loop>/` — la referencia tolerante de los heirs ("`../CHASSIS.md` o `CHASSIS.md` junto a este archivo") resuelve en ambos layouts sin pisar homónimos.
- **Guard test `chassis-consistency`**: heirs declarados en `## Heirs` ≡ directorios reales de `loops/`, cada heir referencia el chasis, ningún heir re-declara encabezados del motor, CHASSIS sin frontmatter. Cazó un drift real en vivo durante el propio refactor.

### Changed

- **Los 5 loops son heirs puros**: `## Inherits` de 1 línea (referencia tolerante) + deltas propios; `spec-refine-loop` deja de ser "el chasis" (27.8 → 12.2 KB) y su description ya no enumera heirs (mataba de raíz el drift D1: omitía `plan-refine-loop` en el system prompt).
- **Unbundling de quick**: `quick-loop` ya no hereda de `plan-exec-loop` (leía 15.6 KB para usar 4.2 KB de políticas — ahora viven en CODE-POLICIES). Invariantes 4/5 conservan resumen inline en los loops que editan código (hosts advisory no siguen Reads).
- **SKILL.md raíz + README + loops/README + commands/README**: re-declaraciones normativas → punteros al canon (−40% agregado; commands/README era 83% duplicado); README npm ídem.
- **4 mermaids decorativos retirados** (re-dibujaban el pseudocódigo normativo inmediatamente anterior); quedan solo las 6 plantillas load-bearing de `roles/diagrams`.
- **Carga siempre-cargada por run**: quick **−35.1%** (55.3 → 35.9 KB), plan-new −21.7%, plan-refine −19.0%, plan-exec −14.3%, spec-refine +14.9% (paga el framing del motor; las políticas exec ya no). Neto de los 5 flujos: **−17.9% (≈ −10k tokens)**.

### Fixed

- **5 drifts de enumeración** muertos con su clase (la lista canónica de heirs vive solo en el chasis): description/gates del chasis viejo, secciones omitidas en loops/README, `## Inherits` asimétricos, gemelos divergentes del SKILL.md raíz.
- **Comandos instalados**: "(ruta relativa a este archivo)" era literalmente falsa desde `~/.claude/commands/w/` — ahora localización tolerante ("dentro de la skill `w` instalada"); ídem la dependencia plan-refine → plan-new en copias aplanadas.
- Plantilla `SESSION.md` apuntaba `§ Verification-first` al archivo viejo del chasis.



**Ronda backlog-medium de la auditoría integral: MCP host-aware y multi-plataforma, artefactos dumpeables, parser/help para agentes, y TUI con logs y errores observables.** Segunda ronda derivada del informe `docs/reports/001` del hub de diseño (los 18 ítems medium). Bundle `w` 9.6.1 → **9.7.0** (doctrina: delegación git + dump de artefactos + dedup).

### Added

- **`aw session-artifacts --dump [kinds]`**: devuelve `{path, content, size}` por artefacto (`objetivo`, `decisiones`, `conclusiones`, `tasks`, `checkpoint`, `backlog`, `scripts`) — los 4 `export-*` afirmaban delegar esta lectura pero el comando solo devolvía counts y el dump real era código muerto con un filtro de naming legacy (`session\d{3}-`) que jamás encontraba las sessions del modelo nuevo. Las 4 skills export citan ahora el flag exacto.
- **`src/application/mcp-host-paths.ts`**: fuente única de los config globales de OpenCode/Crush para writer + reader + detect-hosts — honra `XDG_CONFIG_HOME`, `CRUSH_GLOBAL_CONFIG`, y Crush en Windows va a `%LOCALAPPDATA%\crush\crush.json` (verificado contra docs oficiales; el registro escribía un archivo que Crush nunca lee).
- **Parser: `BOOLEAN_FLAGS`** — los flags booleanos ya no capturan el siguiente token (`merge-state --all /repo` perdía ambos; `git-flow --dry-run sync` se comía el action); `--path`/`--pattern` pasan a `MULTI_VALUE_FLAGS` y `multiroot`/`code-scan` dejan de re-escanear `process.argv` crudo.
- **TUI: acciones logueadas al log diario** (spec 005): `logger` en `CliContext`; launch/stop/relaunch/remove, git-flow, install/uninstall de skills, save/install/test de MCP y todo toast de error escriben su outcome.
- Tests: +56 (round-trip global XDG por host, `resolveHosts` por harness, dump de artefactos, ramas win32 del adapter con platform inyectada, `selfUninstall` completo, guard de help-groups, `GIT_TERMINAL_PROMPT`).

### Fixed

- **`aw mcp setup/remove/doctor` dentro de Gemini/OpenCode/Crush**: `resolveHosts` especial-caseaba 3 hosts y hacía fan-out a los 6 archivos de config corriendo dentro de los nuevos; ahora mapea data-driven vía `harnessById().mcpHostId` (verificado e2e con env markers).
- **Warp scope global en Linux/Windows**: writer/remover/reader usaban siempre `<scope>/.warp/.mcp.json`; ahora el scope global resuelve el path por plataforma del registro (DEC-W3) — antes se escribía un archivo que Warp nunca lee y `doctor` no podía detectarlo. Los hints globales de setup/remove muestran el path de la plataforma real (antes siempre darwin).
- **Entradas MCP en Windows**: `buildMcpEntry` emite `cmd /c agent-workflow …` en win32 — el bin npm es un shim `.cmd` que los hosts que spawnean sin shell no pueden ejecutar.
- **`openPath` observable**: los fallos de spawn ya no se tragan (ventana de sondeo de 600ms); el TUI muestra el error real y no persiste una app inválida en prefs.
- **git no-interactivo**: `GIT_TERMINAL_PROMPT=0` en todos los comandos git — un push que pedía credenciales colgaba el TUI (solo Ctrl+C).
- **Ayuda global**: `next-number` sale de "Dev-only" (las skills lo usan para los correlativos NNN); `workspace-init`/`skills`/`host-doctor`/`visibility` clasificados (guard test: nada cae en "Other"); el listado muestra `name — glosa` y ~15 describes documentan sus flags; `workflow-content` (TUI) reconciliado.
- **TUI**: acciones stub `s`/`c` del tab Project retiradas (mostraban el id crudo); el fallback de acción desconocida avisa "acción no disponible".

### Changed

- **Bundle `w` 9.7.0**: `roles/git` delega la verificación de rama a `aw check-branch --source` y el inventario de commits a `aw sources` (el git-directo queda como fallback sin workspace) — `plan-exec-loop`/`quick-loop` citan el comando exacto; el bloque "Convenciones ambientes (no roles)" queda canónico en `roles/README.md` (6 copias verbatim → 1 + links).

## [14.9.0] — 2026-07-02

**Ronda de assurance multi-host/multi-OS: los targets se derivan del registro y el lanzamiento JVM funciona en Windows.** Surge de una auditoría integral por dimensiones (hosts · Windows/Linux/macOS · economía de tokens · claridad del CLI · TUI) con verificación adversarial por hallazgo; el informe completo y el backlog priorizado viven en el hub de diseño (`docs/reports/001-report-auditoria-integral-multihost.md`). El patrón de bug dominante era "lista de hosts hardcodeada desincronizada del registro" (la familia del fix `clean-legacy` v14.5.1): reapareció en 4 superficies y se cierra de raíz con una fuente única derivada. Bundle `w` 9.6.0 → **9.6.1** (solo docs).

### Fixed

- **Round-trip install↔uninstall para gemini/opencode/crush**: nuevo `install-targets.ts` (fuente única `TARGET_ROOTS` → `INSTALL_TARGETS`, cycle-free); `self uninstall-skill`, `self install-plugin-skills(-git)` y `self plugin-cache-clear` derivan sus targets de ahí — uninstall acepta los 3 hosts nuevos y `--target all` ya no deja residuo en `.gemini/.opencode/.crush`; plugin-cache-clear acepta los 8 targets (skill-dirs vía `TARGET_ROOTS`, no-op donde no hay cache). Test de round-trip agregado.
- **TUI [Skills] desincronizado de los hosts nuevos**: `BACKED_INSTALL_TARGETS` y `friendlyPath` se derivan de `TARGET_ROOTS` — gemini/opencode/crush dejan de mostrarse "(not wired yet)" y son instalables desde el tab (el backend ya los soportaba).
- **Windows: lanzamiento gradle/maven roto**: el descriptor llevaba el wrapper bash (`./gradlew`) a `run.ps1` y al spawn win32. Nuevo `winLaunchCommand()` (`./gradlew`→`./gradlew.bat`, `./mvnw`→`./mvnw.cmd`), `resolveLaunch()` acepta `platform`, `run.ps1` invoca el wrapper `.bat`, y `needsWinShell()` cubre `.bat`/`.cmd` + `gradle`/`mvn` en `run`/`spawnDetached` (Node ≥20 EINVAL sin shell). Tests con platform inyectada.
- **`--source` silenciosamente ignorado en `release-data` y `check-branch`**: `source` es multi-value en el parser (va a `valuesMulti`) pero ambos leían `values`. Nuevo accessor `flagValue()` en el parser (valuesMulti→values) aplicado también a `git-flow`/`merge-state` (elimina la clase de bug). Tests de regresión.
- **`aw <cmd> -h` ejecutaba el comando**: el parser solo promovía tokens `--` a flags, así que el check de `-h` en main era código muerto (`aw checkpoint-write -h` escribía un checkpoint). `-h` ahora es alias real de `--help`.
- **`session-resume`/`session-artifacts` devolvían exit 0 en not-found**: ahora mapean `session_not_found` al envelope `{ok:false, error:SESSION_NOT_FOUND}` + exit 1, como sus hermanos `session-create`/`session-close` — los loops pueden detectar la sesión inexistente por exit code.
- **TUI: el input "abrir con…" de [Status]→Logs no bloqueaba las teclas globales**: tipear un nombre de app podía cerrar el TUI (`q`), remontar el tab (`r`), cambiar de tab (dígitos) o disparar el update (`i`). Ahora lockea mientras se tipea (patrón de config-tab).

### Changed

- **Bundle `w` 9.6.1 (solo docs)**: las 4 descriptions de loops (`plan-exec`/`plan-new`/`plan-refine`/`quick`) se recortan a ≤1024 chars — cumplen el cap del estándar Agent Skills que el propio `plugin-doctor` exige a terceros y dejan de pagarse dobles en los hosts flatten — con guard test en `skill-consistency` (`DESCRIPTION_MAX` exportado); `--since` se documenta **exclusivo** en las 4 skills `export-*` (el CLI excluye la sesión frontera; el drift decía "inclusive"); las listas de hosts del README/SKILL.md raíz pasan a los 6 arneses; el describe de `release-data` referencia la familia `export-*` (las skills `release`/`release-scripts` ya no existen) y documenta sus flags.

## [14.8.0] — 2026-07-02

**Nada llega a un commit sin revisar: gate de revisión de cierre en los loops que editan código.** `plan-exec-loop` gana un nuevo **Delta 5 — Gate de revisión de cierre**: en cada límite de fase, tras la validación y **antes de proponer los commits de esa fase** (también en un `Cerrar` anticipado), una re-lectura **independiente** del diff aplica las **convenciones ambientes instaladas** (estándares de código/stack, seguridad, revisión de diffs — p.ej. las familias `dev-conventions`/`qtc-conventions` del marketplace, si están en el host) y **corrige** los hallazgos (re-validando la fase) o los **difiere justificados** (`Open questions` + `BACKLOG`). `quick-loop` lo hereda **proporcional** (antes de su único commit). Decisión de modelado deliberada: **NO es un rol** — se evaluó y descartó un rol `conventions`/`rules`/`review`; el workflow **crea el momento** y las skills ambientes lo llenan (auto-descubiertas por `description`), preservando el desacople de la extracción dev-conventions (el workflow sigue sin nombrar ni depender del marketplace). Sin skills de convenciones instaladas, degrada a un checklist genérico mínimo. Solo doctrina — bundle `w` 9.5.0 → **9.6.0**, sin cambios de runtime. Espeja `docs/referencias/` del hub de diseño.

### Added

- **`loops/plan-exec-loop` § Delta 5 — Gate de revisión de cierre (convenciones, pre-commit)**: re-lectura independiente del diff por fase + convenciones ambientes; corregir-y-revalidar o diferir justificado; integridad del gate (nunca debilitar un check para pasar); artifact-first (`CHECKPOINT.Next = "review fase N"`) + verification-first (Success criterion sembrado). El delta *Completitud/cierre* pasa a Delta 6. Sequence y mermaid actualizados; el convergence gate exige "cada fase pasó su gate de revisión antes de commitear".
- **`loops/quick-loop`** — hereda el gate en versión proporcional: re-lectura del diff + convenciones ambientes antes de proponer el único commit.

### Changed

- **Doctrina transversal**: `SKILL.md` (orientación) documenta el gate pre-commit de los loops que editan código; `loops/README` (diagrama chassis/heirs) y los commands `plan-exec`/`quick` lo referencian; `roles/README` registra la decisión "la revisión de cierre NO es un rol" junto a la nota de convenciones ambientes.

## [14.7.0] — 2026-07-01

**Los planes con UI ahora producen design SPECs por pantalla.** La capacidad `ui-design` (built-in `ui-spec`) deja de ser exclusiva del flujo SPEC: cuando el plan **incluye UI**, `plan-new-loop`/`plan-refine-loop` la componen para autorar **design SPECs** — `NNN-SPEC-<SLUG>.md`, un artefacto **por pantalla** (`001-SPEC-MODAL-EXPORT.md`, `002-SPEC-ADMIN-DASHBOARD.md`; numeración local a la sesión) — dentro de su propia sesión de PLAN. Derivan de la sección `## UI spec` del spec si existe; las Tasks UI del plan referencian la ruta del SPEC vigente (fuente de verdad) y `plan-exec-loop` los lee read-only como referencia de diseño. El requirement-spec y el plan siguen siendo documentos (invariante 3 intacta; la grafía `SPEC` MAYÚSCULAS = artefacto desambigua). Solo doctrina — bundle `w` 9.4.0 → **9.5.0**, sin cambios de runtime. Espeja `docs/referencias/` del hub de diseño.

### Added

- **Nuevo tipo de artefacto de sesión: design SPEC** (`skills/w/artifacts/artifacts-design/SPEC.md`): naming (`NNN-SPEC-<SLUG>.md`, local a la sesión, una pantalla por archivo), schema (encabezado de traza + render `ui-spec`) y reglas (referencia del plan = fuente de verdad; deriva de `## UI spec`; promoción solo vía `export-*`).
- **`plan-new-loop` / `plan-refine-loop` § Delta 4** — componen `ui-design` ante el gap *UI sin design SPEC* (nueva fila en la gap taxonomy; el coherence gate exige que cada pantalla/tarea UI trace a su SPEC). En plan-refine, acotado al delta: solo pantallas nuevas/cambiadas, SPEC actualizado en su propia sesión + re-apunta la referencia del plan.
- **`plan-exec-loop` § Reads** — lee los design SPECs referenciados por el plan como referencia de diseño (read-only).

### Changed

- **`roles/ui-spec`** — dos aterrizajes, un solo formato: sección `## UI spec` del spec (SPEC) · design SPECs por pantalla (PLAN). `Composed by` suma los loops de PLAN.
- **Catálogos y READMEs** (`SKILL.md` orientación, `roles/README`, `loops/README`, `artifacts/README`, `README` del bundle): fila `ui-design` actualizada, nota *Inline design (PLAN sessions)*, carpeta `artifacts-design/` indexada, aclaración de la invariante 3 (design SPEC ≠ requirement-spec). La tabla de sesiones `refine` ahora lista también a `plan-refine-loop` como creador (drift preexistente).

### Fixed

Auditoría de consistencia post-cambio (workflow adversarial de 5 dimensiones; 8 hallazgos confirmados, todos corregidos):

- **`artifacts/artifacts-core/SESSION.md`** — el bullet del tipo `refine` omitía a plan-refine-loop como creador y a los design SPECs como artefacto posible (contradecía la tabla autoritativa de `artifacts/README.md`).
- **`loops/plan-refine-loop` § Delta 2** — la enumeración inline de la gap taxonomy reusada omitía el nuevo gap *UI sin design SPEC*.
- **`commands/plan-new.md` / `commands/plan-refine.md`** — no espejaban la nota UI → design SPECs de sus docs de diseño (nueva sección).
- **`commands/README.md`** — el diagrama apuntaba el schema de artefactos a `../workflow-artifacts/` (ruta del repo de diseño, colgada en el bundle) → `../artifacts/`.
- **`commands/workspace-init.md`** — footer "(design spec)" colisionaba con el término ahora reservado *design SPEC*.
- **`README.md` raíz (preexistentes destapados):** omitía `plan-refine-loop` / `/w:plan-refine` en el catálogo de capas, y la lista + matriz de `self install --target` seguía en 5 hosts (faltaban gemini/opencode/crush, soportados desde v14.5.0).

## [14.6.0] — 2026-07-01

**El wizard interactivo `aw self mcp` ahora cubre los 6 hosts, no 3.** El menú (instalar/actualizar), la tabla de estado y las acciones de diagnóstico/eliminación estaban cableados a claude/codex/warp; ahora se derivan del registro de arneses (`FILE_HOSTS`), así que ofrecen y reportan los 6 hosts con config MCP (claude/codex/warp/gemini/opencode/crush) — igual que el comando no-interactivo `aw mcp --host`. Cierra la última asimetría multi-host del CLI (surge de la revisión de compatibilidad). Solo runtime CLI — bundle `w` sin cambios (9.4.0). El tab [MCP] del TUI sigue siendo un flujo de `.mcp.json` de workspace (superficie aparte, sin cambio de alcance).

**Fix pre-existente (v14.5.0) destapado por la review adversarial pre-publish:** el reader de MCP (`readMcpEntry`) leía solo la clave top-level `mcpServers`, pero desde v14.5.0 el writer guarda **OpenCode** y **Crush** bajo la clave `mcp` con shapes propias (opencode: `command` como array + `environment`; crush: `type=stdio`). Por eso el read-back (la tabla de estado del wizard y `aw mcp doctor`) reportaba esos 2 hosts como **no instalados / drift** aun tras un install correcto. El bug estaba latente hasta que este release hizo que el wizard leyera los 6 hosts. Verificado con un round-trip real writer→reader (antes no existía cobertura opencode/crush del reader).

### Fixed

- **Read-back de OpenCode/Crush** (`src/application/mcp-host-reader.ts`): nuevo branch que lee la clave `mcp` con la shape de cada host (opencode: reconstruye `command`/`args` desde el array + `environment`; crush: `command`/`args`/`env` bajo `mcp`), incluida la ruta XDG global. Los otros 4 hosts (claude/codex/warp/gemini) no cambian. Tests nuevos: round-trip real `writeMcpEntry`→`readMcpEntry` para gemini/opencode/crush + assert de estado `si` tras `install-opencode`.

### Changed

- **`self mcp` data-driven** (`src/application/self/mcp-config.ts`): `SelfMcpAction` usa `install-${McpHost}` (template literal); menú, dispatch, `doctor`, `remove` y la tabla de estado se derivan de `FILE_HOSTS` (registro). `SelfMcpConnectionView.instalado` pasa de `{claude_code,codex,warp}` a `Record<McpHost,InstallStatus>`.
- **TUI `mcp-tab`** adapta el rename `instalado.claude_code` → `instalado.claude` (sin cambio de comportamiento; sigue instalando al `.mcp.json` de workspace).

### Tests

- `self-mcp-config`: nuevo caso `install-gemini` (escribe el `settings.json` de Gemini de workspace). `format-connections-table` reescrito para las 6 columnas de host (aserciones por celda, no snapshot posicional).

## [14.5.1] — 2026-07-01

**Fix: `aw self clean-legacy --target all` ahora barre también los 3 hosts nuevos (Gemini/OpenCode/Crush).** En v14.5.0 el soporte multi-host agregó gemini/opencode/crush a los mapas forzados por tipo (`install`/`uninstall`/`detect`), pero el array plano `ALL_TARGETS` de `clean-legacy` quedó con los 5 hosts viejos → `--target gemini|opencode|crush` daba `INVALID_TARGET` y `--target all` no escaneaba sus skill-dirs (`.gemini/skills`, `.opencode/skills`, `.crush/skills`) para limpiar artefactos legacy `qtc-*`/`agent-workflow-manager`. Ahora `ALL_TARGETS` se deriva de las keys del `Record` exhaustivo, así un host nuevo no puede volver a caerse del barrido. Solo runtime CLI — bundle `w` sin cambios (9.4.0). Surge de una revisión de compatibilidad multi-host (CLI + marketplace).

### Fixed

- **`clean-legacy` cubre los 6 hosts** (`src/application/self/clean-legacy.ts`): `ALL_TARGETS` se deriva de `LEGACY_SCAN_PATHS_BY_TARGET` (Record exhaustivo) en vez de un literal desincronizado con su hermano `uninstall`. Nuevo `tests/unit/self-clean-legacy.test.ts` (no había cobertura dedicada → por eso el gap shippeó en v14.5.0).
- **Mensajes de `install-skill`** (`src/application/self/install-skill.ts`): `--target all` y `DEST_EXISTS` interpolan los targets reales en vez de hardcodear la lista vieja de hosts.

## [14.5.0] — 2026-07-01

**El CLI ahora reconoce y sirve 6 hosts, no solo Claude Code: Gemini CLI/Antigravity, OpenCode y Crush pasan de placeholders (`backed:false`) a soporte real, junto con Codex y Warp.** El sistema ya era multi-host en la doctrina (capa de capacidades agnóstica); esta release lo realiza en el runtime. `aw self detect-hosts` ahora lista **8 destinos** (claude/codex/warp/oz/agents + gemini/opencode/crush) con sus dirs de config correctos (XDG para OpenCode/Crush: `~/.config/<host>`), `aw self install-skill --target <host>` instala el bundle en el skill-dir de cada uno (y `--target all` cubre los 7), y `aw mcp setup --host <gemini|opencode|crush>` escribe el MCP con el **esquema exacto de cada host**. Verificado con 889 tests + smoke real del CLI. Bundle `w` 9.3.0 → **9.4.0** (matriz de arnés refrescada a jul-2026). Aditivo — Claude Code sin regresión. La capa de enforcement (hooks) de los plugins del marketplace se portó en paralelo (repo `qtc-plugins-marketplace`).

### Added

- **Registro de hosts (`src/domain/harnesses.ts`)**: specs `HarnessSpec` para **gemini**, **opencode** y **crush** — envMarkers, `mcpHostId`, `globalMcpPaths` por plataforma+canal, `projectMcpPath`, `skillsDirs`, `installTarget`. Uniones `Harness` / `InstallTarget` / `McpHost` extendidas. Antigravity se trata como **alias de Gemini** (reusa `~/.gemini/`).
- **MCP writers por-host** (`src/application/mcp-host-writer.ts`) con el esquema exacto de cada uno: Gemini `.gemini/settings.json` → `mcpServers` (shape Claude-compatible); OpenCode `opencode.json` → `mcp` (`type:"local"`, `command` como array, `environment`); Crush `crush.json` → `mcp` (`type:"stdio"`). Idempotencia, dry-run, backup transitorio y **scope global XDG** (`~/.config/<host>/`) para OpenCode/Crush.
- **`aw self install-skill --target gemini|opencode|crush`** — instala a su skill-dir nativo; `--target all` ahora cubre 7 hosts. `InstallTarget` unificado con `domain/harnesses` (fuente única).
- **`aw self detect-hosts`** — 8 hosts, con override de config-dir XDG para OpenCode (`~/.config/opencode`) y Crush (`~/.config/crush`).

### Changed

- **Fix Codex** (correcciones verificadas vs docs oficiales): `skillsDirs` ahora incluye **`.agents/skills`** (ancla del estándar abierto, primario; `.codex/skills` queda secundario) y `pluginHooksDir` corregido de `codex-hooks` → **`hooks`** (Codex bundlea hooks en `hooks/hooks.json` con env `PLUGIN_ROOT`).
- **TUI** (`src/cli/tui/hosts.ts`): gemini/opencode/crush pasan a `backed:true`; Gemini se etiqueta "Gemini CLI / Antigravity".
- **Bundle `w` 9.4.0**: `skills/w/harness/SKILL.md` refresca la matriz de binding a jul-2026 — 6 arneses (agrega Warp/Crush/Antigravity), fila **enforcement** nueva, celdas `?` cerradas, y el ancla `.agents/skills`.

## [14.4.0] — 2026-07-01

**El CLI/TUI ahora lleva un log operativo propio, global y por día, y el tab [Status] tiene un historial de esos logs para abrirlos rápido.** Antes `agent-workflow.log` estaba declarado pero **nadie lo escribía** (solo `aw logs` lo leía → casi siempre "No log file found"). Ahora cada ejecución de comando `aw` y el arranque del TUI **anexan una línea** al diario global `~/.<ns>/logs/agent-workflow-YYYY-MM-DD.log` (mismo path sin importar desde qué ruta se ejecute — pensado para "probar en otras rutas"). En el tab **[Status]**, la sección **[RECENT]** se reemplaza por **"Logs"**: lista los diarios (más nuevo primero, ruta clara), y al seleccionar uno **Enter** lo abre con el editor de texto por defecto del SO y **`a`** permite **elegir con qué app** (recordando la última). Solo runtime CLI/TUI — el bundle `w` no cambia (9.3.0). Aditivo.

### Added

- **Logging operativo global diario** (productor, antes inexistente):
  - `Logger` (`src/application/logging/logger.ts`) — anexa `<ISO> <LEVEL> <msg>` al diario del día; rotación **por día** (fecha local); **redacción de secretos** (flags `token/secret/password/…` + `Bearer`); **best-effort** (nunca crashea el CLI).
  - `FileSystemPort.appendText` (+ `NodeFileSystem`, crea el dir padre) — antes el port no sabía anexar.
  - `PathsService.userDailyLogFile(date)` → `~/.<ns>/logs/agent-workflow-YYYY-MM-DD.log` (global user-level, prefijo literal `agent-workflow-`).
  - Inyección **transversal** en `src/cli/main.ts`: `logger.info(<comando+args>)` antes del dispatch + outcome/error después, y `tui: open` al abrir el TUI (helpers en `logging/log-events.ts`). Registra **comandos + eventos + errores** (info); debug detallado queda como opt-in.
- **Capacidad cross-platform "abrir archivo externo"**:
  - `open-external.ts` (puro) `buildOpenCommand` — macOS `open -t`/`open -a <App>`, Windows `cmd /c start "" [app] path`, Linux `xdg-open`/`<app>`; unit-testeado por-OS.
  - `ProcessPort.openPath(path, {app?})` (+ `NodeProcess.openPath`) — spawn **detached**, no captura el TTY del TUI; best-effort.
- **Sección "Logs" en el tab [Status]** (consumidor):
  - `src/cli/tui/data/logs.ts` `loadLogs` — lista los diarios de `userLogsDir()` (más nuevo primero, con fecha/tamaño/mtime); best-effort → `[]`.
  - `src/cli/tui/components/logs-section.tsx` `LogsSection` — lista navegable (↑↓), **Enter** = abrir con default del SO, **`a`** = "abrir con…" (input inline, recuerda la última app), **esc** = volver a los tiles; empty-state.
  - 5º stat-tile **"logs"** + patrón "mode" de foco en `status-tab.tsx` (no rompe la navegación de los tiles).
  - `TuiPrefs.lastOpenApp` — persiste la última app usada en "abrir con…".

### Changed

- **`aw logs` unificado al diario global**: lee el diario del día en `~/.<ns>/logs/` y `--clear` limpia **todos** los `agent-workflow-*.log`; la ruta per-workspace `.workflow/logs/agent-workflow.log` queda **obsoleta**.
- **Tab [Status]**: la sección **"Recent"** (activity-feed de sesiones) se **reemplaza** por **"Logs"** (historial de diarios). `app.tsx` carga los logs vía `loadLogs` en lugar de `loadActivity`.

## [14.3.0] — 2026-07-01

**"Lanzar en local" ahora abre una terminal visible que se mantiene abierta (macOS/Linux/Windows), para monitorear el proceso en vivo y detenerlo cerrando la ventana.** Antes el arranque era detached-a-logfile con `windowsHide:true`, lo que en Windows producía el síntoma reportado: una consola que **parpadea y se cierra**. Ahora cada source se lanza en la terminal nativa del OS (Terminal.app · consola de PowerShell · emulador de Linux), y si no hay terminal disponible (headless/SSH/CI) **cae a background+log** como antes. La administración desde el TUI (listar/detener/re-lanzar) se preserva. Solo runtime CLI/TUI — el bundle `w` no cambia (9.3.0). Aditivo, nada breaking.

### Added

- **`ProcessPort.spawnInTerminal`** (`src/ports/process.ts`, adapter en `src/adapters/node-process.ts`) — lanza el proceso en una **ventana de terminal visible y persistente** por-OS:
  - **macOS**: `osascript` → `Terminal.app` corre un wrapper efímero (`do script`).
  - **Windows**: consola de PowerShell propia (`spawn` `detached` + `windowsHide:false` + `-NoExit`); los secretos viajan por `env` heredado, nunca por la línea de comandos.
  - **Linux**: primer emulador disponible por prioridad (`x-terminal-emulator` → `gnome-terminal` → `konsole` → `xfce4-terminal` → `alacritty` → `kitty` → `xterm`), detectado con `which`; requiere `DISPLAY`/`WAYLAND_DISPLAY`.
  - **Fallback**: sin terminal (headless/SSH/CI) → proceso detached + `docs/logs/<src>.log` (semántica anterior).
  - El wrapper *nix usa **job control** (`set -m`) para que la app sea líder de su propio grupo de procesos: tanto cerrar la ventana (trap `HUP`) como el "Detener" del TUI (`killTree` con pid negativo) matan el **árbol completo** (npm→node…). Captura el **PID real** de la app vía pidfile; tee a la vez a la terminal y al log. Módulo puro `src/application/terminal-launch.ts` (constructores por-OS unit-testeados para los 3 sistemas).

### Changed

- **`resolveLaunch` expone `envDelta`** (params + `PROFILE`, aparte del env base) para que el wrapper de terminal pueda **hornear** esas variables (los emuladores no siempre heredan el env: `Terminal.app do script`, `gnome-terminal-server`). El registro de procesos guarda `launchMode` (`terminal` | `background`); el TUI lo muestra como chip por fila y adapta el aviso de lanzamiento ("cerrá la ventana para detener" vs "sin terminal disponible").
- **TUI [Project]** — la sección "Procesos en segundo plano" pasa a **"Procesos lanzados"** (ya no siempre es background); la acción "Lanzar en local" describe "abre una terminal".

## [14.2.0] — 2026-06-30

**Nuevo comando+loop auxiliar `plan-refine`: refina un plan existente in place antes de ejecutar (el gemelo de `spec-refine`, pero para el plan).** Paso **NO obligatorio** del flujo PLAN — `plan-exec` corre cualquier plan, refinado o no. La cadena PLAN pasa a ser `plan-new` · `plan-refine` *(aux)* · `plan-exec`; el modelo queda en **6 comandos de flow / 5 loops**. Aditivo, nada breaking. Plugin `w` 9.2.1 → 9.3.0.

### Added

- **`/w:plan-refine` + `plan-refine-loop`** — comando trampolín (Layer 1) + loop heir del chasis (Layer 2). Refina `docs/plans/PPP-plan-<slug>.md` **in place** cuando surgen cambios antes de ejecutar (nuevos requerimientos, ajustes de alcance, deps/riesgos detectados al releer), sin re-generar el plan desde cero. Reusa la gap taxonomy + el coherence gate de `plan-new-loop`; agrega `## Refinement decisions`/`## Q&A traceability` como **traza** (sin contrato de gating — a diferencia del contrato spec↔plan). Sesión `<slug>-plan-refine` (type `refine`, sin nuevo enum); re-run on-demand + `create_or_resume` como `spec-refine`. **Auxiliar y no obligatorio.**

### Changed

- **Bundle `w` (9.3.0)** — modelo actualizado a **6 comandos de flow / 5 loops**: `SKILL.md` (front matter, diagrama de 3 capas, tabla de flows con PLAN = plan-new · plan-refine · plan-exec, § commands, conteos, convergence-gate list), `commands/README.md` + `loops/README.md` (tablas, ASCII, índices, conteos), la lista "Heredan este chasis" de `spec-refine-loop`, y cross-refs en `plan-new-loop` (plan-refine como paso opcional siguiente) y `plan-exec-loop` (corre planes refinados-o-no). TUI `workflow` tab: la fase PLAN y los slash commands incluyen `/w:plan-refine`.

## [14.1.1] — 2026-06-30

**Re-run de `spec-refine` a demanda (mismo spec, múltiples veces) confirmado y hecho de primera clase; hardening del resolver de sesiones.** El flujo SPEC ya soportaba re-correr `/w:spec-refine` sobre el mismo spec cuantas veces haga falta mientras esté en SPEC (verificado end-to-end: sin gate, `--reopen` idempotente, N ciclos → una sola sesión); esta versión lo **documenta como operación de primera clase** y **endurece** el match de códigos de sesión. Un bugfix + aclaraciones de doctrina (bundle `w`). Nada breaking. Plugin `w` 9.2.0 → 9.2.1.

### Fixed

- **`session-resolver`: match de `--code` con word-boundary.** `resolveSession` hacía `folder.name.startsWith(sessionCode)` sin límite de token, así que un código numérico podía resolver la sesión **equivocada** cuando los prefijos colisionan (`100` → `1000-…` una vez que el contador global pasa 999; `01` → `012-…`). Ahora ancla en el código normalizado con boundary `-` (`code === lookupCode || folder.name === lookupCode || folder.name.startsWith("<lookupCode>-")`), lo que además resuelve códigos abreviados de forma consistente. +4 tests (`session-resolver-code-boundary`).

### Changed

- **Bundle `w` (9.2.1)** — re-run on-demand de spec-refine hecho **de primera clase**: el caso "Ya refinado" (`loops/spec-refine-loop`, `commands/spec-refine`) ahora dice explícitamente que, mientras el flujo siga en SPEC, se puede re-correr `/w:spec-refine` sobre el mismo spec **cuantas veces haga falta** (nuevos requerimientos, cambios de scope, re-lectura), y que `create_or_resume` **reabre** la refine session existente (aunque esté cerrada tras converger) en vez de duplicarla. Se reconcilia la regla de contexto operativo "comando = sesión nueva" con un carve-out de **misma entrada** (`SKILL.md`), y se documenta la detección/reapertura de la sesión cerrada (`aw session-resume --code <NNN> --reopen`; detección con `aw resume-summary --include-recent-closed` o `aw sessions --state all`, ya que `aw sessions` a secas solo lista activas).

## [14.1.0] — 2026-06-29

**Alineación con el estándar abierto Agent Skills (agentskills.io): parser de frontmatter correcto, validación del estándar en `plugin-doctor`, y validación advisory de bindings en `aw skills`.** Deriva del análisis de fuentes externas (mattpocock/skills, skills.sh, agentskills.io, loops.elorm.xyz). Cambios aditivos + una relajación advisory + un bugfix; nada breaking. Plugin `w` 9.1.0 → 9.2.0.

### Added

- **Parser de frontmatter compartido** (`src/domain/skill-frontmatter.ts`): lee block-scalars YAML (`>-`, `>`, `|` con chomping), el mapa anidado `metadata:`, claves con guion (`allowed-tools`) y valores entre comillas. Unifica los dos parsers regex duplicados (`skill-index-service` y `plugin-doctor/skills`) que capturaban `>-` como valor — el bug latente que el análisis de fuentes detectó. `getSkillVersion` lee `metadata.version` con fallback al `version` top-level legacy.
- **`plugin-doctor` valida contra el estándar Agent Skills**: `description` ≤ 1024, `name` ≤ 64 + regex lowercase-guion (sin guion inicial/final ni `--`), y set cerrado de claves top-level (`name`, `description`, `license`, `allowed-tools`, `metadata`, `compatibility`); avisa cuando hay un `version` top-level para moverlo a `metadata.version`.
- **`aw skills` valida los bindings (advisory)**: nuevo `checkInstalledBindings` escanea las raíces estándar de skills (`.claude/.codex/.agents/.warp` × cwd + home) y avisa cuando un rol está bindeado a una skill que no está instalada (eximiendo built-ins). El comando suma `bindingChecks` y fusiona esos warnings — cierra el riesgo del binding-fantasma silencioso.

### Changed

- **`version` de skill ahora es OPCIONAL** (alineado al estándar: vive bajo `metadata.version`). `plugin-doctor` avisa solo si está presente y no es semver. Las skills registradas en `plugin.json` `exportedSkills` siguen requiriendo versión (lo enforce `exported-skills.ts`).
- **Bundle `w` (9.2.0)** — doctrina del chasis (`loops/spec-refine-loop`, heredada por todos los loops): **integridad del convergence gate** (anti-gaming: no aflojar el check/criterio, no debilitar/saltear tests, no asserts triviales, arreglar prod sobre parchear el test; **verificación independiente**: "only command output counts") + **respuesta recomendada por pregunta** en structured-choice. `roles/README.md`: corregido el claim del fallback inexistente (el binding es advisory; verificá con `aw skills`). `plan-exec-loop` description recortada a < 1024.

### Removed

- Warning **"missing version"** de `plugin-doctor` (contradecía el estándar, que hace la versión opcional).

## [14.0.0] — 2026-06-29

**La creación de herramientas sale del workflow a un skill standalone del marketplace; los scripts de arranque por fuente se reubican a `.workflow/launch/`.** La capacidad de crear utilidades auxiliares (antes el rol `tools`, acoplado a `plan-exec`) ahora es la skill ambiente `creating-tools` (plugin `tool-builder` del marketplace `qtc-marketplace`), reutilizable en cualquier momento y auto-descubierta por su `description` — el workflow es **indiferente**, no la bindea. `docs/tools/` queda libre para esas herramientas; los scripts de arranque (feature source-local-run) se mueven a `.workflow/launch/<alias>/` (machine-specific, gitignorado). **Breaking** por la reubicación de launch + el retiro del rol; `workspace-init` migra solo las carpetas legacy. Plugin `w` 9.0.2 → 9.1.0.

### Changed (breaking)

- **Scripts de arranque por fuente reubicados** de `docs/tools/<alias>/` a `.workflow/launch/<alias>/` (descriptor + `run.sh`/`run.ps1`), ahora **gitignorados** (machine-specific, junto a `processes.json` y `docs/logs/`). El TUI ("Lanzar en local") y `remove-source` leen/borran la nueva ubicación. Nuevo helper ns-aware `PathsService.cwdLaunchDir()`.
- **Generación de launch sin gate**: antes la gateaba el rol `tools` (`tools = "off"` la desactivaba); ahora se genera siempre (es liviana y local). `LaunchArtifactsSummary` pierde el campo `toolsRole`.
- **`docs/tools/` ya no se scaffoldea** en `workspace-init` (sale de `DOCS_FOLDERS`): lo crea on-demand la skill `creating-tools`.

### Removed

- **Rol-capacidad `tools`** del sistema de roles (`SKILL_ROLES` 7 → 6: `ui-design`, `sql`, `git`, `research`, `diagrams`, `overview`). La doctrina de autoría de tools se extrajo al skill `creating-tools` del marketplace. El bundle `w` borra `roles/tools/SKILL.md` y actualiza su doctrina (`docs/tools` = zona ambiente, no de flujo PLAN).

### Added

- **Migración automática** en `workspace-init`: mueve las carpetas legacy `docs/tools/<alias>/` de launch (detectadas por un `launch.json` con marker `_generated`) a `.workflow/launch/`, preservando scripts editados; nunca toca carpetas de herramientas creadas (que no llevan ese descriptor).

### Notes

- La skill **`creating-tools`** (plugin `tool-builder`, marketplace) organiza cada herramienta en `docs/tools/<tool>/` con README + código (o puntero al repo) + `runs/<ts>/` (logs por corrida) + `output/`. Vive en el marketplace, no en el CLI; el workflow la aprovecha por auto-discovery.

## [13.1.0] — 2026-06-29

**Nuevo: quitar una fuente del workspace (comando + TUI) + blindaje del flujo de promoción git-flow.** El CLI permitía agregar fuentes (`workspace-init`, aditivo) pero no quitarlas; ahora hay un comando y una acción TUI dedicados que orquestan la remoción completa. Además se fija por test la regla de que la promoción a producción nunca arrastra `desarrollo` hacia `certificacion`. Cambios solo de código; plugin `w` sin cambios (9.0.2).

### Added

- **`aw remove-source <alias>`** — quita una fuente del workspace por completo: detach de la visibilidad multi-root (claude/codex/warp/oz), poda del bloque WORKSPACE (fila de `Fuentes` + entradas de `working_branches`/`qa_branches` en CLAUDE.md y AGENTS.md), detiene los procesos corriendo lanzados desde la fuente, y borra `docs/tools/<alias>`. Idempotente; permite dejar el workspace en 0 fuentes. NO borra el repo del filesystem.
- **Acción TUI [Quitar del workspace]** en el tab Project (detail panel por-fuente, solo fuentes reales — nunca "all sources"), con confirmación y/n y recarga de la vista.

### Changed

- **`to-prod` simplificado**: se quitó un `pull` redundante de la rama destino (ya lo hacía `syncPlan`). Secuencia: alinear con prod → checkout prod → merge work→prod → push prod.
- **`FileSystemPort.remove`** ahora borra archivos **o** directorios (recursivo, idempotente); antes solo archivos.
- **`project-md-upsert`** soporta podar aliases del bloque (`removeAliases`): quita la fuente de `Fuentes` + `working_branches` + `qa_branches`.

### Tests

- **Invariante git-flow**: test-guarda que falla si algún flujo (`sync`/`to-qa`/`to-prod`) mergea la rama qa hacia la rama prod (`desarrollo→certificacion`). Codifica la regla "nunca subir desarrollos en prueba a producción".

## [13.0.2] — 2026-06-29

**Las sesiones de spec/plan ahora llevan slug descriptivo en el folder (`NNN-<slug>-<flow>`).** Pasada de documentación del bundle `w`, sin cambios de comportamiento ni de mecanismo del CLI. Antes los loops de spec/plan creaban folders pelados (`NNN-spec-refine`, `NNN-plan-new`, `NNN-plan-exec`), a diferencia de `quick` (`NNN-<slug>-quick`); ahora todos siguen el mismo patrón autodescriptivo. Plugin `w` 9.0.1 → 9.0.2.

### Fixed

- **Descriptor de sesión de spec/plan** ahora `<slug>-<flow>` (era el flujo pelado): `spec-refine-loop`, `plan-new-loop` y `plan-exec-loop` instruyen pasar `<slug>-spec-refine` / `<slug>-plan-new` / `<slug>-plan-exec`. El `<slug>` sale del doc de entrada del flujo (`docs/specs/NNN-spec-<slug>.md` para spec-refine/plan-new; `docs/plans/PPP-plan-<slug>.md` para plan-exec) → el folder dice de qué trata, no solo qué flujo lo creó.
- Sin cambio de código: el CLI antepone el `NNN` global al descriptor recibido y `session-resolver` matchea por número/prefijo de folder, no por el literal del flujo → las sesiones viejas (`NNN-spec-refine`, …) siguen resolviendo. Solo se actualizaron las skill-docs de los 3 loops (y sus referencias de diseño).

## [13.0.1] — 2026-06-28

**Consistencia del bundle `w` (auditoría skill-creator): des-stalea el README publicado + reconcilia contratos cross-skill.** Pasada de documentación, sin cambios de comportamiento en comandos/flags/output. El README de npm aún describía el catálogo viejo de 10 roles (incluía las convenciones extraídas en 13.0.0); se corrige a 7 + nota "ambientes, no roles". Se reconcilian contratos entre skills que se componen, referencias de diseño renombradas, y afirmaciones de los docs de hooks que sobre-prometían enforcement. Plugin `w` 9.0.0 → 9.0.1.

### Fixed

- **README publicado** des-staleado: catálogo 10 → 7 roles (sin `coding-standards`/`testing`/`writing`, ahora ambientes), `PLANIFICATION` → `PLAN`, y el leak `AskUserQuestion` reframeado como la capacidad *structured-choice* (su binding en Claude Code). Mismo fix `PLANIFICATION` → `PLAN` en la `description` del plugin.
- **Contrato `roles/diagrams` ↔ `export-diagrams`** alineado al diseño: flag `--engine` (no `--diagrams`), default `mermaid` (no structurizr), `--scope data`, output `diagrams.md`.
- **Referencias de diseño** `workflow-skills/` → `workflow-roles/` para los roles (`workspace-init`, `export-scripts`/`export-diagrams`, `tools`); `status`/`fix-git` apuntaban a `workflow-commands/` → `workflow-skills/`; `SKILL.md` source-list suma `workflow-roles/`.
- **`commands/README`**: el schema decía que `allowed-tools` "always includes Skill" — ningún comando lo hace (loops/exports se **leen-y-siguen**); corregido.
- **`hooks/README`** ya no sobre-afirma todo git-safe #5: `git-commit-advisor` solo **avisa** (no bloquea `push`/`--amend`/`--no-verify`/`--force`). Se documenta honesto qué bloquea (#4 `sql-mutation-guard`, rama de #5 `branch-check`) y que los hooks de ciclo de vida son comandos top-level, no subcomandos `hook`. + framing binding-agnóstico.
- Drift menor: `CHECKPOINT` ownership (toda sesión, siempre — invariante #6), descriptions `export-manuals`/`export-reports` (audiencia front-loaded), wording `artifacts/README` ("scripts-only"), `TECHNICAL-NOTE`/`ANALYSIS-FILE`, y la familia TUI Sources/Branches (+`set-qa-branch`/`git-flow`/`merge-state`).

### Added

- **Guard test `skill-consistency.test.ts`**: detecta drift cross-skill (cero `--diagrams` en el bundle; el rol `diagrams` y `export-diagrams` concuerdan en `--engine`/default-mermaid). Cubre el hueco que `skill-audit-grep` (solo refs QTC legacy) no veía.

## [13.0.0] — 2026-06-25

**BREAKING — las convenciones genéricas salen del sistema de roles.** `coding-standards`, `testing` y `writing` dejan de ser **roles** del workflow: ya no se empaquetan en el bundle, no se bindean por `.workflow/skills.toml` y los loops/exports no las componen ni las buscan. Pasan a ser **skills ambientes** que el host (Claude Code) auto-descubre por su `description` y aplica cuando son relevantes — el CLI es **indiferente** y aprovecha cualquier skill útil instalada. Una familia útil vive en el plugin `dev-conventions` del marketplace, pero el CLI **no depende ni referencia** ningún plugin (sigue company-agnóstico, lo enforce `skill-audit-grep`). `git` queda como rol bundle (flow-coupled: verificación de rama, tag `session<NNN>`, merge de `/w:fix-git`).

### Removed

- **Roles `coding-standards`, `testing`, `writing`** del catálogo (`SKILL_ROLES` 10 → 7) y sus skills built-in (`skills/w/roles/{coding-standards,testing,writing}/`).

### Changed

- **Catálogo de roles = solo capacidades workflow-específicas**: `ui-design`, `sql`, `git`, `research`, `tools`, `diagrams`, `overview`.
- Loops (`plan-exec`/`quick`/`spec-refine`) y exports (`manuals`/`reports`) **ya no componen** esas 3 capacidades; la calidad de código/test/prosa la aporta el host por auto-descubrimiento de skills instaladas.
- Docs del bundle (`roles`, `loops`, `exports`, `tools`, `harness`, `SKILL.md`) reframeados a "convenciones ambientes (no roles)". Plugin `w` 8.0.0 → 9.0.0.

### Migration

- Si tu `.workflow/skills.toml` bindea `coding-standards`/`testing`/`writing`, esas líneas ahora se **ignoran** (warning de rol desconocido, no rompe). Instalá las skills equivalentes como standalone (p.ej. el plugin `dev-conventions` del marketplace QTC) y el host las auto-aplica.

## [12.10.0] — 2026-06-23

**Lanzar sources en local (detached) y administrarlos desde el TUI [Project].** `workspace-init` ahora reconoce el stack de cada source y genera, en `docs/tools/<source>/`, un descriptor `launch.json` (máquina-legible, lo lee el TUI) + scripts `run.sh`/`run.ps1` (uso humano directo) parametrizados con las env-vars de su config y los perfiles disponibles. Desde [Project] se puede **Lanzar en local** un source: corre en segundo plano **independiente del TUI** (sobrevive a su cierre), con su salida en `docs/logs/`, y una nueva sección **"Procesos en segundo plano"** lista/administra los procesos (Detener · Re-lanzar · Ver log), reconciliando su estado por liveness al reabrir.

### Added

- **`ProcessPort` lanza/mata procesos detached.** Nuevos `spawnDetached` (Node `detached:true` + `stdio` redirigido al log + `unref` → sobrevive al padre), `killTree` (\*nix: kill por grupo `kill(-pid)` con fallback; Windows: `taskkill /PID <pid> /T /F`) e `isAlive` (`process.kill(pid, 0)`; `EPERM` = vivo). Implementados en `NodeProcess`.
- **Registro persistente de procesos (`process-registry-service`).** `.workflow/processes.json` (gitignored) con `register/list/markStopped/remove`; `list()` **reconcilia** liveness (running → exited si el PID murió; stopped/exited son sticky) y persiste el snapshot. Degrada a `[]` ante un registro corrupto (el TUI nunca crashea por esto).
- **Generación de scripts de arranque en `workspace-init`.** Detección de stack por source (npm/gradle/maven/angular vía marker files) → `docs/tools/<source>/launch.json` (`command`·`args`·`params`·`profiles`·`stack`) + `run.sh`/`run.ps1` con header sentinel/hash. Los params salen de `.env`/`.env.<perfil>` (defaults del `.env` base; secretos enmascarados y **nunca** horneados en archivos versionados) y los perfiles de `.env.<perfil>` / `application-<perfil>.{yml,properties}`. **Idempotente:** re-generar preserva los scripts editados por el usuario (mismatch de hash → skip + aviso). Gateado por el rol `tools` (off → no genera y lo informa). Scaffold de `docs/logs/`.
- **TUI [Project] — lanzamiento + administración.** Acción **"Lanzar en local"** en el panel del source (deshabilitada + hint si no hay descriptor); si el descriptor tiene perfiles/params, un **form** pide perfil + valores (prellenados con defaults; secretos sin persistir). Nueva sección **"Procesos en segundo plano"** (source·perfil·PID·estado·inicio) con **Detener**, **Re-lanzar** (reusa perfil + valores no-secretos) y **Ver log**; tile `procesos`; manejo de **colisión** (lanzar un source+perfil ya vivo advierte y ofrece Re-lanzar; un perfil distinto arranca como proceso separado).

### Changed

- **`.gitignore` de workspace:** `workspace-init` agrega siempre `.workflow/processes.json` y `docs/logs/` (artefactos runtime machine-specific, no versionables).

## [12.9.0] — 2026-06-23

**Contexto Operativo: ruteo de artefactos por workspace/flujo + continuidad inter-turno, con `session-resume --reopen`.** Nueva doctrina de *entrada* que resuelve, en cada prompt, dónde aterrizan los artefactos (SQL/scripts/decisiones) según `¿workspace?` + `¿sesión a continuar?`: en un flujo van a la sesión activa/continuada; en un workspace sin flujo, directo a `docs/` por convención + numeración; sin workspace, comportamiento vanilla. Un prompt sin comando **continúa/reabre la sesión más reciente** en vez de dispersar el trabajo — la cara *inter-turno* del objetivo persistente.

### Added

- **`aw session-resume --code <NNN> --reopen`.** Reactiva una sesión **cerrada** quitando su sentinel `.closed` (sin el flag, el resume sigue siendo read-only). Es la pieza que hace **ejecutable** la regla de continuidad: un prompt sin comando, relacionado, reabre la sesión más reciente para seguir trabajando en ella (sus scripts → su `SCRIPTS.sql`) y re-cerrarla al converger. (Para detectar la más reciente cerrada: `aw resume-summary --include-recent-closed` o `aw sessions --state all`.)
- **Doctrina de _Contexto Operativo_ en el bundle `skills/w/`.** `SKILL.md` gana la sección *Contexto operativo* (matriz `¿workspace?` + `¿sesión?` → ruteo) y la aclaración del **alcance de los invariantes #1/#2** (gobiernan el plano sesión→`docs/`, que solo cruza `export-*`; el authoring directo sin flujo es otro plano, **no** es auto-export). El chasis (`spec-refine-loop`) gana la **continuidad inter-turno** y `quick-loop` el **ejemplo QUICK canónico** (comando = sesión nueva; prompt sin comando = continúa/reabre la misma). Espejo de la doctrina diseñada en las referencias.

## [12.8.0] — 2026-06-23

**Objetivo persistente + verification-first en los loops, tab MCP con instalación al workspace, y fix de corrupción de paths Windows en `workspace-init`.** La doctrina de loops gana el frame *objetivo persistente* (modelado en `/goal`, pero agnóstico) y *verification-first* (TDD generalizado vía `SESSION.Success criteria`); el tab MCP del TUI ahora instala al workspace y guía el registro con test-antes-de-guardar; y `workspace-init` preserva el bloque al reconciliar en vez de corromperlo.

### Added

- **Objetivo persistente + verification-first (chasis de loops).** Un loop es un objetivo persistente que corre hasta que sus `SESSION.Success criteria` —sembrados al inicio (TDD generalizado: tests para código, rúbrica falsable para análisis/diseño)— están en verde. Modelado en cómo se comporta el `/goal` de Claude Code, pero como **doctrina agnóstica** (sin depender de ningún host). Reflejado en `skills/w/` (chasis + heirs + `SKILL.md` + artifacts) y en el tab Workflow del TUI. `quick` gana producir deliverables **no-código** (análisis/diseño).
- **Tab MCP — instalar al workspace + wizard guiado.** El tab expone **Install to workspace** (escribe `.mcp.json` en la raíz) y muestra el estado de instalación real por conexión (installed / drift / registered). El registro/edición es un flujo guiado: alias → DSN (con default sugerido) → review con **test-antes-de-guardar** (opción) → `save + install`.

### Fixed

- **`workspace-init` corrompía workspaces Windows al reconciliar.** Re-correr para reconciliar el schema sobrescribía el bloque desde los args, forzando re-pasar las fuentes por el shell (que se come los backslashes de `C:\Source\…`) → tabla `Fuentes` corrupta + multiroot borrado. Ahora `aw workspace-init` **sin `--source`** lee y **preserva** las fuentes + descripción existentes (reconcilia sin re-pasar nada), y `parseFuentesSpecs` **rechaza** un path con unidad sin separador (`C:Source…`) con un error que sugiere forward-slash.

### Changed

- **Scaffold de `SESSION.md`: `Success criteria` para todos los tipos.** Antes solo se emitía para sessions `research`; ahora es la condición de término (*verification-first*) de cualquier session. El golden de `session-create` lo refleja.

## [12.7.1] — 2026-06-22

**Taxonomía commands / skills / roles + de-stale del tab Workflow.** Refleja en la doctrina del bundle la separación entre comandos de flujo, skills transversales y roles, y corrige contenido viejo del tab Workflow del TUI. Sin cambios de comportamiento del CLI.

### Fixed

- **Tab Workflow del TUI (`workflow-content.ts`):** el flujo se mostraba como `PLANIFICATION` (nombre viejo) en vez de `PLAN`; la lista de slash commands **omitía `/w:fix-git`** (faltante desde 12.6.0); y la descripción del hook `PreCompact` decía `OBJECTIVE` en vez de `CHECKPOINT.md`. Corregidos los tres.

### Changed

- **Doctrina: `/w:status` y `/w:fix-git` como _transversal skills_.** `skills/w/SKILL.md` y `skills/w/commands/README.md` los presentan ahora como categoría propia —skills invocables independientes de flujo, que **no** entran en el conteo «5 comandos de flow / 4 loops»—, alineado con el modelo de diseño (`workflow-skills/` aparte de `workflow-commands/` y `workflow-roles/`). Se siguen empaquetando en `commands/` para que `/w:` los invoque.

## [12.7.0] — 2026-06-22

**Tab Project: fixes de render (Warp/Windows) + paneles de acciones laterales con marco + helper `rowWidth` reutilizable.** Corrige dos defectos de render reportados al usar el TUI en Warp (Mac y Windows) y desacopla la lógica de ancho de fila que estaba triplicada.

### Fixed

- **Columnas desalineadas en el tab Project (Warp/Windows):** el glyph de rama `⎇` (U+2387) no existe en la fuente por defecto de varias terminales (Warp, Cascadia Code) y caía a un fallback de **ancho 2** mientras Ink lo medía como 1 → cada fila con una rama se corría. Se reemplaza por `↳` (U+21B3, presente en la fuente, ancho 1) en `icons.git`/`icons.branch`. Cambio centralizado en `theme.ts` → propaga a Project, header y todo consumidor.
- **Línea en blanco entre filas de SOURCES (panel cerrado):** la lista indenta sus rows con `<Box marginLeft={2}>`, pero ese indent no se descontaba del `widthHint` → cada `ListRow` se construía 2 celdas más ancho que su contenedor → Yoga lo envolvía y metía una línea en blanco (visible solo con el detail panel cerrado; al abrirlo el ancho se achica y desaparecía). Se descuenta vía la constante compartida `SOURCES_ROWS_INDENT`.

### Added

- **`DetailPanel` con marco (`bordered`):** los paneles de acciones laterales (Project / MCP / Skills) ahora se enmarcan con un **borde redondeado** en lugar del separador `│` suelto. El marco se dibuja por fuera del ancho de contenido y se contempla en el cálculo de fila vía `DETAIL_PANEL_ROW_OVERHEAD`, así que no reintroduce el interlineado.

### Changed

- **Helper `rowWidth` compartido:** el cálculo de ancho de fila (`computeRowWidth`) estaba **triplicado** e idéntico en los tabs Project/MCP/Skills. Se extrae a `src/cli/tui/row-width.ts` con un parámetro `indent` explícito (Project pasa el indent de SOURCES; MCP/Skills 0). El wrapper `│ + DetailPanel`, repetido en 4 call-sites, se consolida en `<DetailPanel bordered>`.

## [12.6.0] — 2026-06-22

**`/w:fix-git` (resolvedor de conflictos de merge) + capa agnóstica al arnés + refinamiento de los 3 flujos.** Propaga el rediseño de `docs/referencias` al bundle desplegado `skills/w` y agrega un comando nuevo para resolver merges.

### Added

- **`/w:fix-git` + `aw merge-state`:** comando **transversal** (como `/w:status`) que resuelve conflictos de un **merge en curso** en cualquier repo — identifica origen (theirs) ↔ destino (ours), analiza la intención de ambos lados, resuelve (ours/theirs/combinar/reescribir), pregunta vía *structured-choice* ante ambigüedad/incoherencia y **propone** el commit de merge (git-safe). **Agnóstico al workspace** (no requiere `.workflow/`). `aw merge-state [<path>] [--source <alias>] [--all]` es el inspector read-only (exit 2 si hay merge en curso); reusa `GitPort` + nuevo `mergeOrigin` (`git name-rev MERGE_HEAD`).
- **Capa `harness/` (agnóstica al arnés):** `skills/w/harness/SKILL.md` — catálogo de capacidades + matriz de binding por arnés (Claude Code / Codex / opencode / Gemini / genérico) con degradación elegante. La doctrina referencia **capacidades** (`structured-choice`, `compaction`) en vez de tools concretos.
- **Convergence gate** en los 4 loops: `spec-refine` *analyze gate*, `plan-new` *coherence gate*, `plan-exec` *validación final*, `quick` *validación puntual* (read-only; lo que falla vuelve como gap).

### Changed

- **Rol `git`:** nueva sección *Resolución de conflictos de merge* (3 versiones `:1:/:2:/:3:`, `git log --merge`, structured-choice, propose-then-execute del merge commit, `git merge --abort` como escape).
- **SPEC:** UI pasa a **gap de primera clase** (→ compone `ui-design`); acceptance criteria **estáticos/testables** (validados en plan-exec, progreso en el PLAN); esqueleto draft↔refinado alineado + "marca de refinado" explícita (contrato con `plan-new`); EARS recomendado.
- **`ui-spec` Markdown-only:** se descarta la serialización JSON `Screen`; se conservan estructura, vocabulario y reglas; ejemplos en Markdown.
- **PLAN:** plan rico **escala con complejidad** (secciones `core`/`opt`); trazabilidad criterio→tarea verificada por el gate.
- **Terminología `PLANIFICATION` → `PLAN`**; de-stale del corpus (sin framing del "modelo viejo").
- **Artefactos:** `artifacts-dev/` → `artifacts-exec/`; `TECHNICAL-NOTE` queda como referencia de esquema (absorbido por el plan-doc).

## [12.5.0] — 2026-06-21

**Comando `/w:status` (dashboard del workspace) + ciclo artifact-first + sesiones/artefactos más simples.** Reúne el refinamiento de dogfooding sobre `system-updater` (sesiones y artefactos que reflejen progreso real, no cáscaras vacías) y un comando nuevo para ver el estado del workspace de un vistazo.

### Added

- **`/w:status` + `aw status`:** dashboard read-only de todo el workspace — **qué se hizo / qué falta / qué se descartó** — con fechas relativas en español ("hace 2 días", "ayer en la mañana"). Agrega specs (con preguntas abiertas), plans (tareas hechas/pendientes), sesiones (activas/cerradas) y descartados (BACKLOG `Deferred` + CHECKPOINT `Excluded`). Comando **transversal**: no es un flow, no escribe nada. `aw status` emite JSON con el `relative` ya humanizado; el skill lo renderiza.
- **Humanizador de fechas en español** (`humanize-es.ts`, puro/determinista): `recién`, `hace N minutos`, `hoy/ayer en la {mañana,tarde,noche}`, `hace N días`, `la semana pasada`, `hace N semanas/meses/años`.
- **Ciclo artifact-first** en el chasis de loops (`spec-refine-loop`), heredado por los 4 loops: el artefacto se **siembra con la intención antes** de ejecutar (`CHECKPOINT.Pending`/`Next`) y se **lleva al estado real después** (`Completed`/`DECISION`); `BACKLOG` solo si se difiere.

### Changed

- **Una sola sesión por run** (revierte "una exec session por fase"): `plan-exec` usa una sola sesión; el avance por fase vive en el plan-doc (`- [x]`) + un `CHECKPOINT` único. **Research inline**: `ANALYSIS-FILE`/`CONCLUSIONS`/`SCRIPTS.sql` read-only se escriben en la sesión activa, sin sesión aparte. Cadena spec→plan→exec ≈ 3 sesiones.
- **Spec in-place** (revierte `NNN-spec-refined.md`): `spec-refine` edita `docs/specs/NNN-spec-<slug>.md` mismo (agrega `## Refinement decisions` + `## Q&A traceability`); resume keyado off `CHECKPOINT`.
- **Slug descriptivo** en nombres de documento: `NNN-spec-<slug>.md` / `PPP-plan-<slug>.md`.
- **Plantillas de artefactos más limpias y directas:** quitados los sufijos de andamiaje de los headings (`## Excluded (list):` → `## Excluded`, `## Deferred (text):` → `## Deferred`, etc.) en todo `artifacts/`; esto realinea la doc-plantilla `SESSION.md` con lo que emite `renderSessionMarkdown` y `session-resolver`. SESSION = Objective/Origin/Type (Success criteria solo `research`); BACKLOG sin `Notes` y solo si hay diferidos; CONCLUSIONS/ANALYSIS-FILE enfocados en código; CHECKPOINT como log vivo artifact-first.
- `session-close` ya no fabrica un `BACKLOG` vacío.

### Notes

- `aw status` tolera artefactos legacy con headings `(list):`/`(text):` (match flexible) y trata el `type` de sesión como string opaco; sesiones/specs/plans legacy quedan como históricos, nada se migra. Probe read-only: nunca lanza (workspace sin inicializar → `initialized:false` y colecciones vacías). Suite: **696 tests** + lint(0 errores) + typecheck verde; smoke real `aw status` end-to-end OK.

## [12.4.0] — 2026-06-20

**Fixes de dogfooding: numeración global de sesiones, comandos que cargan su loop, y `spec-new` estrictamente single-pass.** Tres bugs que emergieron arrancando los flujos `/w:*`.

### Added

- `session-create` devuelve el campo `number` (el `NNN` global asignado).

### Fixed

- **Numeración de sesiones global y secuencial (caso C):** las sesiones se numeraban por familia de artefacto (spec 001 → `001-spec-refine`, plan 001 → `001-plan-new`), reiniciando el contador por tipo y colisionando todas en `001`. Ahora `session-create` antepone un `NNN` **global** escaneando todo `.workflow/sessions/` (cualquier tipo); el caller pasa **solo el descriptor** vía `--name`. Resultado: `001-spec-refine`, `002-spec-refine-research-x`, `003-plan-new`, … Un descriptor con un `NNN-` accidental se normaliza (no se duplica el prefijo). Revierte la decisión previa de "folder = `--name` verbatim, sin NNN".
- **Los comandos `/w:*` cargan su loop leyendo el `SKILL.md` (caso B):** `Skill: <loop>` fallaba con "Unknown skill" porque en Claude Code los skills anidados del bundle (`loops/*`, `exports/*`) no son invocables por nombre suelto. Los 4 comandos-loop (`spec-refine`/`plan-new`/`plan-exec`/`quick`) y los 4 `export-*` ahora instruyen **leer y seguir** `../loops|exports/<x>/SKILL.md`. Corregido el claim erróneo en `loops/README.md`.
- **`spec-new` estrictamente single-pass (caso A):** guard duro que prohíbe lanzar workflows/subagentes/research/web — **incluso bajo modos que pidan "siempre un workflow"** (ultracode/max-effort, que el comando pisa). La investigación a profundidad es trabajo de `spec-refine`.

### Changed

- **Convención de naming de sesiones** en el chasis y los heirs: el `<run>` que prefija las sesiones hijas es ahora el **descriptor sin número** (`spec-refine`/`plan-new`/`plan-exec`/`quick`); el `NNN` lo asigna el CLI. El resolver ya soportaba `NNN-descriptor` (resume por descriptor + `## Origin`, no por número reconstruido).

### Notes

- Los folders de sesión son internos/efímeros; el cambio de formato (`<name>` → `NNN-<name>`) **no es breaking** (el resolver acepta ambas formas). Cubierto por `tests/golden/wave1b-write.test.ts` (numeración global cross-tipo + normalización de prefijo). Suite completa: 666 tests verde.

## [12.3.0] — 2026-06-20

**Acciones git-flow por fuente desde el Project tab, estilo MCP.** La lista de SOURCES del Project tab pasa de estática a navegable, y seleccionar una fuente abre un panel lateral de acciones — el mismo patrón de interacción que ya tenía el tab MCP (lista + detalle).

### Added

- **SOURCES navegable + panel lateral de acciones** en el Project tab: ↑↓ recorre las fuentes y ⏎ abre un panel (estilo MCP, reusando `ListRow` + `DetailPanel`) con tres acciones por fuente — **Alinear con PROD** (`sync`), **Enviar a QA** (`to-qa`) y **Enviar a PROD** (`to-prod`). En el panel: ↑↓ navega acciones · ⏎ ejecuta · esc cierra.
- **Fila "all sources"** al final de la lista: aplica cualquiera de las tres acciones a todas las fuentes a la vez (`runGitFlow --all`).
- **Vista de progreso/resultado reutilizada**: al ejecutar, se muestra el resultado paso a paso (se reusa `FlowResultView`); `⏎`/`r` re-ejecuta (resume tras conflicto, replay idempotente) y `esc` vuelve a la lista refrescando el estado git de las fuentes.

### Changed

- **El overlay `f git flow` se reemplazó** por la selección por-fuente en la propia lista. El batch sobre todas las fuentes **no se perdió**: vive ahora en la fila "all sources". Las tres acciones siguen ejecutando el servicio `runGitFlow` existente sin cambios de lógica (mismo motor `sync`/`to-qa`/`to-prod`, mismos guards y pausa-en-conflicto de la 12.2.0).
- `FlowResultView` se exportó desde `git-flow-actions` para reusarse en el Project tab.

### Notes

- Sin cambios en el comando CLI `git-flow` ni en el servicio `runGitFlow`: es un cambio acotado al TUI. Cubierto por `tests/unit/project-tab.test.tsx` (lista navegable + fila all-sources, apertura del panel con las 3 acciones, ejecución de "Alinear con PROD", panel de all-sources).

## [12.2.1] — 2026-06-19

**Fix de `workspace-init` para fuentes externas.** En el modelo hub la carpeta del workspace ≠ la ruta de la fuente, pero el init asumía "fuente única = la fuente ES el workspace". Eso rompía dos cosas con una sola fuente externa (el caso común).

### Fixed

- **Visibilidad por "externa al workspace", no por conteo de fuentes**: una sola fuente externa ahora sí configura `additionalDirectories` (Claude) / `additional_writable_roots` (Codex) + `.gitignore`. Antes se omitía con `sources.length <= 1`. Nuevo predicado `isExternalToWorkspace`; la razón de skip `single_source` pasó a `no_external_sources` (sólo cuando todas las fuentes están dentro del workspace). Beneficio lateral: ir de 2→1 fuente ahora detachea la removida.
- **Detección de stack desde las rutas de las fuentes**, no desde la carpeta del workspace (que es scaffolding vacío). `project-md-upsert` escanea cada fuente y usa la primera detección no vacía; cae al workspace sólo si no hay fuentes/ninguna detectable. Antes siempre rendía "Stack sin detectar" en un workspace hub.

## [12.2.0] — 2026-06-19

**Acciones git-flow por fuente.** Flujos de ramas rutinarios por fuente (sincronizar la rama de trabajo desde la base, promover a QA, promover a prod) — en el Project tab del TUI y como comando CLI, ejecutando git real con pausa en conflicto.

### Added

- **Comando + servicio `git-flow`**: `aw git-flow <sync|to-qa|to-prod> [--source <alias>] [--all] [--target <rama>] [--dry-run]`.
  - `sync`: pull trabajo → checkout principal+pull → merge principal→trabajo.
  - `to-qa`: sync + merge principal→qa + merge trabajo→qa + push qa.
  - `to-prod`: sync + merge trabajo→principal + push principal.
  - **Pausa en conflicto**: se detiene en un merge conflictivo, reporta los archivos, deja el repo mid-merge; resolvés + commiteas y re-ejecutas (replay idempotente — los merges ya hechos son no-op de git). Guards: no corre sobre un merge en curso ni un árbol sucio; los fallos git no-conflicto se reportan. `--all` fail-stop. Nunca `--force`/`--no-verify`/`--amend`.
- **Rama QA por fuente** (`qa_branches`): 3er rol de rama por fuente; `set-qa-branch <alias> <rama>` + `workspace-init --qa-branch alias:rama`.
- **Acciones en el Project tab**: por fuente Actualizar · → QA · → Prod (+ todas las fuentes), con progreso por paso + vista de conflicto.
- `GitPort` extendido con checkout/pull/merge/push + detección de merge en curso.

### Notes

- Incluye también lo de la 12.1.0 (auto-limpieza de artefactos legacy en `self install`); npm salta 12.0.0 → 12.2.0 (la 12.1.0 quedó documentada + tag git, sin release npm propio).

## [12.1.0] — 2026-06-19

**Migración limpia desde la versión vieja.** `self install` ahora elimina automáticamente los artefactos del plugin pre-rename (`agent-workflow`) que quedaban en los hosts y seguían apareciendo junto a los nuevos `/w:*`.

### Added

- **`self install` auto-limpia los artefactos legacy** del target: el SKILL viejo (`~/.<host>/skills/agent-workflow`, `agent-workflow-manager`), el dir de slash commands viejo (`~/.<host>/commands/agent-workflow` → los `/agent-workflow:*`) y, en hosts con flatten (warp/oz), los sub-skills `agent-workflow-*`. Reportado en `cleaned_legacy`. Flag `--keep-legacy` para conservarlos.

### Fixed

- `self uninstall`: corregido el dir de comandos canónico (apuntaba al viejo `commands/agent-workflow`; ahora `commands/w`). Con `--legacy` también elimina el dir de comandos viejo `commands/agent-workflow`.

### Notes

- Para limpiar un host que ya tenía la versión anterior: re-correr `self install --target <host>` (auto-limpia), o `self uninstall --legacy --target <host>` para remover todo lo legacy.

## [12.0.0] — 2026-06-19

**Rediseño completo a un modelo de etapas + loops + artefactos.** Reemplaza el modelo viejo de `session` + flujos `dev/design/analyze` + 4 fases por un harness de 3 capas (comandos `/w:*` → loops que la IA corre enteros → sesiones/artefactos internos en `.workflow/sessions/`) + una zona `docs/` de entregables permanentes. **Cambio mayor con quiebres de API** (comandos, flags y namespace de slash commands).

### Added

- **Flujos nuevos** vía comandos `/w:*`: SPEC (`spec-new` single-pass → `spec-refine` loop → `docs/specs/`), PLANIFICATION (`plan-new` · `plan-exec` → `docs/plans/` + `docs/tools/`) y QUICK (`quick`).
- **`workspace-init`** — bootstrap que unifica los viejos `hub-init` + `project-init` (sin distinción project/hub): scaffolding `.workflow/` + taxonomía `docs/` + bloque `WORKSPACE` + `.workflow/skills.toml`. 1+ fuentes; rama base y de trabajo por fuente.
- **Capacidades enchufables** (`skills.toml`): los loops componen roles (`ui-design`, `sql`, `git`, `coding-standards`, `writing`, `research`, `testing`, `tools`, `diagrams`, `overview`) resueltos por cascada `built-in → ~/.workflow/skills.toml → .workflow/skills.toml`. Comando `aw skills` para inspeccionar bindings.
- **Familia `export-*`** (`export-scripts` · `export-manuals` · `export-diagrams` · `export-reports`) — única vía de promoción artefacto→`docs/`.
- `set-working-branch` — fija la rama de trabajo por fuente en el bloque WORKSPACE.
- Sesiones internas con `SESSION.md` + centinela `.closed`; `session-create --type <research|refine|exec|quick>`.

### Changed

- **Plugin renombrado `agent-workflow` → `w`**: los slash commands ahora se invocan como `/w:*` (antes `/agent-workflow:*`). Bundle de skills movido a `skills/w/`.
- `branch-check` y los resolvers de rama (sources, check-branch, hooks) resuelven la rama de trabajo esperada desde el bloque WORKSPACE (desacoplado de sesiones/flow); estricto.
- README reescrito al modelo nuevo.

### Removed

- Comandos del modelo viejo: `graduate`, `graduation-check`, `phase-detect`, `phase-next`, `auto-plan-decide`, `specialty-choose`, `workflows`, `topic-change-check`, `objetivo-data`, `tasks-data`, `decisiones-list`, `dependencias-list`, `hub-init`, `workspace-mode`, `upgrade-hub-mode` (+ sus servicios).
- Conceptos `Flow` (core/dev/design/analyze), `Phase`, `lite`/`patch`, graduación automática, y `ProjectMode` (hub/project). El bloque del workspace ya no lleva "Mode" ni "Sesiones activas".

### Notes

- El binario (`agent-workflow`/`aw`), el nombre del paquete npm y el namespace de artefactos por defecto (`.workflow/`) **no cambian**. Migración de instalaciones viejas: `self uninstall --legacy` limpia los dirs `agent-workflow`/`agent-workflow-manager` previos; `self install --target <host>` instala el bundle nuevo.

## [11.0.1] — 2026-05-28

**Reglas de moderación anti sobre-análisis en `flow=analyze`** (session002). Frena el `CONCLUSIONS.md` técnico inflado sobre hubs maduros: el output ahora escala con el scope que el stakeholder pidió, no con la madurez del stack. Resuelve el issue `docs/referencias/001`.

### Fixed

- **`specialties/analyze-conclude/SKILL.md` v2.2.0 (modality=technical)**: nueva regla "Moderación primero" — validar contra `OBJECTIVE.question` literal antes de enumerar opciones/decisiones/riesgos; no inventar lo que el stakeholder no planteó; asumir la infraestructura existente como disponible (no rediscutirla como greenfield); opciones solo si hay una decisión genuina pedida; máximo 1 sesión dev derivada por default.
- **`workflows/analyze-workflow/SKILL.md` v2.2.0**: nueva sección "Moderación" (hub maduro ≠ greenfield, agencia ≠ completitud, artefactos canónicos `EVIDENCE`/`FINDINGS`/`CONCLUSIONS` — no inventar `CONSOLIDADO`/`MAPEO`) + caveat en la definición de `modality=technical`.
- **`doctrine/session/SKILL.md` v4.4.0**: bullet transversal en "Reglas generales" apuntando al canon de moderación.

### Notes

- Solo doctrina (markdown en `skills/`); sin cambios en el código del CLI ni en su API pública. Llega a los hosts vía `self install-skill` tras actualizar el paquete.
- Cubre los criterios de aceptación del issue 001 a nivel doctrina (Nivel 1). Niveles 2 (`analyze:lite` en el CLI) y 3 (detección automática de hub maduro) quedan diferidos.

## [11.0.0] — 2026-05-28

**Relicencia de MIT a AGPL-3.0-or-later.** El proyecto pasa a copyleft fuerte: sigue siendo libre y gratuito para cualquiera —incluidas empresas— pero todo derivado que se distribuya, o que se ofrezca como servicio de red, debe permanecer abierto bajo la misma licencia. Impide cerrar el código y revenderlo como propietario.

### Changed

- **Licencia `MIT` → `AGPL-3.0-or-later`.** Nuevo `LICENSE` en la raíz con el texto oficial GNU AGPL v3 (antes faltaba pese a estar declarado en `files`); `skills/agent-workflow/LICENSE` actualizado al mismo texto. Campo `license` actualizado en `package.json` y `.claude-plugin/plugin.json`. Secciones de licencia de `README.md` y `skills/agent-workflow/README.md` reescritas con copyright + resumen en lenguaje claro.

### Notes

- **BREAKING (términos legales):** quien dependa del paquete bajo MIT debe revisar la compatibilidad de AGPL antes de actualizar. Las versiones ≤ 10.5.0 ya publicadas en npm permanecen bajo MIT; el cambio rige solo de 11.0.0 en adelante.
- Usar o ejecutar la CLI no impone obligaciones. El copyleft aplica al distribuir un derivado o exponer una versión modificada como servicio de red; importar el paquete como librería dentro de software propietario sí queda alcanzado por AGPL.
- Único titular del copyright (Jesús Loayza / Tacuchi): relicencia legalmente limpia.
- `.claude-plugin/plugin.json` conserva su versión independiente (7.0.1); solo cambió su campo `license`.

## [10.5.0] — 2026-05-28

**Simplificación de `export-scripts` (skill v4.0.0 → v5.0.0)** y de `sql-rollback-generator` (v2.0.0 → v3.0.0). Session103.

### Changed

- **`exports/export-scripts/SKILL.md` v5.0.0**: numeración continua tras `00-ROLLBACK.sql` (sin gaps por categoría vacía); búsqueda extendida a `docs/scripts/*.sql` standalone (excluye bundles previos `docs/scripts/NNN-export-scripts-*/`); rollback derivado leyendo los forwards ya escritos en vez de `SCRIPTS.sql` original; headers SQL mínimos (1 línea de archivo + 1 línea por sentencia); README de 3 secciones (`Archivos` / `Aplicar` / `Revertir`) — sin resumen ejecutivo, sesiones incluidas, ACT-NNN, plantillas de correo, ni checklist de producción.
- **`standards/sql-rollback-generator/SKILL.md` v3.0.0**: lee los forwards consolidados del bundle en vez de los `SCRIPTS.sql` originales; headers del archivo (2 líneas) y per-sentencia (1 línea); bloque `Fase 5 — Cleanup irreversible` minimal (sin templates `BEGIN; UPDATE … COMMIT;` comentados, sólo una línea por irreversible).
- **`exports/export-scripts/references/readme-template.md`**: de 290 líneas a ~30; sólo 3 secciones canónicas + nota para el AI generador.
- **`exports/export-scripts/references/validations.md`**: de V1-V6 (~280 líneas) a V1 (estructura + numeración continua) + V2 (placeholders), ~50 líneas. V3 (10 secciones obligatorias), V5 (header format), V6 (referencias resolubles) removidas.
- **`exports/export-scripts/references/lexico-tecnico.md`**: lista podada de placeholders vetados.
- **`standards/sql-script-organizer/SKILL.md`**: refs a v5.0.0 + numeración continua; actualizada la sección "Layout del bundle".
- **`commands/export-scripts.md`**: descripción + argumentos alineados a v5.0.0; nuevos flags `--skip-standalone`, `--dry-run`; removidos `--themes`, `--keep-parts`, `--skip-code-scan` (theme-handling y code-scan removidos del default v5).

### Removed (default)

- Capa `por-tema/` por default (la doc legacy queda en `references/theme-handling.md` marcada DEPRECATED).
- Code-scan por default (`references/code-scan-recommendations.md` queda como catálogo opt-in para uso ad-hoc).
- 7 de las 10 secciones del README v4 (resumen ejecutivo, sesiones incluidas, acciones manuales narradas, code-scan, git+ramas, documentación graduada, checklist final).

### Notes

- Bundles generados con export-scripts v3.x/v4.x quedan como histórico — no se migran. Próximas invocaciones producen layout v5.
- BREAKING dentro del comportamiento de skills (no en API del CLI npm): bundles nuevos cambian de layout. Si tooling externo consume la estructura previa, requiere ajuste.

## [10.2.0] — 2026-05-27

**TUI Config tab + alt-screen render model** (session098). Nuevo tab Config para ajustar el comportamiento del TUI, y cambio del modelo de render a buffer alternativo que corrige las líneas huérfanas al cambiar de tab.

### Added

- **Tab Config** (`src/cli/tui/tabs/config-tab.tsx`, tecla `6`): APPEARANCE (accent color) · ON OPEN (initial screen) · WORKSPACE (namespace editable, profile read-only, hosts on/off). Cambios aplican en vivo; `r` resetea todo.
- **Accent configurable** (`src/cli/tui/theme.ts`): `applyAccent()` recolorea el theme in-place (violet/cyan/green/yellow/red) sin tocar los consumidores de `colors`. Persistido en prefs, aplicado en boot y en vivo.
- **Namespace configurable** desde el TUI: edición inline validada (`isValidNamespace`), persistida en `~/.config/agent-workflow/namespace` (el config file que lee `NamespaceResolver`); default `workflow`.
- **Hosts targeting**: toggle on/off por host (pref `disabledHosts`); los deshabilitados salen del cómputo "X/Y hosts covered" del tab Status.
- `TuiPrefsService` ampliado (`accentColor`, `initialScreen`, `disabledHosts`) con validación por campo; cableado al boot del TUI (antes estaba dormido).
- **Componentes reutilizables**: `FocusRow` (`components/focus-row.tsx`) — fila con barra de focus + bg highlight full-width; `useListCursor` (`use-list-cursor.ts`) — navegación ↑↓ clampeada; `useTerminalSize` (`use-terminal-size.ts`) — dimensiones con listener de resize.

### Changed

- **Modelo de render a alt-screen** (`src/cli/tui/run.tsx`): el TUI entra al buffer alternativo (`?1049h`) y lo restaura al salir, con cleanup en `exit`/`SIGTERM`. El frame se acota al alto del viewport (`ScreenFrame` + clip del content box) sólo en TTY real.
- Tab order/keymap derivados de `TABS_LIST` (única fuente) en `app.tsx`; `initialScreen` define el tab inicial (antes hardcoded Status).

### Fixed

- **Líneas huérfanas al cambiar de tab**: un tab alto (Workflow) empujaba líneas al scrollback que Ink ya no podía borrar; al volver a un tab corto quedaban cortadas. El alt-screen + viewport acotado lo elimina.

### Tests

- `config-tab.test.tsx` (render + accent/host/namespace/reset), `focus-row.test.tsx`, `use-list-cursor.test.tsx`. Suite completa verde (677 tests). Scroll interno de tabs altos diferido a backlog (medición de alto natural inviable con `measureElement` bajo clip).

## [10.1.0] — 2026-05-27

**TUI Project/Status tweaks + global refresh + notif fix** (session094). Ajustes visuales y de datos al home TUI; expone `type` de sesión como metadata de primera clase.

### Added

- `r` refresh global: re-monta el tab activo (re-fetch de sus datos) y recarga el shell (header + activity feed). Footer muestra `r refresh`; toast "Refreshing…". Convive con `r`=recheck del banner update (la notif tiene prioridad mientras está visible).
- `SessionEntry.type` (`src/application/session-resolver.ts`): parsea `## Type` (Type/Tipo) del OBJECTIVE. Se serializa en el output de `sessions` (omitido si ausente). Alimenta el meta `tipo · flujo · estado` de los feeds de sesiones.
- Project tab — sección "Recent sessions": lista las sesiones más recientes (por código desc, cap 7) con `tipo · flujo · estado`, reemplazando el feed de commits.

### Changed

- Status tab — "Recent": muestra las últimas 5 sesiones (más reciente primero) con `tipo · flujo · estado`, en vez de commits + 3 activas con timestamps sintéticos.
- Project tab — `SourceRow`: sin la ruta de la fuente; el estado (`in sync`/`N dirty`) va a la izquierda de la rama y el conjunto se alinea a la derecha.
- Project tab — GIT tile: `value` = rama de trabajo, `sub` = rama principal (`base <branch>`) con ahead/behind como sufijo compacto sólo si difiere.
- Project tab — resume migra de `r` a `⏎` (la sección ya anunciaba "⏎ resume"); `r` queda libre para el refresh global.

### Fixed

- Project tab — tile `sessions`: el `total` mostraba sólo las activas (`list({})` filtra a activas por default). Ahora `buildProjectTabData` usa `list({ state: "all" })` → total real (ej. 94) + active correcto.
- Notif update-available: doble ícono ↻ amarillo (el título embebía `↻` y el banner ya antepone el tone-icon `warn`). Removido el embebido → un solo ícono.

### Removed

- `buildActivity` + `ProjectActivityEntry`/`ProjectActivityType` + campo `ProjectTabData.activity` + `activityLimit` (feed commit/HISTORY sin consumidores tras el cambio a recent-sessions). Helpers `formatActivityWhen`/`ACTIVITY_UNIT_SHORT` removidos.

### Tests

- Goldens `sessions-{default,all,closed}.json` + `history-data.json`: agregado `type` para sesiones con `## Type`. Suite completa verde (661 tests).

## [10.0.0] — 2026-05-25

**Major BREAKING — export-scripts layout plano + sql-rollback-generator único** (session092 + session093). Dos refactors agrupados en un único release. (a) auto-plan flow-aware + semantic source counting + host-doctor para `jq` (session092, additive). (b) export-scripts pasa a layout plano cross-session al root del bundle y sql-rollback-generator pasa a un único `00-ROLLBACK.sql` (session093, BREAKING en doctrina). Bundles ya generados con v9.x quedan como histórico.

### Added (session092)

- `src/application/host-doctor-service.ts` + `src/cli/commands/host-doctor.ts` — comando `agent-workflow host-doctor` detecta plugins compatibles instalados (hoy `claude-code-warp`) y warna si falta `jq` en PATH con `install_hint` por OS (`darwin`/`linux`/`win32`). Severidad `warn`, no bloqueante.
- `src/application/auto-plan.ts`:
  - Nueva `countDeclaredSourcesMentioned(text, aliases)` — intersect semántico contra `AW-PROJECT.Fuentes` (corrige falso positivo "22 fuentes mencionadas").
  - Nuevo `AutoPlanOptions { flow, modalidad, declaredAliases }`. `shouldSkipFullPlan` con `flow=analyze → skip` per doctrina (`auto-plan-rules.md:21,49`); `analyze + modalidad=incident → lite`.
  - Nuevo `parseModality` helper.
  - `estimateEtaHours(text, { declaredAliases })` recalibrado: `srcFactor = 1 + 0.25*max(0, min(sources,4) - 1)` con cap (ETA ~8× menos inflada sobre OBJECTIVEs con muchas menciones).
- `src/cli/commands/auto-plan-decide.ts` acepta `--code <NNN>` (deriva flow desde AW-PROJECT.Status) y `--flow <dev|design|analyze>` (override explícito); lee `AW-PROJECT.Fuentes` y pasa `declaredAliases` automáticamente. Retro-compatible: sin flags se comporta como antes (con threshold legacy 3→10 para mitigar el falso positivo histórico).
- `countAcceptanceCriteria` regex bilingüe: acepta `Success criteria` / `Criterios de éxito` además de los headers canónicos previos.
- Tests: `tests/unit/auto-plan.test.ts` +32 cases (bilingual + flow short-circuit + semantic intersect + srcFactor recalibrate). `tests/unit/host-doctor-service.test.ts` +6 cases (jq presente/ausente, marketplace match, fresh install).

### Changed BREAKING (session093)

- `skills/agent-workflow/exports/export-scripts/SKILL.md` v3.1.0 → **v4.0.0**:
  - Layout plano cross-session al root del bundle: `00-ROLLBACK.sql`, `01-DDL-TABLES.sql`, `02-DDL-FUNCTIONS.sql`, `03-DML.sql`, `04-INSERTS.sql`, `README.md`. Categorías vacías se omiten (no archivo vacío).
  - Mapping marker→filename explícito: `@category: 01-ddl-tablas → 01-DDL-TABLES.sql`, `02-ddl-funciones → 02-DDL-FUNCTIONS.sql`, `03-migracion → 03-DML.sql`, `04-inserts → 04-INSERTS.sql`.
  - **Eliminados** (v3.x): `por-sesion/sessionXXX/01-04/forward.sql + .rollback.sql` companions, `por-sesion/<session>/rollback/00-rollback-global.sql` per sesión, `rollback-global.sql` separado al root, `manifest.md` separado (absorbido por `README.md`), `ORDER.md` separado (absorbido por §4 del `README.md`).
  - `--themes` opt-in se mantiene como capa adicional encima del root plano (sin rollback per-tema).
- `skills/agent-workflow/standards/sql-rollback-generator/SKILL.md` v1.0.0 → **v2.0.0**:
  - Output único: `<bundle-root>/00-ROLLBACK.sql` con encadenamiento cross-session orden inverso 04→01 dentro de un `BEGIN; ... COMMIT;` único.
  - Bloque "Fase 5 — Cleanup irreversible" al final, fuera de la transacción, con header `-- WARNING: IRREVERSIBLE`.
  - **Eliminados** (v1.0.0): companions `.rollback.sql` por sentencia, sub-carpeta `<session>/rollback/` per-sesión, archivo `rollback-global.sql` separado.
- `references/readme-template.md` re-escrito: 10 secciones canónicas consolidan informe + índice + how-to-execute en una sola plantilla.
- `references/manifest-template.md` marcado `## Status: DEPRECATED` con puntero a `readme-template.md`; cuerpo histórico conservado para bundles v3.x ya generados.
- `references/validations.md` V1-V6 actualizadas: V1 rechaza artefactos del layout v3.x (`por-sesion/`, `.rollback.sql` companions, `manifest.md`, `ORDER.md`, `rollback-global.sql`); V3 valida las 10 secciones del README único; V4 agrega V4.d (categorías SQL vacías sin referencia).
- `references/theme-handling.md` actualizado: `por-tema/` no duplica rollback ni emite ORDER per-tema; el `00-ROLLBACK.sql` del root es el único punto de verdad.
- `references/lexico-tecnico.md` agrega bloque regex para anti-redundancia v3.x.
- `skills/agent-workflow/standards/sql-script-organizer/SKILL.md` — sección "Layout del bundle" actualizada a v4.0.0 (markers de input siguen siendo `01-ddl-tablas` etc; output canonical UPPERCASE EN).
- `skills/agent-workflow/doctrine/implement/references/rollback-guide.md` — descripción del rollback BD actualizada a v2.0.0 (un solo `00-ROLLBACK.sql`).
- `skills/agent-workflow/commands/export-scripts.md` — argument-hint + ejemplos de output + recursos actualizados.

### Migration notes

- **Bundles v3.x ya escritos** (`docs/scripts/00X-export-scripts-*` con `por-sesion/`, `manifest.md`, `ORDER.md`, `rollback-global.sql`): quedan como histórico. NO se reescriben automáticamente. Si el operador necesita el layout plano para un bundle histórico, regenerar manualmente con `/agent-workflow:export-scripts --sessions <NNN[,NNN]>` (toma siguiente NNN; no sobrescribe el viejo).
- **Sesiones cerradas**: el `SCRIPTS.sql` per-sesión no cambia. El refactor sólo cambia cómo se consolidan en el bundle final.
- **Callers legacy** (`release`, `release-scripts` en deprecation Fase 1): freezan el algoritmo v1.0.0 de sql-rollback-generator. `references/release-rollback.md` marcado LEGACY con tag DEPRECATED.

### Non-goals (no incluido)

- **Sin migración del histórico**: bundles `001-002-003-export-scripts-*` quedan en el repo como histórico. No se reescriben.
- **Sin TS code changes en export-scripts**: el comando es skill-driven (sin módulo TS dedicado). Los cambios son 100% doctrina + templates + sub-skill behavior + adyacentes.
- **Sin cambios en `release`/`release-scripts` legacy**: continúan en deprecation Fase 1; algoritmo congelado en v1.0.0 hasta Fase 2.

## [9.3.0] — 2026-05-25

**Minor — closure cleanup gate + 8º anchor en /rules** (session090). Agrega un gate canónico de calidad pre-commit en la fase closure del lifecycle: entre `graduate` (paso 1) y `propose commits` (M1 / paso 2). El gate inspecciona el diff working-tree por fuente dirty y categoriza hallazgos en 5 grupos (comentarios redundantes, complejidad cognitiva, antipatrones, code smells, código muerto). El bundle `agent-workflow:rules` pasa de 7 a 8 anchors.

### Added (doctrine)

- `skills/agent-workflow/doctrine/session/SKILL.md` §1.5 — sección "Inspección y limpieza pre-commit (closure cleanup gate)". 7 pasos: refresh sources → leer diff → componer `coding-standards` → categorizar → reportar → disparar M13 → aplicar fixes aprobados → re-refresh.
- `skills/agent-workflow/doctrine/rules/SKILL.md` §8 — nuevo anchor `agent-workflow:closure-cleanup`. Frontmatter `description` actualizada (8 anchors); versión 0.2.0 → 0.3.0.
- `skills/agent-workflow/doctrine/session/references/prompts/M13-closure-cleanup.md` — spec literal del prompt M13: N questions tab-por-fuente, 3 opciones (aprobar fixes / sólo reportar / saltar) + Other auto = nota custom.

### Changed

- `skills/agent-workflow/doctrine/session/references/prompts-catalog.md` — Q-must count 11 → 12 (M1..M11 + M13; M12 sigue eliminado por DEC-002). Apéndice C actualizado (último Q-must activo = M13, último Q-should = S8).
- `skills/agent-workflow/commands/rules.md` — descripción y body actualizados a 8 anchors; bullet #8 agregado.
- `skills/agent-workflow/doctrine/migrate/SKILL.md` — detectores y plantilla del upgrade transversal-rules block extendidos a 8 anchors (post-session090).

### Non-goals (no incluido)

- **Sin nuevo subcomando CLI**: el gate es 100% doctrina + composición de `coding-standards` + `redaccion-simple`. No se agrega `agent-workflow code-cleanup` ni equivalente (DESIGN.md DD-2).
- **Sin reemplazo de linters**: el gate complementa ESLint/Spotless/Prettier/Checkstyle; no los suple.
- **Sin refactors estructurales**: mover archivos o renombrar packages queda fuera del gate; aplazar a sesión `## Type: refactor` con Strangler Fig.

### Self-test

El gate corrió en su propio diff antes del commit de release y detectó 2 DRY violations (lista linter/formatter duplicada entre `session` y `rules`; regla "refactor estructural mayor" repetida dentro de `session` §1.5). Ambas corregidas. Validación: el gate identifica issues reales sobre artefactos doctrinarios sin falsos positivos.

## [9.1.0] — 2026-05-24

**Minor — palette como pantalla principal** (session089). Elimina la sidebar fija introducida en v9.0.0 y convierte el command palette en la pantalla principal por defecto al iniciar. La navegación queda unificada en la palette (búsqueda + filter + comandos `Go to X`); las tabs siguen accesibles vía `1`–`5` y `Go to X`.

### Changed (UX)

- **Palette es el home**: al boot la palette aparece left-aligned ocupando el main area (ya no es overlay centrado con border round).
- **Sidebar eliminada**: el panel izquierdo de 24ch (brand + nav + workspace + keymap) se va por completo. Brand + version + workspace context migran a un `HomeHeader` 2-líneas full-width arriba. Keymap global migra a un `HomeFooter` 1-línea abajo, con texto que cambia según contexto (`palette` vs `tab`).
- **`^K` desde un tab vuelve al home palette** (no overlay sobre el tab). `esc` desde palette con filter vacío vuelve al último tab visitado; con filter no-vacío lo limpia.
- **`1`–`5` desde palette navegan directo** al tab correspondiente sin necesidad de filtrar y `⏎`.
- **Alert de update**: el ● rojo que en v9.0.0 vivía junto al label `Status` en la sidebar ahora aparece al lado del comando `Go to Status` en la palette (vía nueva prop `alert?: boolean` en `PaletteCommand`). El alert se computa cuando el usuario visita Status por primera vez — el check `npm view` corre dentro de `StatusTab`, no en el boot global.

### Added

- `src/cli/tui/components/home-header.tsx` — brand + version + workspace context en 2 líneas compactas.
- `src/cli/tui/components/home-footer.tsx` — keymap global contextual (palette vs tab).
- `src/cli/tui/components/tabs-config.ts` — tipos `TabId`, `TabConfig`, `WorkspaceContext`, `KeymapEntry` (origen único, neutros).

### Removed

- `src/cli/tui/components/sidebar.tsx` — eliminado por completo.

### Internal

- `app.tsx` refactor: `activeTab: TabId | null` (default `null`), `paletteOpen: boolean` (default `true`). Layout `flexDirection="column"` con HomeHeader/main/HomeFooter; sin sidebar.
- `mcp-tab.tsx` y `family-card.tsx`: comentarios y constantes de width recalculados (`baseOverhead 36 → 12`, `fallbackColWidth (termCols - 33) → (termCols - 9)`) tras quitar los 24ch de la sidebar.
- `command-palette.tsx`: `borderStyle="round"` + `borderColor` removidos del root Box; `PaletteCommand.alert?: boolean` añadido.
- `tests/unit/tui-app-tabs.test.tsx`: tests actualizados (boot abre palette home; valida `search` + `Go to Status` + brand + version; navegación `2` y `5` valida tabs renderizadas).

## [9.0.0] — 2026-05-23

**Major — TUI simplified redesign** (session087). Implementa el handoff `docs/referencias/design_handoff_tui_simplified/`: layout sidebar 24ch + detail panel 38ch + patrones inline (wizard, confirm). Paleta migrada a mono violet. Resultado más compacto y minimalista que v8.0.0.

### Breaking changes (UX)

- **Paleta migrada a mono violet** (`#a78bfa` accent, `#0c0a14` bg). Reemplaza la paleta sky/slate de v8.0.0.
- **Layout sidebar + main**: la antigua barra superior (Header) y barra inferior (KeymapBar) se consolidan en una **sidebar fija de 24ch** a la izquierda. Tab bar horizontal eliminada — la navegación 1–5 ahora vive en el sidebar nav.
- **FrameBox eliminado**: las secciones ya no van envueltas en cajas con border. Reemplazadas por `SectionHead` hairlines (dot violet + label uppercase + count + hint + right-action) + whitespace.
- **ActionModal eliminado**: las acciones por row ahora viven en un **DetailPanel** a la derecha (38ch) que refleja en vivo el row focuseado. Sin overlay full-screen.
- **InlineWizard reemplaza al wizard modal de MCP add**: las conexiones existentes dimean (`dimColor`) y un bloque wizard inline aparece al final de la lista, con stepper del progreso en el detail panel.
- **ConfirmBanner inline reemplaza ConfirmModal**: la confirmación destructiva (remove connection, uninstall skill) aparece dentro del detail panel como banner border-left 3 err. Sin overlay.
- **Pill (con brackets `[state]`) eliminado**: estados se muestran como texto coloreado sin brackets.

### Added

- **Sidebar component** (`components/sidebar.tsx`, 24ch): brand glyph + version + nav (5 tabs con badge + alert dot) + divider hairline + workspace context (mode + branch + sync + sessions count) + divider + keymap global (`^K palette`, `⏎ open`, `↑↓ navigate`, `? help`, `q quit`).
- **SectionHead component** (`components/section-head.tsx`): reemplaza FrameBox para títulos de sección. Slots `{ dotColor, label, count?, hint?, rightAction? }`. Sin border.
- **DetailPanel component** (`components/detail-panel.tsx`, 38ch): refleja focused row de la lista en vivo. Slots header (glyph + name + meta + state pill) + actions block (focusable rows con `▎⏎ ↻ name`) + footer hints. Variante danger en `err`. Banner override para confirm flow.
- **InlineWizard component** (`components/inline-wizard.tsx`): wizard inline al final de una lista. Border-left accent + step label uppercase + input field con caret `▍` + preview JSON live. Stepper en detail panel (split-view).
- **ConfirmBanner component** (`components/confirm-banner.tsx`): banner inline `▎` border-left 3 err + title err bold + body + `y/n esc` actions. Usado en MCP remove y Skills uninstall.
- **HostCells component** (`components/host-cells.tsx`): Skills coverage visual. 7 cells equi-flex con estado per host (installed accent / backed dim / pending mute dashed warn).
- **QuickActions component** (`components/quick-actions.tsx`): strip por tab al pie de cada main area. Border-top hairline + chips `<key>` accent bold + `<label>` text.
- **ActivityFeed component** (`components/activity-feed.tsx`): filas `when (5ch) · dot tone · text · meta` con tone per row. Consumido por Status (Recent), Project (Recent activity) y MCP (Recent calls).
- **Data layer Activity** (`data/activity.ts`): agregador unificado de eventos. Lee git log + sessions del CLI. Eventos futuros (npm checks, MCP calls, skill installs) deferred — requieren tracking aún no implementado.
- **Workspace context en sidebar**: lee `git branch`, `git status` y count de sessions vía `agent-workflow sessions` en cada carga del TUI.

### Adapted

- **`stat-tile.tsx`**: sin border. Variante focused con `▎` border-left accent + paddingLeft 1.
- **`list-row.tsx`**: variante focused con `▎` accent + glyph slot izquierdo + chevron `›` derecho + `dimmed` prop para wizard backdrop.
- **`phase-card.tsx`**: sin border individual. Layout horizontal flat para consumo por `Session lifecycle` SectionHead con divider vertical `│` entre phases.
- **`family-card.tsx`**: collapsed por default. Layout `▸ name N item1 · item2…`. Expanded `▾ name N` + children indent 4.
- **`page-head.tsx`**: count y desc inline sin brackets (era `<Pill>` antes). Right action via `action` prop.

### Removed

- `components/header.tsx` — info migrada a sidebar.
- `components/tab-bar.tsx` — reemplazado por sidebar nav.
- `components/keymap-bar.tsx` — atajos globales en sidebar, per-tab en quick-actions.
- `components/frame-box.tsx` — reemplazado por SectionHead + whitespace.
- `components/action-modal.tsx` — reemplazado por DetailPanel.
- `components/pill.tsx` — reemplazado por texto coloreado sin brackets.
- `components/confirm-modal.tsx` — reemplazado por ConfirmBanner inline.
- `components/connections-grid.tsx`, `connections-table.tsx`, `sectioned-menu.tsx`, `host-chip.tsx` — sin call sites tras refactor.

## [8.0.0] — 2026-05-23

**Major — TUI redesign handoff impl** (session085). Implementa el handoff `docs/referencias/design_handoff_aw_tui_redesign/`: single-column layouts, ActionModal compartido, Command Palette ⌘K reintroducida, y un nuevo tab Workflow que mapea el harness completo.

### Breaking changes

- **TAB_ORDER reducido de 6 a 5**: `[status, workflow, project, mcp, skills]`. Atajos numéricos cambian: `2` ahora va a Workflow (antes Proyecto), `5` a Skills (antes Plugins).
- **Tab Update eliminada**: la lógica de update check vive ahora como banner accent dentro del Status tab. Atajos `r/i/o` se preservan cuando Status está activa.
- **Tab Plugins eliminada**: información implícita en otros tabs (Skills ya cubre hosts; Workflow ya cubre el catálogo CLI).

### Added

- **Tab Workflow nuevo** (key `2`): mapa educacional del harness. 5 fases del lifecycle (Discover → Start → Plan → Work → Close) con PhaseCards en row · 11 command families con FamilyCards 3-col · 17 slash commands + 5 hooks side-by-side · totales derivados con `.length`/`.reduce` para evitar drift. Data en `data/workflow-content.ts` verificada contra `aw --help` + `skills/agent-workflow/commands/` + `hooks/hooks.template.json`.
- **Command Palette ⌘K / Ctrl+K** (reintroducida tras v7.3.0): filter input + ↑↓ navegación + ⏎ ejecuta + Esc cierra. Catálogo de 14 comandos en 5 categorías (tabs, install, mcp, project, self).
- **Componentes shared nuevos** en `components/`: `<FrameBox>` (refactor de `SectionFrame` con prop `accent`), `<ListRow>` (cursor + icon-box + title/subtitle + meta chips + state pill + chevron — usado por Skills + MCP), `<StatTile>` (clickable con cursor), `<PhaseCard>` + `<FamilyCard>` (Workflow tab), `<ActionModal>` (skills + MCP), `<CommandPalette>`.
- **First-use banner** en Skills cuando 0 hosts instalados: FrameBox accent con CTA `i ▸ Install on Claude` (shortcut directo bypassa modal).
- **MCP Add wizard inline** 2-step con preview JSON live del `profile.json` durante step 2 (DSN env var).
- **Status stat tiles 4-col**: cli · hosts X/7 · hooks armed/off · mcp N db. Tiles `hosts` y `mcp` clickables → navegan con ↑↓/←→ + ⏎. Detecta hooks armed leyendo `~/.claude/settings.json`.
- **MenuAction palette routes**: `install-skill`, `doctor`, `update`, `help`, `mcp` accesibles desde la palette (exit-to-CLI).

### Changed

- **Status tab refactor**: Update banner FrameBox accent arriba (lógica migrada desde update-tab) · 4 stat tiles en row · Skill coverage FrameBox con ProgressLine + chips de hosts.
- **MCP tab rewrite** (640 → 380 líneas): single-column. Header con `a ▸ + add connection`. ListRow per conexión con `<ActionModal>` para 4 acciones (Test/Install/Edit/Remove). Edit re-abre wizard pre-rellenado.
- **Skills tab**: `HostRow` ad-hoc reemplazado por `<ListRow>` compartido. `--force` ahora aplica también a uninstall (era solo install).
- **Project NotInitialized landing**: envuelto en FrameBox accent con título `elegí cómo inicializar`. PageHead con count `no inicializado` tone `warn`.
- **app.tsx**: `TabId` reducido a 5 ids. KEYS_BY_TAB actualizado por tab con PALETTE_HINT (`^K`).

### Removed

- `src/cli/tui/tabs/update-tab.tsx` (190 líneas). Lógica migrada a Status.
- `src/cli/tui/tabs/plugins-tab.tsx` (1014 líneas).
- `tests/unit/tui-update-tab.test.tsx` (referenciaba el tab eliminado).
- `SectionFrame` helper local en `status-tab.tsx` — reemplazado por `<FrameBox>` compartido.

### Tests

641/641 pass (73 test files). `tui-app-tabs.test.tsx` actualizado para nuevo TAB_ORDER.

### Migration

```bash
npm install -g @tacuchi/agent-workflow-cli@8.0.0
agent-workflow self install --target claude --force
agent-workflow self install --target codex --force
```

Si tenías scripts/aliases que dependían de los atajos `5 → Plugins` o `6 → Update`, actualizar a la nueva numeración. Para invocar update ahora: presionar `i` en el Status tab (cuando hay update disponible), o desde la palette `⌘K → "Buscar actualización"`.

## [7.3.1] — 2026-05-22

**Patch — UX polish del TUI**. Refinamientos sobre v7.3.0 en MCP y Skills tras feedback de uso.

### Changed

- **MCP detail**: estado único derivado por connection (`instalado` / `parcial` / `no instalado`) en lugar de 3 líneas separadas por host (Claude Code / Codex / Warp). Pill al lado del nombre comunica el estado.
- **MCP acciones**: composite simplificado similar a Skills. Acciones contextuales:
  - Si `no instalado`: **Instalar** + **Diagnosticar**.
  - Si `instalado`/`parcial`: **Reinstalar** + **Desinstalar** (danger) + **Diagnosticar**.
  - **Instalar/Reinstalar** encadena `install-claude → install-codex → install-warp`; aborta + reporta si alguno falla.
- **MCP nueva conexión**: movida desde el detail panel a una row `+ Nueva conexión` al final del panel de CONEXIONES. Atajo `n` global retirado.
- **Skills HostRow**: cursor `▸` se renderizaba misaligned cuando el row contenía `Pill [hooks]` por flexbox anidado (`Box flexGrow column` envolviendo label + note). Refactor: cursor + label en una caja horizontal, note debajo con `marginLeft=2` matching el label.

### Tests

645/645 verde, sin cambios.

### Migration

```bash
npm install -g @tacuchi/agent-workflow-cli@7.3.1
agent-workflow self install --target claude --force
agent-workflow self install --target codex --force
```

Sin breaking changes. Solo polish del TUI.

## [7.3.0] — 2026-05-22

**Minor — TUI redesign**. Rediseño completo del TUI agent-workflow (Ink/React) inspirado en charmbracelet/crush con paleta azul moderna (sky/slate), marcos por sección, highlight inverse en foco y nuevo tab **Proyecto**. Refactor profundo de MCP/Skills a sub-modos de acciones seleccionables con `↑↓`+`Enter` (sin atajos letra-por-letra).

### Added

- **Tab Proyecto nuevo** (key `2`): data layer en `application/project-tab-data.ts` que agrega git workspace + sources (hub mode) + sesiones activas + pendientes (parseados de `TASKS.md`) + actividad reciente (git log + HISTORY.md tail). Landing condicional cuando no hay bloque AW-PROJECT: opciones seleccionables (`project-init` / `hub-init`) que disparan los comandos CLI al confirmar.
- **Host registry centralizado** (`tui/hosts.ts`): 7 hosts soportados a nivel UI (claude/codex/warp/gemini/opencode/crush/agents) con flag `backed` indicando si el servicio install/uninstall ya los cubre.
- **Componentes shared**: `HostChip`/`HostChipStrip`, `Pill`, `PageHead`, `ToastStack` + `useToasts` hook, `TuiPrefsService` para densidad persistida.
- **MCP actions sub-mode**: `↑↓` navega conexiones, `Enter` entra a `actions`; en actions `↑↓` navega lista (Install Claude/Codex/Warp / Doctor / Eliminar / Nueva) y `Enter` aplica.
- **Skills actions sub-mode**: igual patrón. Acciones contextuales (Instalar/Reinstalar + Desinstalar si instalado). Internamente encadena `clean-legacy → clean-cache → install` (install) y `uninstall → clean-cache` (uninstall).
- **Plugins**: filtros (Todos/Instalados/Faltantes/Multi-host) + búsqueda incremental (`/`).
- **Update**: card "VERSIÓN" + "ACCIONES", auto-check al montar, comparación actual → última.

### Changed

- **Paleta visual**: azul/celeste moderno (`#0ea5e9` accent, slate text/borders, emerald/amber/red/cyan semánticos) reemplaza pink/magenta.
- **TabBar**: tab activa con `inverse` highlight (chip resaltado) en vez de chevron + brackets.
- **MCP detail panel**: nombres completos de hosts (Claude Code / Codex / Warp) con `✓`/`✗` en lugar de glyphs `C/X/W`.
- **MenuAction**: extendido con `project-init` y `hub-init`. `dispatchMenuAction` los routea a `project-md-upsert --init` y `hub-init` CLI commands.

### Removed

- **Command Palette** (Ctrl+K). El catálogo ya no aporta sobre tabs claras + acciones seleccionables; quita ruido.
- **Skills "Todos los hosts"** y atajos `i`/`u` directos en Skills. Reemplazados por sub-mode actions.
- **Hosts soportados card** del Status tab. Información reubicada en cada tab que la necesita.

### Tests

645/645 verde. Tests TUI actualizados: tab-bar acepta el inverse wrap con regex; skills-tab adapta a la lista sin "Todos los hosts"; update-tab al formato minimal.

### Migration

```bash
npm install -g @tacuchi/agent-workflow-cli@7.3.0
agent-workflow self install --target claude --force
agent-workflow self install --target codex --force
```

Sin breaking changes en comandos CLI; el TUI cambia layout y atajos (sin Ctrl+K, sin i/u en Skills).

## [7.2.1] — 2026-05-22

**Patch — Cleanup residual `qtc-*` post-smoke Codex v7.2.0**. El bulk sed de v7.2.0 buscó `qtc-*` (literal con asterisco) y dejó pasar refs no-asterisco (`qtc-session`, `qtc-dev`, `qtc-design`, `qtc-analyze`) que el smoke en `~/.codex/skills/agent-workflow/` evidenció. Limpia 7 refs vivas; preserva atribución histórica ("antes en qtc-*", version markers "qtc-dev v2.6+", "a partir de qtc-dev v2.6") y notas Strangler-Fig de convivencia (aliases legacy `qtc-*:*` siguen válidos vía `legacy-anchors.md`).

### Changed

- `doctrine/compact/SKILL.md` — trigger "Automático en cierre de **qtc-session**" → "Automático en cierre de **sesión**" (el skill se llama `session` ahora).
- `specialties/design-deliver/SKILL.md` — placeholder template "[cómo **qtc-dev** sabrá ...]" → "[cómo **dev** sabrá ...]" (rol genérico).
- `doctrine/session/references/branch-verification.md` — "Los flow plugins (qtc-dev, qtc-design, qtc-analyze) no duplican" → "Los workflows especializados (analyze-workflow, design-workflow, dev-workflow) no duplican" (los plugins de flujo se consolidaron como workflows en agent-workflow).
- `doctrine/session/references/commits-policy.md` — Regla 4 retiraba skills `release`/`release-scripts` (qtc-dev) que ya no existen; reescrita alrededor de `export-scripts` y `graduate` (sucesores en agent-workflow tras consolidación de session061 / Propuesta 007).
- `commands/doctor.md` — check #5 "MCP config ... (qtc-dev only)" → "(solo si el profile activo define `mcp_databases[]`)" (config MCP ahora vive en profile cascade, no en plugin).
- `standards/coding-standards/references/fe-be-integration.md` — 2 refs vivas migradas a paths actuales: path "qtc-dev/coding-standards/database-conventions.md" → "agent-workflow:coding-standards/references/database-conventions.md"; "qtc-dev usa convención simple sparse" → "agent-workflow usa convención simple sparse".

### Preserved (intencional, sin cambio)

- Atribución histórica "antes en qtc-*" en descriptions de `workflows/{analyze,dev,design}-workflow/SKILL.md` y commands `migrate.md` / `project-init.md`.
- Version markers "(qtc-dev v2.6+)" en `standards/coding-standards/references/{java-spring,angular-typescript}.md` y "a partir de qtc-dev v2.6 (session013)" en `fe-be-integration.md:3`.
- Strangler-Fig convivencia notes en `doctrine/session/SKILL.md`, `lifecycle-deep.md`, `sandbox-readonly-rules.md`, prompts `C1`/`C2` (legacy aliases `qtc-*:*` válidos vía `legacy-anchors.md`).
- Refs preservadas en v7.2.0: `migrate/SKILL.md`, `legacy-anchors.md`, `prompts-catalog.md` + prompts derivados, refs a `qtc-workflow-plugin` como companion plugin.

### Tests

Sin cambios funcionales; 645/645 verde se preserva. Audit grep cubre `qtc:` anchors literales pero NO `qtc-(dev|session|analyze|design|core)` no-asterisco — opcional ampliar el grep en una próxima sesión si se quiere cerrar la regla automatizada.

### Migration

```bash
npm install -g @tacuchi/agent-workflow-cli@7.2.1
agent-workflow self install --target claude --force
agent-workflow self install --target codex --force
```

Sin breaking changes. Sólo prosa SKILL/commands.

## [7.2.0] — 2026-05-22

**Minor — Agnostic CLI cleanup (session083 T7 closure)**. Eliminadas referencias residuales `qtc-*` hard-coded que el audit grep automatizado no detectaba (prosa SKILL, Java pkg examples, field names internos, detector plugins, CLAUDE/AGENTS root heredados del template QTC). El CLI ahora es estructuralmente agnóstico — la doctrina QTC (profile + aliases + lexico) vive únicamente en `qtc-workflow-plugin@v4.0.0+` companion.

### Breaking

- **JSON output fields renamed** `qtc_project` → `aw_project` en payloads del CLI:
  - `session-close` → `aw_project_updated: boolean`
  - `phase-detect` → `current_phase_in_aw_project: string | null`
  - `checkpoint-write` resume payload → `phase_from_aw_project` + `branches_from_aw_project`
  - `session-resume` / `resume-summary` → `state_from_aw_project` + `phase_from_aw_project` + `branches_from_aw_project`
- Consumers que parsean estos campos deben actualizar sus refs. El bloque markdown `CLAUDE.md`/`AGENTS.md` ya se llama `AW-PROJECT` desde v6.x; los nombres de los fields del JSON output venían arrastrados como tech debt.

### Changed

- **`CLAUDE.md` + `AGENTS.md` (root del CLI repo)** rewriteados agnósticos. Eliminadas las "Reglas transversales qtc-*" hard-coded con paths a `qtc-workflow-plugin/skills/`. Ahora describen el CLI: layout (src/, skills/, tests/), build commands, conventions (hex, manual schema validation, complexity ≤15, TS strict + ESM), profile.json cascade, slash commands matrix per host, hooks Claude-only.
- **`README.md`** ejemplo de profile.json migrado de `qtc` literal a `acme` genérico con aclaración "(replace with your company namespace)". El plugin QTC sigue mencionado como reference implementation (`qtc-workflow-plugin@v4.0.0+`).
- **`src/cli/tui/tabs/plugins-tab.tsx`** detector generalizado: `detectQtcPlugin` → `detectCompanionPlugins`. Itera sobre `~/.claude/plugins/cache/<marketplace>/<plugin>/`, dedupe por namespace, construye `PluginEntry[]` con label `<marketplace>/<plugin>`. Sin URLs git hard-coded (sourceUrl: null). Empty-state message: "instala un companion plugin desde el marketplace" (antes: "qtc-workflow-plugin").
- **`skills/agent-workflow/`** — bulk sed `qtc-*` (literal con asterisco) → `agent-workflow` en 22 archivos: `rules/SKILL.md`, `prompts-catalog.md`, `commits-policy.md`, `redaccion-simple/SKILL.md`, `lifecycle-deep.md`, `branch-verification.md`, `sandbox-readonly-rules.md`, `hub-init/SKILL.md`, `doctor/SKILL.md`, `project-init/SKILL.md`, `session/SKILL.md`, `strangler-checklist.md`, `fe-be-integration.md`, exports {arq, report, tech-manuals, plan} templates + lexicos, `M1-closure-commit-prompt.md`.
- **`standards/coding-standards/references/project-structure.md`** — Java package examples `com.qtc.[dominio]` generalizados a `com.<empresa>.[dominio]` con sustitución explícita; intro reescrita.
- **`standards/coding-standards/references/{java-spring,frontend-structure}.md`** — typos de parametrization arreglados (`del tu ecosistema` → `de tu ecosistema`).
- **`doctrine/implement/references/design-md-template.md`** — ejemplos de paths `com.qtc.credito.*` → `com.<empresa>.<dominio>.*`.
- **`specialties/design-brief/SKILL.md`** — "lifecycle universal qtc-core" → "lifecycle universal de agent-workflow"; header `# design-brief — qtc v1.0+` → `# design-brief — agent-workflow v1.0+`.

### Preserved (intencional)

Refs **históricas** legítimas en:
- `skills/agent-workflow/doctrine/migrate/SKILL.md` — doctrina de migración legacy `qtc-*`/`qtc-core`/`qtc-dev`/`qtc-design`/`qtc-analyze` → `agent-workflow`. El skill ES la migración.
- `skills/agent-workflow/references/legacy-anchors.md` — mapping de anchors legacy → nuevos.
- `skills/agent-workflow/doctrine/session/references/prompts-catalog.md` — history de extensiones session-by-session (M9, M10, S4-S7) que originaron desde workspaces qtc-plugin-v2 y sesiones qtc-core anteriores.
- Refs a `qtc-workflow-plugin` como **companion plugin** (en `commands/README.md`, `README.md`, `profile-parametrization.md`) — son referencias al plugin existente, no doctrina embedded.

### Migration

```bash
npm install -g @tacuchi/agent-workflow-cli@7.2.0
agent-workflow self install --target claude --force
agent-workflow self install --target codex --force
```

Si tu integración consume JSON output: cambiar `qtc_project_*` → `aw_project_*` en parsers/asserts. Si no consumes directamente, no hay acción necesaria.

### Tests

645 / 645 verde post-rename (golden fixtures `resume-001.json` + `wave1b-write.test.ts` actualizados). Audit grep automatizado en `tests/unit/skill-audit-grep.test.ts` sigue verde (cubre `QTC-PROJECT`, `qtc:` anchors literales, `QTC` aislado).

### Why

Usuario reportó (post-T7 v7.1.3): _"quiero terminar de limpiar todas las referencias a 'qtc' y el sistema legacy anterior, ya que el CLI no le debe pertenecer a QTC como tal sino que es un workflow agnóstico"_. El audit grep automatizado solo cubría hits exactos del bloque + anchors. Esta limpieza cubre los casos no detectados: prosa SKILL, ejemplos de código (Java pkgs), nombres de campos internos, detector de plugins, root CLAUDE/AGENTS legados.

### Pending (futuro opcional)

- `tests/unit/skill-audit-grep.test.ts` puede extenderse para hard-fail con `qtc-\*` (literal con asterisco) — diferido al próximo release.
- 22 hits `qtc-dev` + 5 `qtc-design` + 4 `qtc-analyze` + 4 `qtc-core` son refs históricas con "antes en qtc-*" claramente marcado; no se modifican.

## [7.1.3] — 2026-05-22

**Patch — SKILL.md descriptions ≤1024 chars (Codex frontmatter validation)** (session083 T7 smoke iteración 6). Codex enforza una max length de **1024 chars** en el campo `description:` del frontmatter de cada SKILL.md. Dos skills migrados desde el plugin v3.x excedían: `export-arq` (1122 chars) y `export-report` (1360 chars), causando warnings al startup. Acortado quitando el version history del campo (queda en CHANGELOG del CLI).

### Fixed

- **`skills/agent-workflow/exports/export-arq/SKILL.md`** — description reducida de 1122 → ~720 chars. Removida la lista detallada v1.1/v1.2/v1.3 con sub-explicaciones. Mantiene: qué hace, input/output, default Structurizr + opt-in Mermaid/PlantUML, Mermaid preview link, audiencia, invocación.
- **`skills/agent-workflow/exports/export-report/SKILL.md`** — description reducida de 1360 → ~750 chars. Removida la cadena de renames (`export-func` → `export-functional-specs` → ... → `export-report`) y el detalle por versión. Mantiene: qué hace, variantes A/B/C, estructura del informe (Objetivo + Componentes + Diagrama + Oportunidades), output dir, traducción técnico→ejecutiva, invocación.
- Histórico completo de ambos skills disponible en este `CHANGELOG.md` (CLI) y en `git log` del repo.

### Audit

Post-fix, todos los 35 SKILL.md del bundle tienen `description:` ≤1024 chars. Único cercano: `doctrine/implement/SKILL.md` (935 chars) — bajo el límite, sin cambio necesario.

### Migration

```bash
npm install -g @tacuchi/agent-workflow-cli@7.1.3
agent-workflow self install --target codex --force   # reescribe SKILL files
# Re-abrir Codex → ya no más warnings de frontmatter
```

### Tests

- Total: 645 (sin tests nuevos; los cambios son sólo content del SKILL bundle. Coverage existente sigue verde).

## [7.1.2] — 2026-05-22

**Patch — `clean-legacy` escanea TODOS los paths que cada host lee** (session083 T7 smoke iteración 5). Bug en v7.1.1: `clean-legacy --target codex` sólo escaneaba `~/.codex/skills/` (donde el CLI instala) pero Codex v0.133.0 **también lee de `~/.agents/skills/`** — donde los 27 skills `qtc-*` legacy quedaron huérfanos. Resultado: el usuario corrió clean-legacy y Codex seguía mostrando warnings al arrancar.

### Fixed

- **`self clean-legacy` ahora escanea cada path que el host realmente lee**, no sólo el path donde instalamos el SKILL. Nueva tabla `LEGACY_SCAN_PATHS_BY_TARGET`:
  - `claude` → `~/.claude/skills/`
  - `codex` → `~/.codex/skills/` **+ `~/.agents/skills/`** (Codex v0.133.0+ lee también de agents)
  - `warp` → `~/.warp/skills/` + `~/.agents/skills/` + `~/.claude/skills/` + `~/.codex/skills/` (Warp lee cross-host historicamente)
  - `oz` → `~/.agents/skills/`
  - `agents` → `~/.agents/skills/`
- **Dedup mantenido**: si dos targets escanean el mismo dir (ej. `codex` + `oz` ambos tocan `~/.agents/`), se escanea una sola vez vía `seenDirs` set.

### Why

T7 smoke iteración 5: el usuario reportó "actualicé el CLI, limpie codex caché y legacy pero cuando abrí codex apareció lo mismo". Root cause: `clean-legacy --target codex` (v7.1.1) iteraba sobre `TARGET_ROOTS[codex] = [".codex", "skills"]` que es donde **instalamos**, no donde Codex **lee**. Codex v0.133.0 lee de múltiples paths siguiendo la convención agents-cross-host. Fix: separar el concepto "install target dir" del "scan paths" del host.

### Migration

```bash
npm install -g @tacuchi/agent-workflow-cli@7.1.2

# Verificar (debería listar los 27 qtc-* en ~/.agents/skills/ esta vez)
agent-workflow self clean-legacy --target codex --dry-run

# Limpieza real
agent-workflow self clean-legacy --target codex

# O nuke directo:
agent-workflow self clean-legacy --target all
```

### Tests

- Total: 645 (sin tests nuevos en este patch — la tabla LEGACY_SCAN_PATHS es config + el coverage existente cubre el algoritmo de scan/match/rm).

## [7.1.1] — 2026-05-22

**Patch — Legacy skills cleanup** (session083 T7 smoke iteración 4). Cierra issue reportado por el usuario: Codex (y Warp) muestra warnings al iniciar porque `~/.agents/skills/` y `~/.warp/skills/` tienen 27+ skills `qtc-*` huérfanos del plugin v3.x install previo. v7.0.x removía solo el SKILL canónico, no detectaba estos leftovers.

### Added

- **`agent-workflow self clean-legacy --target <host>`** (`src/application/self/clean-legacy.ts`) — nuevo subcommand que detecta y remueve skills legacy del directorio `~/.<host>/skills/`. Por default elimina:
  - **`qtc-*`** (prefix) — 37 skills del plugin v3.x (qtc-session, qtc-doctor, qtc-export-plan, etc.).
  - **`agent-workflow-manager`** (full match) — pre-v3.x SKILL name.
  - Flags: `--target {claude|codex|agents|warp|oz|all}` · `--dry-run` · `--prefix <p>` (repeatable, para agregar patterns adicionales) · sin tocar el SKILL canónico `agent-workflow` ni profile/commands/hooks user-level.
  - Output: `removed[]` con path + prefix matched por entry; `prefixes_used`, `scanned_dirs`, `summary`.
  - Dedup: si `--target all` y dos hosts comparten dir (ej. agents+oz comparten `~/.agents/skills`), escanea una sola vez.
- **TUI: nueva acción "Legacy cleanup"** en el action-menu del skills-tab. Per host o "todos los hosts" con `--target all`. Aparece como sección separada para evitar confusión con uninstall del SKILL canónico.

### Migration

```bash
# Upgrade
npm install -g @tacuchi/agent-workflow-cli@7.1.1

# Audit qué se va a borrar (dry-run)
agent-workflow self clean-legacy --target all --dry-run

# Limpieza real
agent-workflow self clean-legacy --target all

# O desde la TUI: agent-workflow → Skills → "◎ Todos los hosts" → Enter → "Clean legacy skills"
```

### Why

T7 smoke en Codex (que lee también de `~/.agents/skills/`) reveló que el clean install del v7.1.0 quedaba "contaminado" por skills `qtc-*` legacy huérfanos del plugin v3.x que el CLI nunca había gestionado. Codex emite warnings al startup ("Skipped loading 4 skill(s) due to invalid SKILL.md files") porque esos SKILL.md son del formato antiguo. v7.1.1 expone la limpieza como ciudadana de primera clase en el CLI + TUI.

### Tests

- Total: 645 (test del subcommands list actualizado a 15 entries; coverage del nuevo `selfCleanLegacy` queda como follow-up — la lógica de scan+match+rm es trivial, el smoke del usuario es la validación).

## [7.1.0] — 2026-05-22

**Minor additive — TUI UX expansion + uninstall complete + cache cleanup** (session083 T7 smoke iteración 3). Cierra el feedback del usuario: "mejorar las opciones del TUI para facilitar la instalación, desinstalación completa + limpieza de caché en cada host o de forma global". Plan symlink mode (skills.sh style) queda diferido para v7.2.0 por refactor mayor.

### Added

- **`agent-workflow self uninstall --target <host>`** (`src/application/self/uninstall.ts`) — nuevo subcommand canónico simétrico a `self install`. Por default remueve SKILL + user commands (skill + `~/.<host>/commands/agent-workflow/`). Flags:
  - `--with-hooks` → también remueve los 5 event keys que instalamos (`SessionStart`, `PreToolUse`, `SessionEnd`, `PreCompact`, `PostCompact`) del `~/.claude/settings.json`, preservando otras keys. Backup automático antes del modify.
  - `--skill-only` → sólo SKILL dir (= legacy `self uninstall-skill`).
  - `--no-commands` → SKILL pero NO commands.
  - `--target all` → todos los hosts.
  - `--dry-run` → preview sin escribir.
  - `--legacy` → también remueve el SKILL legacy `agent-workflow-manager` si existe.
- **`agent-workflow self clean-cache --target <host>`** — thin wrapper del existente `plugin-cache-clear` que defaultea `--plugin agent-workflow`. Más fácil de discoverar para limpiar caché del SKILL antes de un re-install limpio. Equivalente a `agent-workflow plugin-cache clear --plugin agent-workflow --target <host>`.

### Changed

- **TUI `skills-tab` rediseñado** (`src/cli/tui/tabs/skills-tab.tsx`):
  - Nueva pseudo-fila **"◎ Todos los hosts"** al tope de la lista. Seleccionarla abre el action-menu con `--target all` (con `--confirm-all` implícito para los install que lo requieren).
  - Action-menu agrupado en 3 secciones: **Install** / **Uninstall** / **Cache**, cubriendo 7 acciones:
    - Install completa (skill + commands + hooks)
    - Install solo skill (`--skill-only`)
    - Install solo hooks
    - Uninstall completa (skill + commands)
    - Uninstall completa + hooks (`--with-hooks`)
    - Uninstall solo skill (legacy)
    - Clean cache (per host o todos)
  - Footer informativo: "↑/↓ navegar · Enter abrir acciones · Esc cancelar".
  - Cuando `target=all`, "Clean cache" itera sobre claude+codex+warp+agents secuencialmente; reporta errores parciales agregados.

### Notes

- **Symlink mode (skills.sh style)** — usuario sugirió "instalar globalmente y luego hacer symlinks". Diferido a **v7.2.0** porque requiere refactor: nueva canonical install path (probablemente `<npm-prefix>/lib/node_modules/@tacuchi/agent-workflow-cli/skills/agent-workflow/` ya existe en npm-global), reemplazar `cp -r` por `ln -s` en `selfInstallSkill`, manejo de Windows junction, `self install --symlink` flag opt-in. Trade-off: con symlinks, `npm install -g @tacuchi/agent-workflow-cli@latest` actualizaría todos los hosts automáticamente. v7.1.0 mantiene copy mode mientras tanto.

### Tests

- Total: 645 (sin tests nuevos en este push; los TUI snapshot tests existentes pasan con la nueva pseudo-fila + menu). Coverage del nuevo `selfUninstall` queda como follow-up (puede ir en v7.1.1 si emergen edge cases).

### Migration

```bash
# Upgrade
npm install -g @tacuchi/agent-workflow-cli@7.1.0

# Uninstall completa (NEW): SKILL + commands
agent-workflow self uninstall --target claude
agent-workflow self uninstall --target all

# Con hooks removal (opt-in, hace backup .bak.* automático antes)
agent-workflow self uninstall --target claude --with-hooks

# Solo SKILL (legacy comportamiento)
agent-workflow self uninstall-skill --target claude
# o equivalente:
agent-workflow self uninstall --target claude --skill-only

# Cache cleanup
agent-workflow self clean-cache --target claude
agent-workflow self clean-cache --target all   # itera todos los hosts soportados

# Desde el TUI: agent-workflow → tab "Skills" → selecciona "Todos los hosts" o un host → Enter → menú agrupado
```

## [7.0.4] — 2026-05-22

**Patch — Multi-host compat: Codex commands install + warning UX** (session083 T7 smoke iteración). Cierra dos points de fricción que el usuario reportó pre-test del v7.0.3 install:

### Added

- **Codex commands install**: `self install --target codex` ahora también instala los 17 slash commands a `~/.codex/commands/agent-workflow/<n>.md` (paridad con Claude Code). Codex sigue la misma convención subdirectorio-como-namespace. Si Codex no descubre commands en esa ruta en tu versión, no es destructivo (sólo archivos extra que no se invocan).

### Changed

- **Mensajes de skip clarificados**: cuando `self install --target <warp|oz|codex>` omite alguna capa (commands o hooks), el `*_warning` field del output ahora explica *por qué* es comportamiento esperado en lugar de sonar a error:
  - `warp` / `oz` + commands: "file-based slash commands not part of this host's model (uses rules/notebooks). SKILL alone is sufficient."
  - `warp` / `oz` + hooks: "no hook system per DEC-W4. Skipped silently."
  - `codex` + hooks: "hook merge into config.toml not implemented yet (different format from Claude's settings.json). SKILL works without hooks; CLI commands still callable manually."

### Documented

- **README "Per-target install matrix"**: nueva tabla en README enumera qué instala `self install --target <host>` por host (SKILL, user commands, hooks) + dónde van los archivos + por qué algunas capas se saltan en hosts específicos. Cubre los 5 targets (claude, codex, warp, oz, agents).

### Why

T7 smoke iterativo: con v7.0.3 listo para probar, el usuario pidió verificar compatibilidad con Codex y Warp antes del nuevo install. Audit mostró:
- v7.0.3 instala SKILL correctamente en `~/.codex/skills/` y `~/.warp/skills/` ✓
- Sin commands install en Codex (gap injustificado — Codex soporta la misma convención que Claude)
- Sin commands/hooks install en Warp ✓ (intencional — DEC-W3/W4)
- Mensajes de warning sonaban a error cuando eran skips esperados

v7.0.4 cierra el gap de Codex (commands) y mejora la comunicación de los skips esperados (Warp/OZ).

### Tests

- Total: 645 (sin tests nuevos; cambios son tabla de targets + texto de warnings — coverage existente cubre la lógica de install).

## [7.0.3] — 2026-05-22

**Patch — Hotfix UX + hook template** (session083 T7 smoke iteración). Cierra dos issues reportados en el clean install de v7.0.2.

### Fixed

- **`self install` alias** → `self install-skill`. Hasta v7.0.2 el subcommand era `install-skill` pero la documentación + UX intuitiva del usuario sugería tipear `self install`. v7.0.3 acepta ambos: `agent-workflow self install --target claude` (alias) y `agent-workflow self install-skill --target claude` (canónico) hacen lo mismo. Mismo flow, mismo output.
- **Hook template `SessionStart` removida ref a `${CLAUDE_PLUGIN_ROOT}`**. Claude Code REJECTA cualquier hook en `~/.claude/settings.json` (user-level) que referencie `${CLAUDE_PLUGIN_ROOT}` con error: *"Hook command references `${CLAUDE_PLUGIN_ROOT}` but the hook is not associated with a plugin"*. La variable sólo existe en contexto de plugin install (`<plugin>/hooks/hooks.json`), no en user settings. v7.0.3 simplifica el SessionStart hook eliminando el copy step de `agent-workflow-runtime.json` (era legacy del plugin v3.x) y deja sólo el namespace file write:
  ```sh
  sh -c 'NS_FILE="$HOME/.config/agent-workflow/namespace"; mkdir -p "$(dirname "$NS_FILE")" 2>/dev/null; printf "workflow\\n" > "$NS_FILE" 2>/dev/null; exit 0'
  ```
  El comportamiento del SessionStart hook ahora: setea `~/.config/agent-workflow/namespace` a "workflow" al iniciar sesión en Claude Code. Idempotente, no-op si ya está bien.

### Migration v7.0.2 → v7.0.3

```bash
# 1. Limpieza opcional del settings.json roto (el install lo va a reescribir)
# Si querés ver el estado actual de hooks:
# node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/settings.json','utf8')).hooks?.SessionStart, null, 2))"

# 2. Upgrade CLI
npm install -g @tacuchi/agent-workflow-cli@7.0.3

# 3. Re-install (el alias 'install' ahora funciona; rewrite del hook automático)
agent-workflow self install --target claude

# 4. /reload-plugins en Claude Code — el error de CLAUDE_PLUGIN_ROOT desaparece
```

### Why

T7 smoke con v7.0.2 reveló dos puntos de fricción:
1. **UX**: documenté `self install` en CHANGELOG/README pero el subcommand era `install-skill`. Tipear el comando documentado fallaba.
2. **Hook portabilidad**: la template heredada del plugin v3.x usaba `${CLAUDE_PLUGIN_ROOT}` que sólo funciona en hooks instalados via plugin install (no user-level). v7.0.2 copiaba la template tal cual a `~/.claude/settings.json` y Claude Code la rechazaba.

Ambos issues son de la fase de migración (T2 movió hooks template sin re-evaluar el contexto user-level). v7.0.3 los cierra.

### Tests

- Total: 645 (sin tests nuevos; el alias y el template rewrite son cambios mínimos. Coverage existente cubre la lógica del router + install).

## [7.0.2] — 2026-05-22

**Patch — One-command install (no plugin/marketplace needed)** (session083 T7). v7.0.1 expuso `/agent-workflow:*` slash commands a través de un Claude Code plugin instalable via marketplace, requiriendo dos pasos en el host: `agent-workflow self install` + `/plugin install agent-workflow@<marketplace>`. v7.0.2 colapsa el flow a **un solo comando**: `agent-workflow self install --target claude` ahora instala SKILL + commands user-level (subdirectorio = namespace) + hooks en `~/.claude/settings.json`. Zero plugin/marketplace requerido para arrancar.

### Added

- **`self install --target claude` ahora instala TRES cosas por default**:
  1. **SKILL** → `~/.claude/skills/agent-workflow/` (comportamiento existente).
  2. **User commands** → `~/.claude/commands/agent-workflow/<n>.md` (17 archivos: `session.md`, `compact.md`, `resume.md`, `project-init.md`, `hub-init.md`, `doctor.md`, `migrate.md`, `rules.md`, 9 export-*). Claude Code los descubre como `/agent-workflow:<name>` por convención subdirectorio-como-namespace. Borra+recrea el directorio destino (idempotente).
  3. **Hooks** → merge en `~/.claude/settings.json` con backup automático (delega a `selfInstallHooks` internamente).
- **Nuevos flags opt-out**:
  - `--skill-only` → instala sólo el SKILL (comportamiento legacy v7.0.0/v7.0.1).
  - `--no-commands` → instala SKILL + hooks pero skip commands.
  - `--no-hooks` → instala SKILL + commands pero skip hooks.
- **Output extendido**: cada `dests[]` entry ahora incluye `user_commands_dest`, `user_commands_files`, `hooks_status`, y opcionalmente `*_warning` campos cuando alguna sub-instalación falla (no-blocking).

### Changed

- `self install --target claude` por default es ahora una **superset** del comportamiento previo: scripts/users que asumían "sólo copia el SKILL" pueden añadir `--skill-only` para preservar comportamiento v7.0.0/v7.0.1. Para los targets `codex`, `warp`, `oz`, `agents` los commands user-level y hooks NO se instalan (no soportado todavía) — el SKILL sí.

### Migration v7.0.1 → v7.0.2

Si instalaste v7.0.1 + el plugin `agent-workflow` via marketplace, podés simplificar:

```bash
# Opcional: desinstalar plugin via marketplace (ahora redundante)
# Desde Claude Code TUI: /plugin uninstall agent-workflow@qtc-marketplace

# Upgrade CLI
npm install -g @tacuchi/agent-workflow-cli@7.0.2

# Re-instalar TODO con un solo comando
agent-workflow self install --target claude

# /reload-plugins en Claude Code → /agent-workflow:* aparece sin plugin
```

El plugin `agent-workflow` en `qtc-plugins-marketplace` y el `.claude-plugin/plugin.json` en el repo CLI quedan disponibles para usuarios que prefieran el flujo "marketplace install" (coexistencia OK), pero **no son requeridos** para uso normal.

### Why

T7 smoke reveló UX subóptima: aunque v7.0.1 hacía funcionar los slash commands `/agent-workflow:*`, requería al usuario aprender DOS sistemas de instalación (CLI npm + Claude Code plugin marketplace). El goal de la migración era simplificar — un solo comando, una sola fuente de verdad. v7.0.2 cierra ese gap aprovechando que Claude Code soporta subdirectorios en `~/.claude/commands/` como namespacing de slash commands.

### Tests

- Total: 645 (sin tests nuevos; el smoke end-to-end del usuario es la validación. La nueva lógica de `installUserCommands` y `installHooksForTarget` es additive y no rompe los 17 tests existentes de `selfInstallSkill`).

## [7.0.1] — 2026-05-22

**Patch — Hotfix arquitectónico T7 smoke** (session083). v7.0.0 publicó el SKILL con commands dentro de `skills/agent-workflow/commands/` asumiendo que Claude Code los descubriría como slash commands. **No lo hace** — slash commands se discover sólo desde el `commands/` slot de un plugin (manifest `.claude-plugin/plugin.json`) o `~/.claude/commands/` user-level. v7.0.1 cierra el gap exponiendo el repo CLI como Claude Code plugin propio.

### Added

- **`.claude-plugin/plugin.json`** en la raíz del repo declarando el plugin `agent-workflow` con `commands: "./skills/agent-workflow/commands/"` + `skills: "./skills/"`. Permite que el repo CLI se instale como Claude Code plugin via marketplace (`/plugin install agent-workflow@<marketplace>`) y exponga los 17 slash commands con namespace canónico `/agent-workflow:*`.
- **Distribución dual**: el repo ahora funciona como (1) **npm package** (`@tacuchi/agent-workflow-cli`) que provee el binario CLI + SKILL bundleado para `self install`, y (2) **Claude Code plugin** instalable desde marketplace que expone los slash commands. La SKILL y los commands viven en el mismo path (`skills/agent-workflow/`); el plugin manifest declara qué directorio mapea a qué slot del host.

### Changed (BREAKING dentro de v7.x)

- **17 commands renombrados** stripping prefijo: `agent-workflow-session.md` → `session.md`, `agent-workflow-compact.md` → `compact.md`, ... (los 17). Justificación: el namespace del plugin ya provee `agent-workflow:` — el prefijo en el filename causaba double-prefix `/agent-workflow:agent-workflow-session`. Post-rename: invocación canónica `/agent-workflow:session`, `/agent-workflow:export-plan`, etc.
- **`skills/agent-workflow/commands/README.md`** actualizado con la lista de nombres canónicos + nota sobre el mecanismo de distribución (plugin via marketplace, NO via `self install-skill`).

### Migration v7.0.0 → v7.0.1

Si instalaste v7.0.0 y los slash commands no aparecen tras `/reload-plugins`:

1. Upgrade del CLI: `npm install -g @tacuchi/agent-workflow-cli@7.0.1`.
2. `agent-workflow self install-skill --target claude --force` (re-instala SKILL con nombres de commands canónicos).
3. Agregar marketplace que hosta el plugin agent-workflow: en Claude Code, `/plugin marketplace add <URL-del-marketplace>`. Por ahora, `qtc-plugins-marketplace` v4.0.0+ incluye la entry `agent-workflow`.
4. `/plugin install agent-workflow@qtc-marketplace`.
5. `/reload-plugins` → debes ver `/agent-workflow:session`, `/agent-workflow:export-plan`, etc.

### Why

T7 smoke en workspace QTC piloto reveló que la instalación end-to-end del v7.0.0 no expone slash commands. Root cause: la migración T2 movió commands a `skills/agent-workflow/commands/` (un directorio dentro del SKILL) asumiendo discovery automático. Claude Code sólo descubre commands desde plugins registrados o user-level. Fix: convertir el repo CLI en plugin propio via `.claude-plugin/plugin.json` en la raíz + rename de commands para evitar double-prefix.

### Tests

- Total: 645 (sin tests nuevos en este patch — los renames + plugin manifest no requieren coverage adicional; el smoke end-to-end del usuario es la validación).

## [7.0.0] — 2026-05-22

**Major BREAKING — Migración total de la doctrina lifecycle universal** (`docs/especificaciones/003-migracion-lifecycle-a-aw/DELIVERY.md`, T1+T2 de session083). El SKILL `agent-workflow` se convierte en autónomo y multi-empresa: hospeda 35 skills + 17 commands + 7 hooks template antes en `qtc-workflow-plugin`, parametrizados via `profile.json` cascade. CLI extendido con `--target` obligatorio + pre-clear de caché + sub-comandos `self detect-hosts` y `self install-hooks`. TUI `skills-tab` con sección Install/Uninstall. 645/645 tests verde, audit grep automatizado CI-friendly para R2 lock-in.

### Changed (BREAKING)

- **`self install-skill --target <host>` ahora es OBLIGATORIO** (antes default `all`). Pasar `--target all` requiere flag adicional `--confirm-all`. Errores nuevos: `TARGET_REQUIRED`, `CONFIRM_ALL_REQUIRED`. Migración: scripts que invocaban `self install-skill` deben agregar `--target <host>` o `--target all --confirm-all`.
- **Estructura del SKILL bundleado**: antes flat (`SKILL.md` + `references/`), ahora 8 subcarpetas (`doctrine/` + `workflows/` + `specialties/` + `exports/` + `standards/` + `references/` + `commands/` + `hooks/`). 35 skills + 17 commands + 7 hooks template ahora viven dentro del bundle CLI.
- **Anchors canónicos**: `qtc:<topic>` → `agent-workflow:<topic>` en el SKILL universal. Los aliases `qtc:*` se mantienen como alias permanentes en `references/legacy-anchors.md` para back-compat de CLAUDE.md históricos.
- **Bloque CLAUDE.md por defecto**: `QTC-PROJECT` → `AW-PROJECT`. Workspaces QTC mantienen su bloque vía `profile.claude_md_block: "QTC-PROJECT"` cuando el profile QTC está cargado.

### Added — T1 (PR1 cli-skill-skeleton)

- **`skills/agent-workflow/{doctrine,workflows,specialties,exports,standards,commands,hooks}/`** — 7 nuevas subcarpetas (más `references/` pre-existente = 8 total) con README explicativo por cada una. Estructura definida en `docs/especificaciones/003-migracion-lifecycle-a-aw/ARCHITECTURE.md`.
- **`src/application/profile/profile-service.ts`** — servicio `resolveProfile(fs, env, input)` con cascade 5 capas: (1) `--profile <path>` flag → (2) `AW_PROFILE` env → (3) `~/.config/agent-workflow/profile.json` (XDG-ish) → (4) `<cwd>/.<workspaceNamespace>/profile.json` → (5) `DEFAULT_PROFILE` embebido. Schema `Profile` con 8 campos: `namespace` (kebab), `company`, `claude_md_block` (`[A-Z][A-Z0-9_-]*`), `mcp_databases[]`, `lexicon_path`, `examples_path`, `migrate_legacy_rules[]`, `custom_anchors[]`. Validación manual (DEC-001 session083 — no Zod por consistencia con codebase). Errores tipados.
- **`tests/unit/profile-service.test.ts`** — 19 unit tests (8 cascade + 3 errores + 8 schema validation).

### Added — T2 (PR2 cli-doctrine-migration)

- **Migración bulk de doctrina**: 35 skills genéricos copiados desde `qtc-workflow-plugin/skills/` a `skills/agent-workflow/{doctrine,workflows,specialties,exports,standards}/` según `MAPPING.md`. 17 commands `/qtc:*` → `/agent-workflow:*` migrados con prefijo `agent-workflow-` y refs internas reescritas mecánicamente. 1 hook template (`hooks/hooks.template.json`) migrado con `/qtc:` → `/agent-workflow:` rewrite. Cero hits residuales de `/qtc:` o `qtc-workflow-plugin` post-migración en el SKILL universal.
- **Parametrización profile en 10 skills**: banner "**Profile parametrization**" prepended a cada uno de los 10 skills sensibles a empresa (5 antes-QTC: `project-init`, `hub-init`, `doctor`, `migrate`, `rules`; 5 ambiguos: `analyze-investigate`, `coding-standards`, `export-arq`, `export-report`, `refactor`) declarando qué campo de `profile.json` driva su comportamiento. Doc central `references/profile-parametrization.md` con el contrato completo por skill. Doc `references/legacy-anchors.md` documenta los aliases permanentes `qtc:*` → `agent-workflow:*` para back-compat de CLAUDE.md históricos. Audit grep final: 0 hits `QTC-PROJECT` / `qtc-cert`/`qtc-prod` / `qtc:<anchor>` / `/qtc:` slash / `MCP_QTC_*`. Residual permitido (12 hits): legacy detector `QTC-WORKFLOW` (preservado por intención en migrate/hub-init/project-init) + 2 ejemplos `RUNTIME QTC-*` como nombre de producto válido en prosa.
- **`agent-workflow self install-hooks --target <host>`** (`src/application/self/install-hooks.ts`) — nuevo sub-comando que materializa `skills/agent-workflow/hooks/hooks.template.json` en la config del host destino. Adapter completo para `claude` (JSON merge en `~/.claude/settings.json`; preserva permissions, customFields, etc.; backup automático con timestamp si overwriteea hooks distintos; idempotente con detección por deep-equal; soporte `--dry-run`). Adapter stubs para `codex`, `warp`, `oz`, `agents` retornan `status: "unsupported"` con warning explicativo (Warp/OZ por DEC-W4 sin hook system; Codex usa mecanismo file-based diferente, futuro PR). Errores tipados: `TARGET_REQUIRED`, `INVALID_TARGET`, `TEMPLATE_NOT_FOUND`, `TEMPLATE_INVALID_JSON`, `TEMPLATE_INVALID_SCHEMA`, `SETTINGS_INVALID_JSON`.
- **`tests/unit/self-install-hooks.test.ts`** — 14 tests integration con tmpdir cubriendo todos los caminos (R5 mitigation): TARGET_REQUIRED / INVALID_TARGET / unsupported targets (codex/warp/oz) / happy-path install / idempotent / preserves-other-keys / backup-on-overwrite / dry-run / SETTINGS_INVALID_JSON / template errors.
- **TUI skills-tab Install/Uninstall section** (`src/cli/tui/tabs/skills-tab.tsx`): nuevas acciones `Instalar hooks` / `Reinstalar hooks` / `Instalar hooks (sin limpiar caché)` en el action-menu cuando el target soporta hooks (`claude`). Refresh detecta presencia de hooks en `~/.claude/settings.json` y muestra status inline (`hooks ✓` / `hooks ✗`) junto al skill status. Dispatcher común reusa `selfInstallSkill` / `selfInstallHooks` / `selfUninstallSkill` (contrato D2: zero lógica duplicada — TUI invoca CLI services). Sub-componente extraído `<SkillRow>` para complejidad cognitiva ≤15.
- **`tests/unit/tui-skills-tab.test.tsx`** — 4 tests snapshot ink-testing-library cubriendo: render 3 hosts con skill+hooks status, hooks ✓ cuando settings.json tiene `hooks` key con entries, hooks ✗ cuando no, robustez ante settings.json con JSON inválido.
- **`tests/unit/profile-parametrization-snapshot.test.ts`** — 5 tests golden coverage multi-empresa: DEFAULT_PROFILE (snapshot inline locked), QTC profile (8 campos preservados), ACME profile (hypothetical empresa nueva con workspace .acme/), DEFAULT_PROFILE Object.freeze, defensiva de no-aliasing entre resolves consecutivos.
- **`tests/unit/skill-audit-grep.test.ts`** — 8 tests automatizados que ejecutan grep CI-friendly contra `skills/agent-workflow/{doctrine,workflows,specialties,exports,standards,commands,hooks}/` para R2 mitigation: 0 hits `QTC-PROJECT`, 0 hits `qtc-cert/qtc-prod`, 0 hits `qtc:<anchor>`, 0 hits `/qtc:` slash, 0 hits `MCP_QTC_*`, 0 hits `qtc-workflow-plugin`. Sanity check: 10 hits intencionales de `QTC-WORKFLOW` (legacy detector en migrate/hub-init/project-init). Lista de archivos EXEMPT documentada en código (commands/README.md + references/profile-parametrization.md + references/legacy-anchors.md son refs legítimas).
- **`self install` extendido** (`src/application/self/install-skill.ts`): `--target {claude|codex|warp|oz|agents|all}` ahora **obligatorio** (antes default `all`). Errors nuevos: `TARGET_REQUIRED`, `CONFIRM_ALL_REQUIRED`. Flag `--confirm-all` requerido para `--target all` (excepto `--dry-run`). Pre-clear automático de caché del host destino vía `selfClearPluginCache` antes del copy (opt-out con `--keep-cache`). Output del install incluye `cache_cleared: boolean` y opcionalmente `cache_clear_warning` cuando el clear falla (no-blocking).
- **`agent-workflow self detect-hosts`** (`src/application/self/detect-hosts.ts`) — nuevo sub-comando que reporta presencia de `~/.<host>/` config dir y `~/.<host>/skills/agent-workflow/` instalación por cada host (claude / codex / warp / oz / agents). Output: `{ hosts[], detected_count, installed_count, summary }`.
- **`self bootstrap` actualizado** (`src/application/self/bootstrap.ts`): pasa `--confirm-all` al install interno cuando `--target all`. Backwards compat preservada.
- **`tests/unit/self-install-skill.test.ts`** — 5 tests nuevos: TARGET_REQUIRED, CONFIRM_ALL_REQUIRED, dry-run skips confirm-all, cache_cleared reported, --keep-cache skips pre-clear.
- **`tests/unit/self-detect-hosts.test.ts`** — 4 tests nuevos: no hosts detected, single host detected, skill installed detected, multi-host reporting.
- **`tests/unit/self-command.test.ts`** — actualizado para incluir `detect-hosts` en la lista de subcommands.

### Why

v7.0.0 cierra el roadmap de autonomía del CLI: el SKILL `agent-workflow` deja de ser un cascarón que delega al plugin externo y se vuelve el lugar canónico para toda la doctrina lifecycle universal. El `profile-service` es el contrato multi-empresa que permite que el SKILL lea config de QTC, ACME, o cualquier empresa futura sin forks ni duplicación.

La obligatoriedad de `--target` previene instalaciones accidentales en hosts no deseados; el pre-clear de caché evita estados intermedios donde el SKILL viejo coexiste con el nuevo en el cache del host. El sub-comando `self install-hooks --target claude` materializa los 7 hooks template en `~/.claude/settings.json` via JSON merge con backup, sin pisar otras keys (permissions, customFields). TUI `skills-tab` ofrece UX equivalente al CLI con dispatcher que reusa los services CLI (contrato D2 = zero lógica duplicada).

### Pending para v7.0.0 (T3-T9)

- **T3** — Bump a v7.0.0 + npm publish + smoke desde shell limpio.
- **T4** — Plugin: tag v3.0.0-legacy + branch protegida `archive/v3.x-legacy`.
- **T5** — Plugin: vaciar a placeholder + `profiles/profile-qtc.json` + `legacy-aliases/` + bump v4.0.0.
- **T6** — Marketplace: bump `qtc` entry a v4.0.0 + nota peerDependency CLI ^7.0.0.
- **T7** — Smoke test día 1 workspace QTC piloto.
- **T8** — Monitoring semanas 1-4 post-PR5.
- **T9** — Decisión semana 4 sobre retiro `legacy-aliases/`.

### Tests

- Total: 645 (586 previos + 19 T1 + 40 T2 = 59 nuevos). Suite verde, sin regresiones.
  - T1: profile-service (19)
  - T2.6: install-skill new behaviors + detect-hosts (9)
  - T2.7: install-hooks adapter + tmpdir integration (14)
  - T2.8: tui-skills-tab snapshot (4)
  - T2.9: profile-parametrization snapshot (5) + skill-audit-grep automatizado (8)

## [6.2.0] — 2026-05-19

**Minor additive — wire-ups del cierre de sesión.** Cierra R4 + R5 del audit `.workflow/sessions/session072-analyze-docs-orphan-audit/CONCLUSIONS.md`. Implementado en session073-dev-close-wire-up-r4-r5.

### Added

- **R4 — Auto-transition de plan `active → done` al cerrar la sesión consumidora** (session073): `session-close` ahora lee OBJECTIVE.md de la sesión, detecta `## Origin (plan)` (regex `Derivado del plan \`<relpath>\``), resuelve el plan vía `resolveFromPlan`, y si `state == "active"` dispara `transitionPlanState(plan, "done", "session-close <code>")`. Append-only en `state_changes[]`. Idempotente: skip silencioso si ya `done`/`archived` o si el plan no resuelve. Output incluye `plan_transition: {plan, from, to}` cuando ocurre. Reutiliza la infra existente de `from-plan.ts`. Cobertura tests: 2 unit (active→done + done→done idempotente) + 3 golden end-to-end (active→done, done idempotente, archived no-aborta).
- **R5 — 3 flags nuevos `--graduated-{manuales,especificaciones,release}` en `session-close`** (session073): cubre los 3 kinds canónicos que faltaban en el wire-up `session-close → HISTORY cross-link`. Total: 9 flags (6 canónicos + 3 legacy/alias). El flag legacy `--graduated-design` ahora se mapea al tag `especificacion` (antes producía URL rota `[DESIGN](val)`). Cobertura tests: 4 golden (1 por flag + alias).
- **Validación NNN-prefix en slugs graduados** (session073, R5 DEC-003): los flags `--graduated-{decisions,conclusions,manuales,especificaciones,release,scripts}` ahora rechazan slugs sin prefijo `^\d{3}-` con error claro. Escape hatch `--allow-loose-slugs` para casos manuales (tests legacy, slugs históricos). Root-cause del bug `HISTORY 049` que tenía `[CONCLUSION](../docs/conclusiones/mejoras-flujos-qtc-runtime.md)` sin prefijo NNN — fixed retroactivamente como parte del cleanup R1 en session072.
- **`BUILTIN_RENDERERS` en `history-row.ts` expandidos** (session073, R5): cubre los 12 kinds (con aliases): `dec/decision`, `plan`, `sql/script/scripts`, `conclusion/conclusions`, `manual/manuales`, `especificacion/especificaciones`, `release`. Antes faltaban `manual`, `especificacion`, `release`. El alias `design` legacy ahora rendera como `[ESPECIFICACION](...)`. Cobertura tests: 13 unit nuevos en `tests/unit/history-row.test.ts`.

### Why

R4 + R5 cierran 2 gaps estructurales detectados en el audit `docs/` (session072): planes que quedaban en `active` post-cierre + cross-links `HISTORY` rotos/faltantes. Ambos fixes son backwards-compatible: APIs existentes siguen funcionando idénticas. Las nuevas behaviors sólo se activan cuando hay `## Origin (plan)` o cuando se usan los flags nuevos. La validación NNN-prefix tiene escape (`--allow-loose-slugs`) para no romper scripts/tests legacy que asumen slugs sin prefijo.

### Tests

- Total: 586 (562 previos + 24 nuevos en este release).
- Suite verde, sin regresiones.

## [6.1.0] — 2026-05-18

**Minor additive — bundle del Sprint 1-4 del roadmap `docs/conclusiones/008-roadmap-export-plan-lifecycle.md` (session062).** Cierra F-C, F-E.2, F-E.3 y prepara consumo del bundle plugin v2.10.0 (F-A export-plan, F-B export-conclusions, F-F BACKLOG.md).

### Added

- **`--sessions NNN[,NNN]` cross-export** (F-C, session063): flag discreto en `agent-workflow history-data` y `agent-workflow release-data`. Toma precedencia sobre `--since` con warning informativo. Validación temprana: `INVALID_INPUT` para tokens no numéricos, `UNKNOWN_SESSION` para códigos inexistentes. Helper `parseSessionsCsv` + `validateSessionsExist` extraídos a `src/application/parsers/sessions-csv.ts`. Cobertura tests: 13 + 5 + 4 = 22 nuevos.
- **`--include-recent-closed [--recent-days N]` en `resume-summary`** (F-E.2, session067): cuando `active_sessions: []`, retorna `recent_closed_with_artifacts[]` con sesiones cerradas en ventana N (default 7 días) que cumplen heurística por flow:
  - `analyze`: EVIDENCE + FINDINGS + CONCLUSIONS presentes.
  - `dev`: TASKS con ≥50% closed + DECISIONS presente.
  - `design`: DELIVERY presente.
  Cobertura tests: 12 nuevos.
- **`--from-plan <NNN|path>` en `session-create`** (F-E.3, session067): acepta NNN (busca en `docs/planes/NNN-*.md`) o path explícito. Lee frontmatter YAML del plan, deriva `objetivo` desde `## Resumen` si vacío, append `## Origin (plan)` al OBJECTIVE generado, transición `state: draft → active` en frontmatter del plan con entry append-only en `state_changes[]`. Idempotente si `state == active`. Errores: `PLAN_NOT_FOUND`, `PLAN_ARCHIVED`, `PLAN_INVALID_FRONTMATTER`. Nuevo módulo `src/application/from-plan.ts` con parser YAML minimal. Output incluye `plan_transition: {plan, from, to}`. Cobertura tests: 13 nuevos.
- **`backlog_present` en `session-artifacts` payload** (F-F, session066): nuevo flag indica si la sesión tiene `BACKLOG.md` (artefacto opcional lazy). `backlog` agregado a `ArtifactKind` enum + `ARTIFACT_FILENAMES["backlog"]: ["BACKLOG.md"]`.
- **`scripts_sql_present` en `session-artifacts` payload** (F-D pre-flag, session069): nuevo flag indica si la sesión tiene `SCRIPTS.sql` (consolidado SQL). `scripts_sql` agregado a `ArtifactKind` + `ARTIFACT_FILENAMES["scripts_sql"]: ["SCRIPTS.sql"]`. La doctrina F-D BREAKING vive en el plugin v3.0.0 (session071); el flag CLI es additive y se incluye desde v6.1.0.

### Why

Habilita el consumo del bundle plugin v2.10.0:
- F-C es el habilitador del resto (sin él, ni `export-plan` ni `export-conclusions` ni `resume detect` pueden pasar refs discretas).
- F-E.2 + F-E.3 cierran el ciclo lifecycle `close-sin-impl → resume detect → propone export-* → ejecuta --from-plan`.
- `backlog_present` y `scripts_sql_present` informan a los skills consumidores qué artefactos lazy están disponibles.

### Tests

- Total: 562 (537 previos + 25 nuevos en este release).
- Suite verde, sin regresiones.

## [6.0.0] — 2026-05-18

**Major BREAKING — rename `RFC` → `Propuesta` en el contrato externo del CLI (flag, categoría de graduación, vocabulario de auto-plan).** El equipo qtc-* dejó de usar "RFC" como término; se reemplaza por "Propuesta" en todo el runtime.

### Changed (BREAKING)

- **Flag CLI**: `agent-workflow session-close --graduated-rfc <slug>` → `agent-workflow session-close --graduated-propuesta <slug>`. Los call sites del plugin actual no usaban este flag (sólo `--graduated-decisions/plan/scripts/design/conclusions`); workflows custom o scripts que pasen el flag viejo fallarán con "unknown option".
- **`graduation-check`**: walkea `<source>/docs/propuestas/` en lugar de `<source>/docs/rfcs/`. Workspaces históricos con `docs/rfcs/` van a reportar 0 orphans en esa categoría (falso negativo). Migración por workspace: `git mv docs/rfcs docs/propuestas`.
- **`auto-plan-decide`**: vocabulario `ANALYZE_KEYWORDS` y `PROPUESTA_KEYWORDS` (antes `RFC_KEYWORDS`) ya no incluyen `"rfc"`. OBJECTIVE con menciones a "RFC" ya no dispara `decision: "full"` automáticamente; usar "propuesta" en su lugar.

### Why

El usuario indicó que "RFC" no es un término que el equipo maneja y pidió cambiarlo a "Propuesta" en todo el runtime qtc-*. Es un rename de naming externo (flag + carpeta + vocabulario) + interno (identifiers TS).

### Migration

- Workspaces con sesiones que graduaron con `--graduated-rfc`: las filas históricas de `HISTORY.md` preservan el tag `rfc:` (es texto en la celda Refs, no se reprocesa). Sesiones nuevas usan `--graduated-propuesta` y el tag se renderiza como `propuesta:`.
- Workspaces con `docs/rfcs/` físicos: `git mv docs/rfcs docs/propuestas` para que `graduation-check` los detecte.
- Pareja con `qtc-workflow-plugin@>=2.9.0` (que también renombra `docs/rfcs/` → `docs/propuestas/` en sus refs y skills).

### Internal

- `src/application/auto-plan.ts`: `RFC_KEYWORDS` → `PROPUESTA_KEYWORDS`, `hasRfc` → `hasPropuesta`, `metrics.rfc` → `metrics.propuesta`.
- `src/application/graduation-check-service.ts`: `CATEGORIAS` actualizado (`rfcs` → `propuestas`).
- `src/application/orchestration.ts`: `ANALYZE_KEYWORDS` actualizado.
- `src/application/session-close-service.ts`: interface `graduatedRfc` → `graduatedPropuesta`, `FLAG_TO_TAG` actualizado (`rfc` → `propuesta`).
- `src/cli/commands/session-close.ts`: parsing del flag actualizado.
- `tests/unit/dev-graduate-service.test.ts`: kind inválido en "rejects unknown kind" usa `"unknown"` en vez de `"rfc"`.

### Tests

515/515 passing. Typecheck clean.

## [5.19.0] — 2026-05-17

**Minor — Gestión de cache de plugins por host desde el TUI + nuevo subcomando `plugin-cache`.** Resuelve el caso "actualicé el plugin pero el host sigue mostrando la versión vieja / no detecta nuevos skills" sin obligar al usuario a borrar dirs a mano. Cobertura: Claude Code, Codex, Warp y Oz/Agents.

### Added

- `src/application/self/plugin-cache-clear.ts` — `selfClearPluginCache(args, ctx)`. Borra el cache filesystem del plugin para el target indicado. Lógica por target: `claude`/`codex` borran `~/.{claude,codex}/plugins/cache/<marketplace>/<plugin>/` (todas las versiones) + entry en `installed_plugins.json` (el host re-instala al startup). `warp`/`agents` borran los skill dirs `~/.{warp,agents}/skills/<namespace>-*`. Idempotente: si nada para borrar → `status: nothing`.
- `src/application/self/plugin-cache-reload.ts` — `selfReloadPluginCache(args, ctx)`. Wrapper de clear + reinstall según target. Para `claude`/`codex` devuelve hint "reiniciá <host>" (el host es quien re-instala). Para `warp`/`agents` resuelve source desde `--from <path>` o auto-detecta desde el cache compartido de Claude Code/Codex, y delega a `selfInstallPluginSkills` con `--force`.
- Subcomando `agent-workflow plugin-cache <clear|reload> --plugin <ns> --target <claude|codex|warp|agents> [--from <path>] [--dry-run]` en `src/cli/commands/plugin-cache.ts`.
- TUI Plugins tab (`src/cli/tui/tabs/plugins-tab.tsx`) — acciones nuevas por host en el action menu: "Limpiar cache de Claude Code", "Recargar en Claude Code", equivalentes para Codex, "Limpiar instalación en Warp", "Recargar en Warp", equivalentes para Oz/Agents. Las filas del plugin ahora muestran las 4 targets (Claude, Codex, Warp, Agents) con estado `cacheado` / `instalado` / `no detectado`. Renombre del tab "Warp Plugins" → "Plugins".
- `tests/unit/plugin-cache-clear.test.ts` y `tests/unit/plugin-cache-reload.test.ts` — 14 tests cubriendo cada combinación target × estado: input inválido, missing cache (nothing), removal con installed_plugins.json update, dry-run no-touch, warp/agents skill dirs por prefix, codex sibling de claude, reload por host (cleared-only + hint), reload por skill-dir (clear + reinstall), reload sin source (SOURCE_NOT_FOUND), reload con `--from` explícito, reload dry-run.

### Behavior

- Cache filesystem clear es local — NO toca `enabledPlugins` en `settings.json`, NO modifica el marketplace ref. El plugin sigue enabled; el host re-clone al próximo startup.
- Reload para Claude Code/Codex incluye hint explícito de reiniciar el host (el CLI no puede forzar reload de skills runtime en el host activo).
- Comando idempotente: re-ejecutar sobre filesystem ya limpio devuelve `status: nothing` con exit 0.
- TUI usa los application services directamente (no via `process.run`) — más rápido y testeable. Toast con summary tras cada acción.

## [5.18.0] — 2026-05-17

**Minor — Nuevo PreToolUse hook `git-commit-advisor` (session053-dev-per-fuente-anchors-bash-hook).** Extiende la cobertura de hooks PreToolUse del runtime qtc-* a `Bash`. Detecta `git commit -m "..."` y emite advisor no-bloqueante (stderr + exit 0) cuando hay sesión activa y el mensaje no incluye el tag `session<NNN>`. Completa la opción E + F del CONCLUSIONS de session051: cerrar el gap de commits-fuera-de-sesión a nivel runtime (capa hook PreToolUse) sin romper ergonomía (advisor en lugar de gate).

### Added

- `src/application/hook-git-commit-advisor.ts` — implementación del hook. Lee stdin JSON (PreToolUse payload), filtra a `tool_name === "Bash"`, parsea `tool_input.command` buscando `\bgit\s+commit\b`, extrae mensaje de `-m "..."` o `-m '...'`, lee `QTC-PROJECT.Status.sessions` del cwd para resolver código de sesión activa, y emite advisor si el mensaje no incluye `/session\d{3}/i`.
- Subcomando `agent-workflow hook git-commit-advisor` en `src/cli/commands/hook.ts`. Convive con `branch-check` y `sql-mutation-guard`.
- `tests/unit/hook-git-commit-advisor.test.ts` — 12 tests cubriendo todos los casos (A/B/C/D/E/F/G/H): non-Bash, Bash sin git commit, --amend interactivo, sin QTC-PROJECT, sin sesión activa, sesión sin tag, sesión con tag, regex laxo `session\d{3}`, bypass `AW_COMMIT_ADVISOR=off`, comillas simples, JSON inválido, AGENTS.md fallback.
- Bypass env var `AW_COMMIT_ADVISOR=off` para desactivar el advisor en la sesión actual del host.

### Behavior preserved

- Hook es **no-bloqueante** (exit 0 siempre). Una fase 2 opt-in con gate hard (`AW_COMMIT_GATE=on` o similar) se evaluará tras observar uso real.
- Si el cwd no tiene `CLAUDE.md`/`AGENTS.md` con bloque `<!-- WORKFLOW-PROJECT-START -->`, hook degrada a no-op silencioso. Funciona en cualquier workspace sin requerir setup adicional.
- Coexiste con hooks pre-commit/commit-msg de git tradicionales — ambos se ejecutan independientemente.
- Mensajes sin `-m` (editor interactivo, `git commit --amend` sin nuevo mensaje, `git commit -F file`) se ignoran porque el hook no puede ver el contenido final del mensaje.

### Plugin wire-up

- `qtc-workflow-plugin` (vía `qtc-plugins-marketplace`) registra el hook en `hooks/hooks.json` y `codex-hooks/hooks.json` con `matcher: "Bash"` en una entry nueva de `PreToolUse[]` (coexistiendo con `branch-check` y `sql-mutation-guard`). Para que el advisor sea visible el usuario debe actualizar a esta versión del CLI **y** a la versión del plugin que registra el matcher Bash.

## [5.16.0] — 2026-05-12

**Minor — UX post-install del target Warp + subcomando `mcp warp-status` (session001-dev-fix-warp-mcp-target-path).** Los paths `~/.warp/.mcp.json` y `.warp/.mcp.json` ya son los correctos según docs.warp.dev (Warp los lee, con Auto-spawn On by default). El gap real era de UX: si el toggle global **File-based MCP Servers** está apagado en Settings, Warp detecta el archivo pero no spawnea el server, y el TUI marcaba `✓` sin avisar del paso pendiente. Esta versión cierra ese gap sin tocar paths/writer/reader.

### Added

- `src/application/mcp-warp-postinstall-hint.ts` — servicio puro `buildWarpPostInstallHint(name, scope, file)` que devuelve 5 líneas con los pasos para que Warp efectivamente spawnee el server (verificar toggle, reabrir tab/reiniciar app, confirmar provider en Settings). `formatWarpPostInstallHint` lo formatea para stdout.
- Campo opcional `warp_hint: WarpPostInstallHint` en `SelfMcpConfigData` (retornado por `install-warp` cuando el setup es exitoso). El TUI lo renderea en un panel info con borde redondeado.
- Campo opcional `warp_hints: WarpPostInstallHint[]` en el data de `mcp setup` cuando `--host warp` o `--host all/both` están incluidos.
- Subcomando `agent-workflow mcp warp-status` — inspecciona `<cwd>/.warp/.mcp.json` y `~/.warp/.mcp.json`, lista los `mcpServers` encontrados y devuelve el hint formateado por scope.
- Footer persistente en el tab **MCP** del TUI con el recordatorio: "Warp lee `.warp/.mcp.json` solo si File-based MCP Servers está activo en Settings".
- Detail informativo en `mcp doctor` para reportes `status=ok` con `host=warp` recordando activar el toggle.
- 8 tests nuevos en `tests/unit/mcp-warp-postinstall-hint.test.ts`.

### Changed

- TUI tab **MCP**: tras `install-warp` exitoso, el toast pasa a tono `info` (en vez de `success`) cuando hay acción pendiente del usuario; debajo aparece el panel `WarpHintPanel` con los pasos numerados.
- `mcp setup` summary diferencia warp del resto: cuando se escribe `.warp/.mcp.json`, el summary recuerda activar el toggle en lugar de declarar "instalado en Warp Terminal" sin matices.
- `biome.json`: ignora `.warp/**` y `.workflow/**` para evitar que el formatter toque artefactos del usuario.

### Behavior preserved

- Los paths del host `warp` (`~/.warp/.mcp.json` global y `.warp/.mcp.json` project) se mantienen sin cambios.
- Writer, reader y harness spec de Warp siguen igual: la única diferencia es la capa de UX que ahora comunica el paso pendiente.

### Tests

- 475 verdes (467 → 475, +8 del hint).

### Decisions

- **DEC-001 (session001-dev-fix-warp-mcp-target-path)**: dejar la decisión `DEC-W3` intacta (paths correctos según doc Warp) y resolver el bug solo por capa de UX. Alternativa descartada: convertir el target en "print + copy al clipboard" — más ruidosa y el usuario no quería pasos manuales.

## [5.15.0] — 2026-05-12

**Minor — TUI unificada por menús navegables (session048).** Toda la TUI pasa de "atajos por tecla dedicada" a "Enter abre menú navegable por target". El usuario ya no necesita memorizar mapeos de teclas: pulsa Enter sobre la fila y elige la acción con flechas.

### Added

- `MenuItemTrailing` opcional en `SectionedMenu`: icono + color + texto a la derecha del label. Permite mostrar estado por acción (instalado / no instalado / drift) sin componente nuevo.
- Sección **Skills** en `HelpOverlay` (antes no existía).
- Clamp defensivo del foco en `SectionedMenu` cuando los items cambian dinámicamente (cubre `update-tab` con install condicional).

### Changed

- **MCP tab**: Enter sobre una conexión abre un menú con `install-claude` / `install-codex` / `install-warp` (con estado por host), `doctor` y `remove`. Esc cierra. Atajos `c`/`x`/`w`/`d`/`D` retirados. `n` (nueva conexión) se mantiene.
- **Plugins tab**: Enter sobre un plugin abre un menú con install/reinstall en Warp/Agents (con estado por target) y clonar desde git. `n` abre un menú de target (Warp / Agents) para nuevo plugin desde URL. Atajos `w`/`W`/`a`/`A`/`r`/`R`/`N` retirados.
- **Skills tab**: cursor navegable por target con `↑↓`. Enter abre menú con "Instalar/Reinstalar" (siempre, con trailing) y "Desinstalar" (solo si el target está instalado). Acciones llaman `selfInstallSkill --target <X>` / `selfUninstallSkill --target <X>`. Atajo `i`/`I` global retirado. Ahora la instalación es granular por target en vez de todos a la vez.
- **Update tab**: reubicado al final del orden (`Status / MCP / Skills / Plugins / Update`). Tecla `4` ahora va a Plugins; `5` a Update. El item "Actualizar ahora" deja de mostrarse por defecto: aparece únicamente cuando `Buscar actualizaciones` detecta `outdated`, con la versión objetivo en la etiqueta (`Actualizar a vX.Y.Z (npm install)`).
- `KeymapBar` por tab simplificado: `MCP` y `Plugins` muestran `↑↓ / ⏎ / n`; `Skills` muestra `↑↓ / ⏎`. `HelpOverlay` reescrito por sección.
- `SectionedMenu`: refactor a `SectionRow` / `ItemRow` para mantener complejidad cognitiva acotada tras agregar `trailing`.

### Tests

- 467 verdes (sin regresiones).
- 2 tests de `tui-update-tab.test.tsx` adaptados a la nueva semántica (install condicional al `outdated`).

### Decisions

- **DEC-001 (session048)**: extender `SectionedMenu` con `trailing` opcional en lugar de crear un componente nuevo `ConnectionActionMenu`. Reusa la lógica de foco / wrap-around / `defaultValue`; cambio aditivo y retrocompatible para los consumidores existentes (`update-tab`).

## [5.11.5] — 2026-05-10

**Patch — TUI dispatch de update sin doble-confirm (session043).**

### Fixed

- Tras pulsar **"Actualizar ahora (npm install)"** en el Update tab, el flujo seguía mostrando el `inquirer.confirm` y devolvía `(cancelled)`. Causa: el `await waitUntilExit` de session042 no era suficiente para drenar todos los bytes residuales que ink dejaba en stdin tras el unmount; inquirer los interpretaba como force-close. Solución correcta: el menú del TUI ya **es** la confirmación — pedir `(Y/n)` además es redundante. Ahora `dispatchMenuAction("update")` dispatcha `aw self update --yes`, que salta el `inquirer.confirm` y va directo a `npm install`. Cero race condition porque inquirer ni siquiera se invoca.

### Added

- **`--yes` / `-y`** en `aw self update`: salta el confirm de TTY y procede al install. Útil tanto desde el TUI (automático) como en scripts CI.

### Behavior preserved

- Llamar `aw self update` directamente desde shell **sin** `--yes` sigue mostrando el `inquirer.confirm` antes de instalar. La protección "estás seguro" se mantiene para invocaciones manuales en CLI.

### Tests

- 404 verdes (+2 vs 5.11.4): `--yes` salta confirm aún con TTY simulado; `-y` es alias equivalente.

## [5.11.4] — 2026-05-10

**Patch — UpdateTab con menú + fix race ink/inquirer (session042).**

### Fixed

- **Race condition en `runTui`**: tras pulsar `u` en Update tab, `runTui` resolvía vía `onResult` sin esperar a que ink completara su unmount. El siguiente comando (`aw self update` con su `inquirer.confirm`) se enganchaba a una stdin que ink todavía estaba liberando, viendo bytes residuales que inquirer interpretaba como force-close → output siempre `(cancelled)`. Fix: tras capturar el `TuiResult`, hacer `await instance.waitUntilExit()` antes de devolverlo. Garantiza que el terminal queda limpio para el siguiente consumidor.

### Changed

- **Update tab rediseñado** (sin hotkey suelto `u`): ahora muestra un menú navegable con dos opciones:
  - **"Buscar actualizaciones"** — corre `npm view <pkg> version` vía `ctx.process.run` y muestra el resultado en TUI (toast verde "Ya estás en la última versión" o azul info "Hay versión más reciente: vX.Y.Z").
  - **"Actualizar ahora (npm install)"** — exit + dispatch al CLI para `npm install -g <pkg>@latest` (igual flujo que antes, pero deliberado en vez de tecla escondida).
- KeymapBar de Update tab ahora indica `↑↓ navegar · ⏎ seleccionar` (consistente con el resto).

### Tests

- 402 verdes (+4 vs 5.11.3): nuevo `tui-update-tab.test.tsx` cubre render del menú, "Buscar actualizaciones" llama `npm view`, comparación uptodate/outdated, y "Actualizar ahora" llama `onRequestUpdate`.

## [5.11.3] — 2026-05-10

**Patch — `aw self update` ya no falla con UNHANDLED al cancelar el confirm (session041).**

### Fixed

- Cuando el usuario cancelaba el prompt de confirmación de `aw self update` con Ctrl-C / Esc, inquirer lanzaba `ExitPromptError` ("User force closed the prompt with 0 null") que se propagaba hasta el dispatcher y salía como `{"ok": false, "error": {"code": "UNHANDLED", ...}}` con exit code 1. Ahora se captura la excepción y se trata igual que un "no" explícito: `command: "(cancelled)"`, `exitCode: 0`. Aplica también cuando el usuario pulsa `u` en el Update tab del TUI y luego cancela en la confirmación que aparece en shell.
- Como bonus se hizo inyectable la función de confirm (`selfUpdate(args, ctx, confirm?)`), permitiendo cubrir con tests los 3 caminos (cancel/no/yes) sin depender de un TTY real.

### Tests

- 398 verdes (+3 vs 5.11.2): cancel-throws → cancelled, no → cancelled, yes → npm install. Vía mock de `confirmFn` con `process.stdout.isTTY` patcheado.

## [5.11.2] — 2026-05-10

**Patch — Esc cancela edit mode (session040).** Bug reportado sobre 5.11.1.

### Fixed

- En los modos de input del wizard MCP (`new-name`, `new-dsn`), pulsar `Esc` no cancelaba ni regresaba al list mode. Causa: `TextInput` de `@inkjs/ui` no expone `onCancel` y mi listener de Esc previo sólo cubría `confirm-delete`. Se agregó un tercer `useInput` en `McpTab` que coexiste con el del TextInput y reacciona a `key.escape` cuando `mode.kind ∈ {new-name, new-dsn}`, devolviendo al list mode (libera el input lock + restaura el keymap).

## [5.11.1] — 2026-05-10

**Patch — fixes UX reportados sobre 5.11.0 (session039).** Tres bugs concretos que afectaban la usabilidad básica de la TUI con tabs.

### Fixed

- **Línea `═══` debajo del tab activo eliminada**: la regla decorativa que dibujaba debajo del bracket `[ activo ]` no alineaba con el ancho real del label, ensuciando el header. La TabBar ahora renderea en una sola línea con sólo brackets en accent. (`components/tab-bar.tsx`)
- **Hotkeys globales (`q`, `Tab`, `?`, `1..4`) ya no se disparan mientras se escribe en un TextInput**: escribir `qwerty` en el campo "Nombre de la nueva conexión" ya no cierra el TUI (la `q` global no captura más). Se agregó `InputLockContext` (`src/cli/tui/input-lock.tsx`) que el `McpTab` activa al entrar a cualquier modo no-list (input prompt o confirm modal) y libera al volver a list mode. La KeymapBar también cambia dinámicamente a `⏎ aceptar · Esc cancelar` cuando hay lock, indicando claramente las teclas válidas.
- **Confirm-delete rediseñado como modal warning bordereado**: ya no es un texto plano debajo de la tabla. Ahora usa el nuevo `ConfirmModal` (`components/confirm-modal.tsx`) con borde redondeado en color `warning`, ícono `⚠`, título "Eliminar conexión", body de 2 líneas (incluye "Esta acción no se puede deshacer") y opciones `y / n+Esc` apiladas verticalmente. Además, el toast de la acción anterior se limpia automáticamente al entrar a cualquier modal — ya no aparecen dos `✗` superpuestos.

### Added

- `src/cli/tui/input-lock.tsx`: contexto global con `lock()` / `unlock()` / `locked`. Usado por `App` para gatear su `useInput` global.
- `src/cli/tui/components/confirm-modal.tsx`: componente reusable para confirmaciones con tone (`warning` / `danger` / `info`), título + body multi-línea + opciones `confirmKey / cancelKey`.

### Tests

- 395 tests verdes (+6 vs 5.11.0):
  - 3 nuevos en `tui-input-lock.test.tsx`: locked=false el handler global recibe `q`; locked=true NO la recibe; smoke de la API del context.
  - 3 nuevos en `tui-confirm-modal.test.tsx`: render con título + body multi-line; body string como una línea; borde redondeado presente.
  - 1 ajustado en `tui-tab-bar.test.tsx`: ahora espera 1 línea en vez de 2 (regla eliminada).

### Decisions

- **DEC-018**: el lock global se implementa con React Context, no con prop drilling. Razón: cualquier futuro tab que abra inputs (Skills si pide path custom, Settings, etc.) puede usar el mismo `useInputLock()` sin tocar `App`. La alternativa (prop drilling) hubiera obligado a propagar `onInputLock` por toda la jerarquía.
- **DEC-019**: durante `busy` (await async) también se mantiene el lock. Razón: las operaciones MCP son <1s típicamente; permitir Tab/q durante un await crea race conditions con setState post-unmount. Trade-off aceptado.

## [5.11.0] — 2026-05-10

**Minor — Reestructuración a UI con tabs (session038).** Reemplaza el menú lineal por una TUI con tabs horizontales + contenido contextual por tab. Patrón Crush adaptado: Status (health), MCP (tabla interactiva con hotkeys), Skills (estado + reinstalar), Update (delega a npm). Header con cwd, keymap dinámica por tab, overlay de ayuda con `?`.

### Added

- **Tabs**: 4 contextos navegables con `Tab/⇧Tab` o `1..4`:
  - **Status** — overview ejecuta `selfDoctor` + lee MCP connections; checklist con `✓`/`✗` por chequeo (CLI, Skill en Claude, Skill en Codex, Conexiones MCP).
  - **MCP** — tabla interactiva con row-selection (↑↓), hotkeys: `n` (nueva), `c` (install Claude), `x` (install Codex), `d` (doctor), `D` (eliminar con confirmación). Toast inline con resultado de la última acción.
  - **Skills** — estado de la skill por target + hotkey `i` para reinstalar/actualizar (force).
  - **Update** — versión actual + paquete; hotkey `u` cierra el TUI y delega a `npm install -g <pkg>@latest`.
- **Header con breadcrumb**: brand + version a la izquierda, `~/path/al/cwd` a la derecha. Helper `prettyPath` colapsa `$HOME` a `~`.
- **Help overlay** (`?`): panel bordereado con la lista completa de teclas globales + teclas de MCP. Esc/`?`/q cierran.
- **Toast inline** (`components/toast.tsx`): feedback de acciones con `tone: success | error | info` + ícono y color del tema.
- **TabBar component** (`components/tab-bar.tsx`): renderea tabs con brackets `[ ]` y línea `═` debajo del activo; soporta badge `(N)` por tab.
- **ConnectionsGrid** (`components/connections-grid.tsx`): tabla custom row-selectable (no Unicode box-drawing). Cursor `❯` en fila activa.

### Changed

- **`src/cli/tui/app.tsx`** rewrite completo: ahora es un controlador de tabs con `useInput` global (Tab/⇧Tab/1-4/q/?), keymap dinámico por tab, y monta el tab activo. Las acciones que requieren spawn externo (npm update) salen del TUI y delegan al dispatcher de `main.ts`; el resto se resuelve inline.
- **Header** (`components/header.tsx`): pasa de `version + subtitle` a `version + cwd`. El subtitle se eliminó (ahora la TabBar comunica el contexto).
- Connections se muestran en una tabla espaciada por columnas, no más box-drawing dentro del TUI (el `formatConnectionsTable` original sigue para output JSON/headless).

### Removed

- `src/cli/tui/screens/main-menu.tsx` (reemplazado por TabBar + tabs/).
- `src/cli/tui/screens/mcp-wizard.tsx` (toda la lógica está ahora en `tabs/mcp-tab.tsx`).
- `src/cli/tui/screens/mcp-done.tsx` (resultado se muestra como Toast inline).

### Tests

- 389 tests verdes (+10 vs 5.10.1):
  - 4 nuevos en `tui-tab-bar.test.tsx` (brackets, labels, badge, línea ═).
  - 4 nuevos en `tui-connections-grid.test.tsx` (placeholder, header, status icons, cursor).
  - 7 nuevos en `tui-app-tabs.test.tsx` (Status default, header con `~`, Tab cambia, número 3, q sale, ? abre help).
  - Eliminado `tui-main-menu.test.tsx` (componente obsoleto).

### Decisions

- **DEC-015**: tabs en lugar de sidebar. Razón: la UI hereda los contextos del modelo de comandos (`status` = doctor, `mcp` = sub-comando con sub-acciones, `skills` = install-skill, `update` = self-update). Un sidebar con item-detalle hubiera implicado dos navegaciones para llegar a una acción simple; con tabs todo es 1 keystroke.
- **DEC-016**: las acciones MCP usan **hotkeys de una sola tecla** (`c`, `x`, `d`, `D`, `n`) en vez de menú anidado. Más rápido para usuarios recurrentes; los keymaps se muestran en la KeymapBar inferior y en el `?` overlay para discoverability.
- **DEC-017**: `npm install -g` queda fuera del TUI por choque de stdout (npm escribe líneas mientras ink controla la pantalla). El UpdateTab hace `onResult({ kind: "menu-action", action: "update" })`, que sale del TUI y dispara el dispatcher original. Trade-off: pierde la sensación "todo dentro del TUI" pero garantiza output limpio.

## [5.10.1] — 2026-05-10

**Patch — UX polish de la TUI inspirado en charmbracelet/crush (session037).** Mismos screens que 5.10.0, mejor estética: paleta cohesiva, marco redondeado por pantalla, jerarquía visual más clara y barra de teclas persistente.

### Added

- `src/cli/tui/theme.ts`: paleta + iconografía centralizada. 4 niveles de foreground (`fg`/`fgSubtle`/`fgMoreSubtle`), accent (`cyan`) distinto de primary (`magenta`), iconos minimal Unicode (`◆ ✓ ✗ ❯ → ─ › ●`).
- `src/cli/tui/components/screen-frame.tsx`: wrapper `<Box borderStyle="round">` que encuadra cada pantalla con padding generoso (`paddingX={2}`, `paddingY={1}`).
- `src/cli/tui/components/keymap-bar.tsx`: barra de teclas inferior con formato `key action · key action`, key en accent bold + action en gray.

### Changed

- **Header** (`components/header.tsx`): de `agent-workflow v5.10.0` plano a una línea bicolor — `◆ agent-workflow · v… · subtitle` con accent en el subtítulo. Una sola fila en vez de dos.
- **SectionedMenu**: secciones ahora tienen accent + `marginTop={1}` (en vez de `── X ──`); items con bullet `❯` en focus + bold; items no-focused con bullet vacío + color subtle. Menos ruido, más jerarquía.
- **MainMenu / McpWizard / McpDone**: cada screen envuelta en `ScreenFrame`. Reemplazo de `<Footer hint="…">` por `<KeymapBar entries={…}>` estructurada.
- **InputPrompt**: prompt mark `›` en accent + arrow `→` antes del campo de input. Errores con icono `✗` en rojo.
- **McpDone**: status icon `✓`/`✗` en color (verde/rojo) en vez de prefijo de texto.
- **ConnectionsTable**: placeholder vacío en `fgMoreSubtle` italic; tabla rendea con color `fgSubtle` para que destaque sobre la prosa.
- Eliminado `src/cli/tui/components/footer.tsx` (reemplazado por `KeymapBar`).

### Tests

- 1 test ajustado: `tui-sectioned-menu.test.tsx` ahora valida `── Grupo A` (sin trailing dashes — el render del separator label cambió).
- 379 tests verdes (igual que 5.10.0).

### Decisions

- **DEC-013**: paleta basada en colores nombrados de ink (16-color) en vez de hex. Razón: máxima compatibilidad con terminals que no soportan truecolor; charmtone-style se logra con foreground hierarchy + accent contrast en vez de gradientes.
- **DEC-014**: tomada inspiración de Crush, NO copiado. Mantenemos los íconos Unicode mínimos comunes (`◆ ✓ ✗ ❯ →`) en vez de dependencias de iconos custom; nuestra TUI es funcional, no decorativa.

## [5.10.0] — 2026-05-10

**Minor — TUI con ink para el menú interactivo + wizard MCP (session036).** Reemplaza la fachada `@inquirer/prompts` del menú principal y del wizard `self mcp` por una TUI basada en [ink](https://github.com/vadimdemedes/ink). Los comandos headless (skills/IA) no cambian: cualquier invocación con args sigue produciendo el mismo JSON de antes.

### Added

- **TUI ink-based** para el flujo interactivo (`agent-workflow` sin args + TTY):
  - `src/cli/tui/screens/main-menu.tsx`: menú principal con secciones `── Verificar / configurar ──` y `── Mantenimiento ──`, navegable con ↑↓ + ⏎.
  - `src/cli/tui/screens/mcp-wizard.tsx`: wizard MCP completo dentro de ink. Reemplaza inline las llamadas `prompts.select` / `prompts.input` por `<SectionedMenu>` / `<TextInput>` (de `@inkjs/ui`).
  - `src/cli/tui/screens/mcp-done.tsx`: pantalla de confirmación tras completar una acción MCP (verde/rojo + tabla de conexiones actualizada). `⏎` vuelve al menú; `q` sale.
  - `src/cli/tui/components/sectioned-menu.tsx`: menú con separadores, wrap-around, `defaultValue`-aware.
  - `src/cli/tui/components/connections-table.tsx`: render del box-table (re-usa `formatConnectionsTable`).
  - `src/cli/tui/components/input-prompt.tsx`: `TextInput` con soporte para `validate` (re-render con error inline).
  - `src/cli/tui/run.tsx`: punto de entrada `runTui(version, ctx)` que devuelve `TuiResult` (menu-action / exit).
- **Tests TUI** con `ink-testing-library`:
  - `tui-main-menu.test.tsx` (5): render, navegación con ↑↓ + ⏎, foco inicial, paridad de etiquetas.
  - `tui-sectioned-menu.test.tsx` (4): salto de separadores, wrap-around, `defaultValue` posiciona foco.
  - `tui-connections-table.test.tsx` (2): placeholder vacío + render con datos.
- Dependencias runtime: `ink@^5`, `react@^18`, `@inkjs/ui@^2`. Dev: `@types/react`, `ink-testing-library@^4`.
- `tsconfig.json`: `jsx: "react-jsx"` + `jsxImportSource: "react"`.

### Changed

- `src/cli/main.ts`: ahora construye `CliContext` antes del check `shouldShowInteractiveMenu` para poder pasarlo a la TUI. Cuando hay TTY y no hay comando, ejecuta `runTui(...)` en lugar de `runInteractiveMenu` (eliminado).
- `src/cli/interactive-menu.ts`: queda sólo el predicado `shouldShowInteractiveMenu` y el tipo `MenuAction`. La función `runInteractiveMenu` se eliminó (reemplazada por `runTui`).
- El comando `aw self mcp` headless mantiene `@inquirer/prompts` como fallback (skill/IA siguen funcionando vía dynamic import en `loadPrompts`).
- `vitest.config.ts`: include añade `tests/**/*.test.tsx`.

### Tests

- 379 tests pasando (+11 vs 5.9.3):
  - 5 nuevos en `tui-main-menu.test.tsx`.
  - 4 nuevos en `tui-sectioned-menu.test.tsx`.
  - 2 nuevos en `tui-connections-table.test.tsx`.

### Decisions

- **DEC-010**: dual-mode estricto. TUI sólo se monta cuando `command === undefined && isTTY === true`. Cualquier invocación con argumentos (caso skill/IA/script) salta directo al dispatcher con JSON; cero overhead de ink/react para automatización.
- **DEC-011**: el wizard MCP corre dentro de ink reusando el mismo `selfMcpConfig` del dominio — la TUI sólo provee un adapter alternativo para `SelfMcpPrompts` (mismo contrato que ya existía en 5.9.x). No se duplica lógica de negocio.
- **DEC-012**: `update`, `doctor`, `install-skill`, `help` siguen saliendo de la TUI para ejecutarse como comandos one-shot (mantienen output JSON para parity con headless). Re-entrar a la TUI tras esas acciones queda fuera de scope; el usuario relanza `aw` si quiere otra acción.

## [5.9.3] — 2026-05-09

**Patch — UX polish del wizard MCP + backups transitorios (session035).** Dos mejoras complementarias en el flujo de `agent-workflow self`:

### Changed

- **Tabla de conexiones con status icons**: `si`/`no`/`drift` se renderizan como `✓` / `–` / `!` (1 char visible). Headers acortados a `nombre` / `DSN var` / `Claude` / `Codex`.
- **Header contextual antes de la tabla**: `Conexiones MCP registradas (N):` + tabla + leyenda `✓ instalado · – no instalado · ! drift de configuración`. La leyenda ayuda al primer encuentro con los símbolos.
- **Choices del menú post-tabla con prefix + Separator**: agrupa `── Instalar / Actualizar ──` (Claude Code, Codex), `── Operar ──` (Diagnosticar, Eliminar), y bloque final separado para Cancelar. Símbolos `▸` / `·` / `✗` / `⏎` para jerarquía visual.
- **Menú raíz `agent-workflow self` con misma estructura**: separador `── Verificar / configurar ──` (Doctor, Skill, MCP) y `── Mantenimiento ──` (Update, Help) + Salir aislado.
- **Wizard `mcp` también separado por intención**: `── Conexiones existentes ──` y `── Registrar nueva conexión ──`.
- **Mensajes de prompt más específicos**: `Conexión a operar` (en vez de `Conexión`), `Nombre de la nueva conexión (slug-kebab)`, `Variable de entorno con la DSN (UPPER_SNAKE_CASE)`.
- **`SelfMcpPrompts.select` admite separadores** vía `{ type: "separator", separator?: string }`; `loadPrompts` los traduce a `Separator()` real de `@inquirer/prompts`.

### Fixed

- **Backups `<file>.bak.<ts>` ahora son transitorios**: tras `setup` o `remove` exitoso se eliminan automáticamente. Antes quedaban acumulados en `.claude/`, `.mcp.json`, `.claude.json` y `.codex/config.toml` después de cada operación.
- **Purge histórico al iniciar**: cada `setup`/`remove` purga `<file>.bak.<digits>` previos del archivo objetivo (limpieza de versiones anteriores).
- **Cleanup legacy también pasa por purge + discard**: el barrido de `mcpServers` en `.claude/settings.json` ya no deja `.bak` huérfanos.
- `result.backup` ahora es `null` en happy path. Si el `writeFileSync` lanza, el `.bak` queda como recovery (best-effort).

### Tests

- 368 tests pasando (+1 vs 5.9.2):
  - 4 reescritos en `format-connections-table.test.ts` para validar status icons (`✓`/`–`/`!`) y headers cortos.
  - 1 reescrito en `mcp-host-writer.test.ts`: `result.backup === null` tras write OK + 0 archivos `.bak.*` en disco.
  - 1 nuevo en `mcp-host-writer.test.ts`: pre-existing `.bak.<digits>` se purgan al iniciar el write.
  - 1 actualizado en `self-mcp-config.test.ts`: assertion contra fila con icons.

### Decisions

- **DEC-008**: status icons elegidos = `✓` / `–` / `!`. Evitamos emojis (dependientes de fuente/terminal); estos 3 están en BMP y se renderizan en cualquier terminal moderna.
- **DEC-009**: el `result.backup` retorna `null` en happy path. La promesa "no dejes residuos" prioriza limpieza visible sobre rastro de auditoría — quien quiera auditoría tiene git/snapshots externos.

## [5.9.2] — 2026-05-09

**Patch — render box-drawing del listado de conexiones MCP (session034).** El header del prompt en `agent-workflow self mcp` mostraba el pipe-table markdown (`| nombre | DSN var ... |`) literal porque `@inquirer/prompts` no renderiza markdown. Ahora la tabla usa caracteres Unicode de box-drawing (`┌─┬─┐ │ ├─┼─┤ └─┴─┘`) con anchos de columna calculados a partir de header + celdas. Headers acortados a `nombre`, `DSN var`, `Claude Code`, `Codex`. Sin nuevas dependencias.

### Changed

- `formatConnectionsTable` (ahora exportada en `src/application/self/mcp-config.ts`) emite tabla box-drawing con padding interno fijo y anchos auto-calculados.

### Tests

- 367 tests pasando (+5 vs 5.9.1):
  - 5 nuevos en `tests/unit/format-connections-table.test.ts` cubriendo: caso vacío, una conexión, anchos auto-ajustados, múltiples conexiones, snapshot exacto.
  - 1 actualizado en `self-mcp-config.test.ts` (assertion contra `│ ... │` en vez de `| ... |`).

## [5.9.1] — 2026-05-09

**Patch — Claude Code MCP target fix (session033).** Tras 5.9.0 los servidores MCP escritos por `agent-workflow self` y `agent-workflow mcp setup` quedaban en `.claude/settings.json`, archivo que Claude Code no consulta para `mcpServers`. Ahora se escribe en el archivo canónico según la doc oficial de Claude Code: `.mcp.json` para project scope (workspace) y `~/.claude.json` para user scope (global). Codex sigue intacto en `.codex/config.toml`.

### Changed

- `mcp-host-writer.ts` redirige el writer/remover de Claude: `<scopeDir>/.mcp.json` para `scope=workspace`, `<scopeDir>/.claude.json` para `scope=global`. `ScopeInput` admite ahora `kind?: "workspace" | "global"` (default `workspace`).
- `mcp-host-reader.ts` lee del mismo archivo según `kind`. La firma de `readMcpEntry` añade un parámetro opcional `kind` (default `workspace`).
- `mcp-setup-service.ts` y `mcp-remove-service.ts` propagan el scope al writer y actualizan el hint de refusal global a `~/.claude.json` / `~/.codex/config.toml`.
- `mcp-doctor-service.ts` consulta el snapshot pasando el scope al reader, alineado con el nuevo target.

### Fixed

- `/mcp` en Claude Code ahora detecta los MCP `cert` / `prod` registrados via wizard. Antes Claude Code los ignoraba porque `.claude/settings.json` no es fuente de `mcpServers` (solo hooks/permissions).

### Migrated

- Cleanup automático: cada `setup` o `remove` borra de paso la entrada `mcpServers[name]` en `.claude/settings.json` legacy si existe, dejando intactas `permissions` y demás claves. La operación crea backup `.claude/settings.json.bak.<ts>`.

### Tests

- 362 tests pasando (44 archivos). +5 vs 5.9.0:
  - 2 nuevos en `mcp-host-writer.test.ts` (cleanup legacy con/sin entradas remanentes).
  - 1 nuevo en `mcp-host-writer.test.ts` (global scope → `.claude.json`).
  - 1 nuevo en `mcp-host-reader.test.ts` (project scope ignora `.claude/settings.json` legacy).
  - 1 nuevo en `mcp-host-reader.test.ts` (global scope lee `.claude.json`).

### Decisions

- **DEC-005**: `.claude/settings.json` queda reservado para hooks / permissions / `additionalDirectories` (multiroot, hub-init). No se usa más para MCP. Razón: la doc oficial de Claude Code (`code.claude.com/docs/en/mcp`) no la lista entre los archivos de scope MCP.
- **DEC-006**: Mapeo de scopes CLI → scopes Claude Code: `workspace` → project (`.mcp.json` checkeable a git), `global` → user (`~/.claude.json`). El scope "local" de Claude Code (entries por proyecto en `~/.claude.json`) no se expone porque colisiona semánticamente con nuestro `workspace`.
- **DEC-007**: El cleanup legacy es one-shot por entrada (no purge masivo): se ejecuta en cada `setup`/`remove` que toque la misma entry. Razón: minimizar riesgo de borrar configuración de otros consumidores que hayan usado el mismo nombre.

## [5.9.0] — 2026-05-09

**Minor — manual MCP config flow desde `agent-workflow self` (session032).** Agrega un wizard interactivo para configurar conexiones MCP de BD sin pasar por `mcp setup` directo: nombres normalizados (no solo `cert|prod`), DSN persistido en `~/.workflow/dev/dsn.env` sin imprimirlo en claro, install/uninstall por host (Claude/Codex), y diagnóstico contra el MCP doctor existente. Acompaña la R3 de session031 (verificar instalación global del usuario).

### Added

- **Submenú MCP en `agent-workflow self`** — flujo interactivo con acciones `list`, `use-env`, `create-env`, `install-claude`, `install-codex`, `doctor`, `remove`, `cancel`. Soporta nombres custom además de `cert`/`prod`.
- **`mcp-connections-service`** — CRUD de conexiones registradas (read/upsert/delete) sobre el almacenamiento actual del CLI.
- **`mcp-remove-service`** — desinstalación por host preservando otras entradas del usuario en `.claude/settings.json` / `.codex/config.toml`.
- **`self/mcp-config`** — orquesta el wizard, captura DSN sin echo, deriva `mcpEntryNameFor` y compone con `runMcpSetup` / `runMcpDoctor` / `runMcpRemove`.
- **Tests nuevos** — `mcp-remove-service.test.ts` (3) + `self-mcp-config.test.ts` (cubre flujos principales y errores).
- **`mcp-host-writer`** — soporte de remove preservando entradas no-MCP.

### Changed

- **`mcp-entry`**: `validateMcpInstance` acepta nombres normalizados (`qtc-<nombre>`) además de `cert`/`prod`. `normalizeDsnVarName` y `validateDsnVarName` exportados para reuso (DEC-001).
- **`mcp-dbhub-launcher`**: `resolveDsn()` ahora resuelve `DB_<NORMALIZED>_DSN` derivado del nombre custom (DEC-002).
- **`mcp-doctor-service`**: errores con `ok:false` preservan `data` para que el wizard pueda mostrar `data.reports` y guiar la corrección de drift (DEC-003).
- **`agent-workflow self`**: el menú interactivo expone la nueva entrada MCP-config.
- Refactors menores en commands (`mcp.ts`, `self.ts`, `session-*`, `sources.ts`, `project-md-upsert.ts`) y descripción del paquete generalizada (no menciona `qtc-workflow-plugin` puntualmente).

### Decisions (session032)

- **DEC-001**: nombres MCP normalizados expuestos como `qtc-<nombre>` — compatibilidad con `cert`/`prod` + conexiones manuales.
- **DEC-002**: DSN custom en `~/.workflow/dev/dsn.env` con clave `DB_<NORMALIZED>_DSN` — reutiliza el almacén actual del CLI.
- **DEC-003**: preservar `data` cuando un comando devuelve `ok:false` — habilita diagnóstico accionable en `mcp doctor`.

### Tests

- 357 tests passing (vs 348 en 5.7.0; +9 netos). Build: `tsc` limpio.

## [5.7.0] — 2026-05-09

**Minor — clean install flow for fresh machines (session030).** Cierra el gap descubierto en T6 de session029: la skill legacy `agent-workflow-manager` persistía en `~/.agents/skills/` (registry de un installer multi-agent que sirve a Codex, Claude Code, Cursor y otros), fuera del scan de `self doctor`. La sesión agrega un tercer target `agents`, un subcomando para desinstalar y un wizard de bootstrap.

### Added

- **`self uninstall-skill`** (subcomando nuevo). Flags:
  - `--target <claude|codex|agents|all>` (default `all`).
  - `--legacy` (también borra `agent-workflow-manager` en el target).
  - `--dry-run` (preview sin tocar fs).
  - Cuando opera sobre `agents`, actualiza `~/.agents/.skill-lock.json` removiendo las entries `skills.<name>` (preserva `dismissed`, `lastSelectedAgents` y todo lo demás). Si el lock está malformado, emite `lock_warning` y lo deja intacto (failsafe).
  - Output JSON: `{ status, removed: [{target, path, kind, status}], lock_updated, lock_path?, lock_warning? }`.
- **`self bootstrap`** (subcomando nuevo). Wizard no-interactivo de instalación limpia:
  1. Llama a `self doctor` y captura leftovers.
  2. Si hay legacy → ejecuta `self uninstall-skill --legacy --target all` automáticamente.
  3. Ejecuta `self install-skill --force --target all` (claude+codex).
  4. Imprime `next_steps[]` con los comandos para instalar el plugin `qtc` en cada harness detectado.
  - Soporta `--dry-run` (cascadea a sub-pasos).
- **Target `agents`** en `InstallTarget`: `~/.agents/skills/agent-workflow/`. Disponible en `--target` de install/uninstall/doctor.
- Constantes públicas en `install-skill.ts`: `AGENTS_LOCK_REL`, `LEGACY_SKILL_NAME` para reuso por uninstall y doctor.
- **3 archivos nuevos de tests**: `self-uninstall-skill.test.ts` (7 tests), `self-bootstrap.test.ts` (3 tests), tests adicionales en `self-doctor.test.ts` (4 escenarios para target agents incluyendo lock parsing y malformed lock failsafe).

### Changed — `self doctor`

- **`skill.targets[]` ahora incluye `agents`** cuando `~/.agents/` existe. Cada entry de target `agents` agrega 4 campos opcionales: `lock_present`, `lock_canonical_entry`, `lock_legacy_entry`, `lock_warning`. Detecta legacy `agent-workflow-manager` tanto en filesystem (`legacy_leftover`) como en lock (`lock_legacy_entry`).
- `legacy_leftover_warning` actualizado para sugerir `agent-workflow self uninstall-skill --legacy` en lugar del manual `mv` viejo.
- Para targets `claude`/`codex` el comportamiento sigue idéntico — solo se agrega el target `agents` cuando el directorio existe.

### Changed — `self install-skill`

- `--target` choices acepta también `agents` (single-target opt-in).
- `--target=all` mantiene comportamiento de session029: instala en `claude` + `codex` (no en `agents` por default — el agents target es opt-in para quienes usan el skill-installer multi-agent). Sin breaking changes vs 5.6.0.

### Migration

Sin cambios de output JSON breaking. La nueva entry `agents` en `skill.targets[]` aparece sólo cuando existe `~/.agents/` (tooling que la consume nuevo o ausente sigue funcionando idéntico). El nuevo subcomando `bootstrap` reemplaza el flujo manual previo (instalar CLI → install-skill → instalar plugin); recomendado correrlo en máquinas nuevas.

**Fresh-machine flow recomendado:**
1. `npm install -g @tacuchi/agent-workflow-cli`.
2. `agent-workflow self bootstrap` (limpieza + dual-target install).
3. Instalar el plugin `qtc` en Claude Code/Codex con los comandos que imprime `next_steps[]`.

### Tests

- 348 tests passing (vs 335 en 5.6.0; +13 netos: 7 uninstall + 3 bootstrap + 4 doctor agents + 1 self-command actualizado para los 6 subcomandos). Lint: 0 errors, 1 warning pre-existente en `runSessionClose` (fuera de scope). Build limpio.

## [5.6.0] — 2026-05-09

**Minor — dual-target skill install + doctor (session029).** `self install-skill` y `self doctor` ahora operan en `~/.claude/skills/agent-workflow/` **y** `~/.codex/skills/agent-workflow/`. Cierra el gap detectado al verificar T6 de session028: el skill `agent-workflow` se publicaba sólo en Claude Code, dejando Codex sin la skill manager. Cambio de output JSON.

### Added

- **`self install-skill --target <claude|codex|all>`** — flag nuevo, default `all`. Instala en ambos targets en una sola invocación. `claude` o `codex` para opt-out single-target.
- **`InstallTarget`** y **`TARGET_ROOTS`** exports en `src/application/self/install-skill.ts` — usados también por `doctor-self.ts` para mantener un solo source-of-truth de los paths.
- **3 tests nuevos netos** en `tests/unit/self-install-skill.test.ts` (--target=claude, --target=codex, --target=invalid; los demás reformulan los originales para validar el nuevo shape `dests[]`) y **2 tests nuevos** en `tests/unit/self-doctor.test.ts` (ambos targets installed, leftover en codex independiente).

### Changed — `self install-skill`

- **Output shape**: el campo `dest` (string) se reemplaza por `dests[]` (array de `{ target, dest, status, overwrote_existing, files_copied }`). Cambio de shape — bump minor.
- **`DEST_EXISTS`**: ahora reporta los paths conflictivos de cada target en el mensaje de error y agrega la sugerencia `--target <claude|codex>` para instalar uno solo.
- **`--force`**: opera por target independiente. Si sólo `~/.claude/skills/agent-workflow` existe, se sobrescribe sólo ese — el reporte por target indica `overwrote_existing: true|false` correctamente.
- Refactor interno: `selfInstallSkill` extrae `resolveTargets`, `resolveSource`, `validateSourceContents`, `buildDestByTarget` para bajar la complejidad cognitiva.

### Changed — `self doctor`

- **Output shape `skill`**: se reemplaza `skill.path`/`skill.legacy_leftover*` por `skill.targets[]` (array de `{ target, path, installed, legacy_leftover?, legacy_leftover_path?, legacy_leftover_warning? }`). `skill.installed` queda como agregado (`true` si al menos uno de los targets tiene la skill).
- Detección de leftover `agent-workflow-manager` ahora corre por target: si Codex tenía leftover y Claude Code no (o viceversa), se reporta correctamente.

### Migration

Cambio de shape en JSON output — consumidores que dependían de `data.dest` (install-skill) o `data.skill.path` (doctor) tienen que migrar a la nueva shape `data.dests[].dest` y `data.skill.targets[].path`. Documentado arriba.

`self install-skill` sin flags ahora instala en ambos targets (cambio de default). Para preservar el comportamiento legacy single-target Claude Code, usar `--target claude`.

### Tests

- 335 tests passing (vs 330 en 5.5.1; +5 netos cubriendo dual-target). Lint: 0 errors, 1 warning pre-existente en `runSessionClose` (fuera de scope).

## [5.5.1] — 2026-05-09

**Patch — P2 cleanup final (session027).** Sweep de ruido y dead code post-audit de session023. Sin cambios de comportamiento.

### Removed

- **`parsers/project-block.ts`** — drop dead aliases `QTC_PROJECT_START` y `QTC_PROJECT_END` (sin importadores en src/ ni tests/).
- **`plugin-doctor-service.ts`** `DoctorOutput` — drop 4 fields siempre `null` heredados de la era Python: `qtc_core_installed`, `compat_ok`, `python_version`, `installed_marker`. Schema reducido en JSON output. Test obsoleto de "qtcContractVersion gate" removido.

### Changed

- **`cli/main.ts`** `resolveCoreConfigPath` — acepta `AGENT_WORKFLOW_CONFIG_PATH` además de la legacy `QTC_CORE_CONFIG_PATH` (preferencia: nuevo nombre, fallback: legacy).
- **`application/markdown.ts`** `normalizeKeyword` — reemplazada la regex con combining diacriticos ilegible por `String.prototype.normalize("NFD").replace(/\p{M}/gu, "")` (semántica idéntica, legible).
- **`tests/golden/{sessions,wave1-read,wave1b-write}.test.ts`** — descripciones "golden parity vs python qtc_core" → "golden parity (legacy ES fixture)" (el qtc_core Python ya no existe como referencia).

### Tests

- 330 tests passing (vs 331 en 5.5.0; -1 test obsoleto de qtcContractVersion gate). Lint: 0 errors.

## [5.5.0] — 2026-05-09

**Minor — R3 reader gaps + R2 atomic claim (sessions 024+025).** Cierra dos gaps post-publish detectados en validation runtime de session023:

1. **R3 Sprint 4 (reader-side completion)**: el canon EN ya se emitía en write paths (R3 Sprints 1-3) pero los readers core seguían ES-only. `aw sessions` reportaba sesiones cerradas como `active` y `phase: requirement` (legacy hardcoded). CHECKPOINT.md nuevos con headings EN no disparaban `findUnfilledPlaceholders`. `## Origen` (ES) era el único header reconocido para handoff origen.
2. **R2 atomic claim**: el `acquireLock` original hacía check-then-write no atómico. Bajo concurrencia 2 procesos podían pasar `fs.exists()` simultáneo y ambos overwritear el lock. Adicionalmente, `session-create`, `session-close` y `upgrade-hub-mode` escribían HISTORY.md / CLAUDE.md / AGENTS.md sin acquire del lock — bypass de R2 en los flows que más tocan esos archivos.

### Added — R2 atomic primitive (session025)

- **`FileSystemPort.writeTextExclusive(path, content): Promise<{ created: boolean }>`** (NUEVO): atomic create-or-fail vía `O_CREAT|O_EXCL`. Devuelve `{ created: false }` si el path ya existe. Cross-platform (POSIX + Windows) via Node `fs.open(path, 'wx')` con captura de EEXIST.
- **`FileSystemPort.remove(path): Promise<void>`** (NUEVO): unlink idempotente (silencia ENOENT).
- **`withCwdLock<T>(fs, paths, fn, options?): Promise<T | { error }>`** en `lock-service.ts`: helper que centraliza acquire/try/release. Devuelve shape `{error}` para que callers lo propaguen sin throw.
- **9 tests nuevos**: 5 en `tests/unit/node-file-system-exclusive.test.ts` (atomic primitive sobre FS real, incluye prueba de 5 calls paralelos → exactamente 1 success), 4 en `tests/unit/lock-service-atomic.test.ts` (race semantics: holder activo / stale / release marker).

### Changed — R2 acquireLock atómico (session025)

- **`acquireLock`** (`src/application/lock-service.ts`) reescrito con loop hasta 3 retries: `writeTextExclusive` → si holder activo, `LockBusyError`; si stale/release-marker, `remove` + retry. Elimina el patrón check-then-write previo.
- **`session-create-service.ts`**, **`session-close-service.ts`**, **`upgrade-hub-mode-service.ts`** ahora envuelven sus writes a HISTORY.md / CLAUDE.md / AGENTS.md en `withCwdLock`. Cierra los 3 sitios de bypass detectados en session023.

### Changed — R3 readers bilingual (session024)

- **`SessionsService.list`** (`src/application/sessions-service.ts`) ahora lee state desde HISTORY.md (source-of-truth post-R2) vía nuevo `readHistoryStateMap()` en `session-resolver.ts`. Cadena de prioridad: HISTORY.md > STATUS.md > legacy heuristic. STATUS.md preservado como fallback para sesiones pre-R2.
- **`buildSessionEntry`** ahora lee phase desde CHECKPOINT.md vía nuevo `readPhaseFromCheckpoint()` (matchea `## Current phase` EN o `## Fase actual` ES legacy). Cadena: CHECKPOINT.md > STATUS.md > "requirement" (legacy default).
- **`computeCheckpointStatus`** (`src/application/checkpoint-service.ts`) `sectionToField()` extendido con matchers EN canon (`last action`, `next step`, `files touched`, `critical context`). `parseMdValue("Actualizado")` con fallback a `"Updated"`.
- **`extractOrigen`** (`src/application/parsers/objetivo.ts`) usa `parseMdSectionBilingual("Origen")` que resuelve EN+ES vía KEYWORD_GROUPS.
- **`readOrigenSummary`** (`src/application/checkpoint/state-reader.ts`) regex bilingual `/^##\s+(Origen|Origin)\s*$/i`.
- **`renderOrigenBlock`** (`src/application/handoff.ts`) emite `## Origin` (EN canon) en sesiones nuevas; lectura ES legacy preservada.

### Added — R3 EN canon test fixture

- **`tests/fixtures/sample-workspace-en/`** (NUEVO, 7 archivos): fixture con HISTORY.md + sesiones EN canon (`OBJECTIVE.md`, `## Current phase`, `## Last action`). Complementa la fixture ES legacy `sample-workspace/` que se mantiene intocada.
- **8 tests nuevos**: 3 en `tests/golden/sessions-state-from-history.test.ts`, 2 en `tests/unit/checkpoint-placeholders-en.test.ts`, 3 en `tests/unit/origen-bilingual.test.ts`.

### Migration

Sin breaking changes. La API pública sumó 2 métodos a `FileSystemPort` (`writeTextExclusive`, `remove`) — implementaciones custom del port deben agregarlas. Los readers ahora son bilingual: sesiones legacy ES siguen funcionando idénticamente; sesiones canónicas EN ahora se leen correctamente. `aw sessions` reportará phases reales (`closure`, `execution`, etc.) en lugar de `requirement` para sesiones con CHECKPOINT.md.

### Tests

- 331 tests passing (vs 314 en 5.4.0). Lint: 0 errors. 40 test files.

## [5.4.0] — 2026-05-08

**Minor — R2 Phase 1: lock file mínimo (session022).** Cierra la primera fase del hardening file-based identificada en `agent-workflow-last/.workflow/sessions/session016-analyze-cli-bd-local-i18n/CONCLUSIONES.md` §R2. Serializa escrituras a archivos centralizados (HISTORY.md y bloque QTC-PROJECT en CLAUDE.md/AGENTS.md) en escenarios multi-host vía `.<ns>/.lock` con auto-expire 5min. Apoyado en el atomic-write port-level introducido en R1 (`5.3.0`).

### Added

- **`src/application/lock-service.ts`** (NUEVO):
  - `acquireLock(lockPath, fs, options): Promise<LockHandle>` — claim atómico vía atomic-write con detección de stale (TTL default 5min) y robo de lock corrupto.
  - `LockHandle` con `release()` idempotente que escribe marker vacío (próximo acquire lo trata como expirado).
  - `LockBusyError` con `holder` (pid + ts) para mensajes de error informativos.
  - Helpers exportados: `parseLock`, `isExpired`, `DEFAULT_LOCK_TTL_MS = 300_000`.
  - Inyección de `now()` y `pid` para testabilidad.
- **`PathsService.cwdLockFile()`** — resuelve `.<ns>/.lock` dentro del workspace.
- **20 tests** en `tests/unit/lock-service.test.ts` cubriendo: happy-path, concurrent acquire (LockBusy), stale lock steal, TTL boundary, corrupt JSON, empty release marker, structurally invalid JSON, release idempotente, parser y predicado de expiración.

### Changed

- **`runHistoryUpdate`** (`src/application/history-update-service.ts`) ahora envuelve el `upsertRow` en acquire/release. Si el lock está ocupado retorna `{error: "lock ocupado (pid X desde ts); reintenta o espera 5min"}` para que el caller lo proyecte al envelope JSON estándar.
- **`runProjectMdUpsertWrite`** (`src/application/project-md-upsert-service.ts`) idem — wrap del `writeAllFiles` (CLAUDE.md / AGENTS.md) en acquire/release.
- **`acquireLock`** asegura `fs.mkdirp(dirname(lockPath))` antes del write, para casos como `runHubInit` donde `.workspace/` no existe todavía.

### Migration

Sin breaking changes. Comandos que previamente escribían HISTORY.md / CLAUDE.md / AGENTS.md siguen funcionando idénticamente; ahora bajo lock cooperativo. En escenarios single-host (caso típico) el lock se acquire/release en milisegundos sin contención observable. En escenarios multi-host (p.ej. dos máquinas escribiendo el mismo HISTORY.md sobre un repo compartido) el segundo proceso recibe `LockBusy` con info del holder en vez de pisar la escritura.

### Tests

- 314 tests passing (vs 294 en 5.3.0). Lint: 0 errors. 35 test files.

## [5.3.0] — 2026-05-08

**Minor — R1 atomic-write port + R3 i18n Sprint 1+2 (sessions 017–019).** Cimiento bilingüe del runtime: lectura tolerante a artefactos en ES (legacy) o EN (canónico nuevo), escritura canónica en EN para sesiones nuevas. Sin breaking — sesiones legacy `OBJETIVO.md` siguen siendo legibles por los nuevos resolvers.

### Added — R1 atomic-write + bilingual resolvers (session017, `3e53e76`)

- **`NodeFileSystem.writeText` con atomic-write** (`src/adapters/node-file-system.ts`): write a `<path>.<pid>.<n>.tmp` + `rename` atómico. Cubre transparentemente los ~21 sitios de escritura vía el `FileSystemPort`. Habilita writes seguros del lock file (R2 Phase 1) y otros artefactos sin condición de carrera.
- **`src/application/session-artifacts.ts`** (NUEVO): `ArtifactKind` (14 kinds: `objective`, `findings`, `decisions`, `evidence`, `conclusions`, `recommendation`, `delivery`, `dependencies`, `discovery`, `problem`, `tasks`, `checkpoint`, `status`, `requirements`), `ARTIFACT_FILENAMES`, helpers `canonicalArtifactFilename`, `canonicalArtifactPath`, `findArtifact`, `listExistingArtifacts`. EN preferido + ES legacy fallback + case-insensitive + `fs.exists` fallback.
- **Parsers bilingües** (`src/application/markdown.ts`): `KEYWORD_GROUPS` con 17 grupos iniciales + `bilingualAliases`. Funciones `parseMdValueBilingual` / `parseMdSectionBilingual` con normalización NFD + accent strip + lowercase. Drop-in replacements de los originales.
- **20 tests** en `tests/unit/session-artifacts.test.ts` cubriendo los 14 kinds, fallback case-insensitive, fs.exists fallback, listado.
- **9 tests** en `tests/unit/markdown-bilingual.test.ts` cubriendo lookup bilingüe + accent normalization.

### Added — R3 Sprint 1 i18n templates (session018, `fa03324`)

- **`templates/objective.ts`** + **`checkpoint/markdown.ts`**: emisión EN canónica (`## Modality`, `## Current phase`, `## Last activity`, `## Type`, etc.). Sesiones nuevas reciben templates en EN; sesiones legacy ES siguen siendo legibles por los parsers bilingües.
- **`session-create-service.ts:173`**: write canónico de `OBJECTIVE.md` (en lugar del legacy `OBJETIVO.md`). Las sesiones legacy con `OBJETIVO.md` siguen siendo resueltas por `findArtifact`.
- **Flags `--modality` / `--type`** en `session-create` (legacy `--modalidad` / `--tipo` aceptados, normalizados a EN al persistir).

### Added — R3 Sprint 2 KEYWORD_GROUPS extendido (session019, `c231210`)

- **+27 grupos en `KEYWORD_GROUPS`** cubriendo headings emitidos por las 6 specialty skills (analyze-investigate, analyze-synthesize, analyze-conclude, design-deliver, design-discover, design-develop) y skills de orquestación.

### Changed

- **Política i18n del runtime qtc-*** (documentada en `qtc-workflow-plugin/docs/agent-rules.md`): runtime EN UPPERCASE, prosa libre en idioma del usuario, AI↔usuario en idioma del usuario, legacy via aliases ES+EN permanentes.

### Migration

Sesiones legacy `OBJETIVO.md` siguen funcionando sin tocar nada. Sesiones nuevas escriben `OBJECTIVE.md` y discriminators EN. No requiere migración manual.

### Tests

- 294 tests passing (vs 268 en 5.0.0). Lint: 0 errors. 34 test files.

## [5.2.0] — 2026-05-08

**Minor — refactor 5 services CLI >400 líneas (session012).** Cuatro splits modulares (plugin-doctor 794, multiroot 557, checkpoint-write 304, dev-graduate, etc.) preservando comportamiento.

### Changed

- **`src/application/multiroot-service.ts`** + **`src/application/plugin-doctor/exported-skills.ts`**: biome auto-format imports + line wrap.
- **`src/application/checkpoint-write-service.ts`** (304 líneas) refactor a 8 helpers, complejidad ciclomática 206 → ≤15.
- **`src/application/multiroot-service.ts`** (557 líneas) refactor.
- **`src/application/plugin-doctor/`** (794 líneas) split en 8 helpers.

## [5.0.2] — 2026-05-08

**Patch — refactor multi-command files + extract shared parsers (session010).** Split de archivos multi-comando del CLI (wave2-extras 5 cmds, wave2-final 6 cmds, wave4d-simple 4 cmds) extrayendo parsers compartidos.

### Changed

- Split de archivos multi-comando del CLI por bounded context.
- Extracción de parsers compartidos a módulo común.

## [5.0.1] — 2026-05-08

**Patch — `--graduated-conclusions` flag en session-close (session005).** Permite documentar slugs de conclusiones graduadas en `HISTORY.md` al cerrar la sesión.

### Added

- **`--graduated-conclusions <slug>`** flag en `agent-workflow session-close`. Mapeado a la columna `Refs` de `HISTORY.md` con link relativo a `docs/conclusiones/<num>-<slug>.md`.

## [5.0.0] — 2026-05-08

**Major BREAKING — modelo de artefactos simplificado (session006).** Refactor del comando `graduate` para soportar un set canónico de 6 kinds y resolver el destino siempre al workspace root (hub o project), eliminando el prompt M12 de routing por sesión. Sesiones cerradas con el modelo anterior (`docs/planes/`, `docs/refactors/`, `docs/design/`, `docs/design-system/`, `docs/rfcs/`, `docs/post-mortems/`, `docs/analisis/`) quedan tal cual; las nuevas siguen el set reducido.

### BREAKING

- **Set de kinds reducido a 6**: `decision`, `manual`, `script`, `especificacion`, `conclusion`, `release`. Eliminados `plan`, `refactor`, `design`, `design-system`, `rfc`, `postmortem`, `analysis`. Llamadas con kinds antiguos retornan error con la lista actual.
- **`--kind plan` eliminado sin reemplazo**: TASKS.md vive en la sesión y no se gradúa (era ruido).
- **`--kind refactor` eliminado sin reemplazo**: REFACTOR.md vive en la sesión; si requiere graduarse, curarlo como `--kind manual` o `--kind especificacion`.
- **`--kind rfc` / `--kind postmortem` / `--kind analysis` → `--kind conclusion`**: el documento fuente único pasa a ser `CONCLUSIONES.md` (modalidad embebida `tecnica`/`incidente`/`datos` en `## Modalidad`).
- **`--kind design` / `--kind design-system` → `--kind especificacion`**: la distinción proyecto/sistema queda como metadato del documento.
- **`--kind release` rechazado desde `graduate`**: usar el comando/skill `release` (es el único disparador de `--kind release` y `--kind script`).
- **M12 (graduacion-destino) eliminado**: la regla "hub mode → hub root, project mode → cwd" es absoluta. Ya no se pregunta por sesión. Reemplaza la regla anterior "manual/refactor/script gradúan a fuente, rfc/postmortem/analisis gradúan a hub" canonizada en session005.

### Added

- **`graduateManual`** — copia `<sesión>/MANUAL.md` (o `--source <path>`) a `docs/manuales/NNN-<slug>.md`.
- **`graduateScript`** — copia `<sesión>/scripts/` y `<sesión>/queries/` (si existen) como bundle a `docs/scripts/NNN-sessionXXX-<slug>/`. Pensado para invocación desde el comando `release`; soporta llamada directa.
- **`graduateEspecificacion`** — copia `<sesión>/ENTREGA.md` (o `--source <path>`) a `docs/especificaciones/NNN-<slug>/<filename>`.
- **`graduateConclusion`** — copia `<sesión>/CONCLUSIONES.md` a `docs/conclusiones/NNN-<slug>.md`.
- **`resolveWorkspaceRoot(fs, env, paths)`** (`src/application/paths-service.ts`): walk-up desde `env.cwd()` buscando el directorio que contiene `.<ns>/`. Fix para el caso "user hizo `cd <fuente>` antes de `graduate`" — el destino sigue siendo el hub-root, nunca la fuente. Se aplica también a la resolución de sesión (`runGraduate` reconstruye `PathsService` con el workspace root cuando difiere del cwd).
- **`--source <path>`** (input opcional) en `graduate` para `--kind manual` / `--kind especificacion`: especifica el archivo fuente dentro de la sesión cuando difiere del default.
- **Tests dedicados a `graduate`**: `tests/unit/dev-graduate-service.test.ts` con 25 tests cubriendo input validation, los 6 kinds (happy paths + errores), auto-numbering separado para archivos vs directorios, modo `project` (cwd) y modo `hub` (workspace root distinto), y walk-up desde una fuente subdirectory (DEC-002).

### Changed

- `runGraduate` (`src/application/dev-graduate-service.ts`) refactorizado completo. La numeración de archivos vs directorios ahora se separa (`nextNumberInDir` para `.md`, `nextNumberInDirsByPrefix` para bundles), evitando colisiones cuando ambos formatos coexisten.
- `graduateCommand` (`src/cli/commands/wave4d-simple.ts`): `describe` actualizado a la lista canónica de kinds invocables; lectura de `--source`; `--id` (alias `--dec-id`) capturado solo cuando `kind === "decision"`.

### Removed

- `GraduatePlanOutput`, `graduatePlan`: el kind `plan` ya no existe.

### Migration

Mapeo viejo → nuevo:

| Antes | Ahora |
|---|---|
| `graduate --kind rfc --session CODE --slug X` | `graduate --kind conclusion --session CODE --slug X` |
| `graduate --kind postmortem --session CODE --slug X` | `graduate --kind conclusion --session CODE --slug X` |
| `graduate --kind analysis --session CODE --slug X` | `graduate --kind conclusion --session CODE --slug X` |
| `graduate --kind design --session CODE --slug X` | `graduate --kind especificacion --session CODE --slug X` |
| `graduate --kind design-system --session CODE --slug X` | `graduate --kind especificacion --session CODE --slug X` |
| `graduate --kind plan --session CODE --slug X` | (sin reemplazo — TASKS.md queda en sesión) |
| `graduate --kind refactor --session CODE --slug X` | (sin reemplazo — REFACTOR.md queda en sesión; curar como `--kind manual` o `--kind especificacion` si se necesita graduar) |

Sesiones que ya graduaron a `docs/planes/`, `docs/refactors/`, `docs/design/`, `docs/design-system/`, `docs/rfcs/`, `docs/post-mortems/`, `docs/analisis/` no requieren migración — las carpetas siguen existiendo y son legibles. Las nuevas graduaciones usan el set reducido.

### Documentation context

- Modelo nuevo definido en `agent-workflow-refactor/.workflow/sessions/session006-dev-simplificar-modelo-artefactos/DECISIONES.md` (DEC-001..DEC-004).
- Manual del lifecycle reescrito: `agent-workflow-refactor/docs/manuales/000-mapa-artefactos-workflow.md`.
- Plugin `qtc-workflow-plugin` v2.0.0 — consolidación de `analyze-rfc`/`analyze-data`/`analyze-postmortem` en `analyze-conclude`, M12 removido del catálogo, regla canónica `references/graduacion-routing.md` reescrita.

## [4.7.0] — 2026-05-07

**Minor — `graduation-check` command + soporte para regla canónica de routing hub-vs-fuente (session005).** Nuevo chequeo orientado a hub workspaces que detecta artefactos graduados a `<fuente>/docs/<categoria>/` sin breadcrumb correspondiente en `<hub>/docs/<categoria>/000-INDEX.md`. Apoya el cumplimiento de la regla documentada en `qtc-workflow-plugin/skills/session/references/graduacion-routing.md`.

### Added

- **`agent-workflow graduation-check`** (`src/application/graduation-check-service.ts` + `src/cli/commands/graduation-check.ts`): walks `docs/{manuales,rfcs,post-mortems,analisis,refactors}` en cada fuente declarada en CLAUDE.md/AGENTS.md del cwd y reporta orphans (archivo en fuente sin mención en `<hub>/docs/<categoria>/000-INDEX.md`). Retorna `status: ok|warn|skipped`. Skip silencioso fuera de hub mode (CLAUDE.md no encontrado, no `Mode: hub`, o sin fuentes declaradas). Exit code 1 si hay warnings.

### Documentation context

- La regla canónica + tabla de defaults (rfc/post-mortem/analisis → hub; manual/refactor/script → fuente) vive en el plugin `qtc-workflow-plugin`. El comando del CLI valida cumplimiento, no impone decisiones.
- Prompt M12 `graduacion-destino` agregado al catálogo (en `qtc-workflow-plugin/skills/session/references/prompts-catalog.md`) — disparado al closure en hub mode.

## [4.6.0] — 2026-05-07

**Minor — RFC 002 G4 UX polish + cleanup legacy + 0 lint complexity warnings (session013).** Cierra los 5 friction points (H-04..H-08) declarados en RFC 002 y reduce las 8 lint complexity warnings residuales del codebase a **0** (RFC 002 metric promise honrada).

### Added — UX

- **H-05 `--dry-run` en `aw self update`** (`src/application/self/update-self.ts`): cuando se pasa `--dry-run`, retorna `{command, would_run:true, exit_code:0, stdout:"", stderr:""}` sin invocar `npm install`. Permite scripts/CI verificar el comando sin efectos.
- **H-06 help grouping** (`src/cli/help-groups.ts` nuevo + `src/cli/main.ts`): el output de `aw --help` agrupa los 43 comandos en 10 familias con headers (Session lifecycle, Objetivo / Tasks, Checkpoint, Sources / Branches, Orchestration, Doctor / Data, Hooks, MCP, Dev-only, Self). Comandos no clasificados caen a "Other" automáticamente. Si agregás un comando, declaralo en `GROUPS` o aparece bajo "Other".
- **H-07 `aw self` sin sub** (`src/cli/commands/self.ts`): retorna `{ok:true, data:{subcommands:[...], help_hint:"..."}}` exit 0 (antes era error envelope). El usuario que invoca el comando padre obtiene un listado en lugar de un mensaje de error.

### Changed

- **H-04 fallback name** (`src/application/plugin-doctor-service.ts`): `aw plugin-doctor` ahora deriva `plugin` de `basename(pluginRoot)` cuando el manifest no tiene `name` explícito, en lugar del literal `${ns}-${flow}`. El fallback `${ns}-${flow}` se preserva para el caso degenerate `pluginRoot="/"` (basename vacío).
- **H-08 cleanup checks legacy** (`src/application/plugin-doctor-service.ts`): eliminadas todas las branches gateadas por `qtcContractVersion < 6.3` (per D4 RFC 002). Removidos los helpers `checkLegacyMarkers`, `readPluginVersionMarker`, `readMarkerText`, `checkPythonVersion`, `evaluateCompat`, `semverSatisfies`, `parseSemver`, `tupleGte`, `tupleLt`, `detectPythonVersion`, `isContractVersionAtLeast` (~150 LOC dead code). Los campos `installed_marker`, `qtc_core_installed`, `compat_ok`, `python_version` permanecen en `DoctorOutput` por back-compat de shape pero ahora siempre son `null`.

### Refactor — 6 funciones >cx 15 reducidas a ≤15 (bonus)

Honra la métrica del RFC 002 ("Lint complexity warnings: 8 → 0 post-G4"). Mecánica de extracción idéntica a G2:

- `code-scan-service.ts:scanFiles` (cx 31 → ≤15): extracción de `compilePatterns`, `scanSingleFile`, `scanLine`, `tallyBySeverity`.
- `code-scan-service.ts:walkFiles` (cx 21 → ≤15): split de la iteración nested via `visitDir` (delegate generator).
- `release-data-service.ts:readSessionArtifacts` (cx 29 → ≤15): extracción de `findSessionFolder`, `detectLegacyFormat`, `readScriptsArtifacts`, `readArtifactKind`.
- `release-data-service.ts:runReleaseData` (cx 26 → ≤15): extracción de `enrichSessionsWithLegacyMeta`.
- `upgrade-hub-mode-service.ts:runUpgradeHubMode` (cx 20 → ≤15): extracción de `findProjectBlock`, `applyBlockToCandidates`.
- `cli/commands/project-md-upsert.ts:execute` (cx 17 → ≤15): extracción de `buildUpsertInput`.

### Tests — 13 nuevos

- `tests/unit/help-groups.test.ts` (8 tests): grouping correcto, ordering preservado, "Other" fallback para comandos no clasificados, sin duplicación entre grupos.
- `tests/unit/self-update.test.ts` (3 tests): `--dry-run` retorna `would_run:true` y NO invoca `process.run` (ProcessPort que throw si se llama); modo normal sí invoca npm.
- `tests/unit/self-command.test.ts` (2 tests): `aw self` sin sub retorna `ok:true` con subcommands; subcomando inválido sigue retornando `INVALID_INPUT` (back-compat).
- 1 test agregado en `plugin-doctor-service.test.ts` para cubrir el caso `pluginRoot="/"` → fallback a `${ns}-${flow}`.

### Métricas

| | 4.5.0 | 4.6.0 |
|---|---|---|
| Tests | 156 | 169 |
| Lint complexity warnings | 6 | **0** |
| LOC `plugin-doctor-service.ts` | ~860 | ~700 (–150 dead code) |

## [4.5.0] — 2026-05-07

**Minor (con cambio de contrato visible) — RFC 002 G3 error format unificado (session012).** Todos los error paths del CLI ahora emiten un JSON envelope a stdout en lugar de plain-text a stderr. Misma exit code (≠0), mismo significado, formato distinto.

### Changed (contract)

- **Error envelope unificado**: errores del propio CLI (parseo de argv, comando desconocido, fallas de subcomandos) escriben `{ok:false, error:{code, message, details?}}` a **stdout** + exit ≠ 0. Antes algunos sitios escribían a stderr (`writeStderr`) y otros emitían el envelope vía `emit(CommandResult)`.
- **stderr ya NO es canal de errores formatados del CLI**. Sigue siendo canal válido para `aw hook` que relay-ea stderr de scripts/plugins child-process (single excepción documentada en `render.ts`).
- Códigos de error introducidos:
  - `ARGS_INVALID` — fallo en `parseArgv` (ej. `--flow` con valor fuera del whitelist).
  - `UNKNOWN_COMMAND` — comando no registrado; `details.help_hint` + `details.available_commands` para discoverability.
  - `DBHUB_LAUNCHER_FAILED` — `aw mcp dbhub` no pudo arrancar el launcher (antes retornaba `ok:true` con `exitCode:1` + stderr, contradictorio).

### Added

- `src/cli/render.ts`: `ErrorEnvelope`, `renderError`, `emitError`, `formatUnknownCommand`, `formatArgvError` — helpers reutilizables, importables desde cualquier módulo del CLI.
- `tests/unit/main.test.ts` (11 tests, +1 file) — verifica forma del envelope, round-trip JSON.parse, y que `emitError` escribe a stdout (NO stderr).

### Notas para clientes downstream

- **Migración para parsers existentes**: si un script/hook detectaba errores leyendo stderr, debe migrar a parsear stdout JSON (`JSON.parse(stdout)` y chequear `.ok === false`).
- Comportamiento al usuario humano via TTY no cambia significativamente: la línea de error sigue saliendo en consola, ahora como JSON estructurado en lugar de texto plano. `aw <bogus-cmd>` ya no imprime el menú de help completo (solo el envelope con `available_commands`); para help completo correr `aw --help`.

## [4.4.0] — 2026-05-07

**Minor — RFC 002 G2 refactor plugin-doctor (session011).** Descomposición de `runPluginDoctor` (cognitive complexity 206) y `loadExportedSkills` (44) en helpers ≤ 15 sin cambio de comportamiento.

### Changed

- **Refactor plugin-doctor por extracción** (D2 de RFC 002 — extracción, no rewrite): `runPluginDoctor` (1 monolito de ~460 LOC, cx=206) descompuesto en 8 helpers self-contained, cada uno mapeando a una sección lógica del original:
  1. `checkSkillsFrontmatter(skillsDir, fs)` — sección 1 (frontmatter validation), apoyado por `collectSkillDirs`, `parseSkillFile`, `validateSkillFrontmatter`.
  2. `checkReadmeSync(readmePath, skillsCount, fs)` — sección 2.
  3. `checkFrontendDesignGeneralization(skillsDir, pluginRoot, fs)` — sección 3 + `scanForSessionMarkers`.
  4. `parseManifests(pluginRoot, fs, inputVersion)` — sección 4, apoyado por `parseManifestFile`.
  5. `checkLegacyMarkers(paths, flow, pluginVersion, compatRange, isSinglePathContract, fs)` — secciones 5/5b/9 consolidadas; consume `readPluginVersionMarker`, `readMarkerText`, `checkPythonVersion`.
  6. `parseHooks(pluginRoot, fs)` — sección 7 + `parseHookFile`.
  7. `validateMcp(pluginRoot, runtime, env, fs)` — sección 8 + `validateMcpServer`.
  8. `validateExportedSkills(...)` — sección 10 + `validateSingleExportedSkill`.
- **`loadExportedSkills` (cx=44 → ≤15)**: split en `readExportsFromCustomFile` + `readExportsFromClaudeManifest` + `parseExportedSkillEntries` + `parseExportedSkillItem`.
- **Sin cambios de comportamiento observable**: 144/144 tests existentes pasan sin modificaciones (incluidos los 16 tests de plugin-doctor agregados en G1). El JSON output de `aw plugin-doctor` mantiene shape y semántica idénticos.

### Notas

- 2 lint warnings de complexity eliminados (los del plugin-doctor). Quedan 6 en otros servicios (code-scan, release-data, upgrade-hub-mode, project-md-upsert) que serán abordados en G3/G4 según RFC 002.
- Refactor mecánico habilitado por la red de seguridad de G1 (95 → 144 tests). Test-before-refactor confirmado como regla, no opcional (D1 de RFC 002).

## [4.3.0] — 2026-05-07

**Minor — RFC 002 G1 foundation (session010).** Test coverage para los 4 servicios críticos sin tests + fix de regresión silenciosa post-flag-day en hooks (B-20).

### Fixed

- **B-20 (regresión silenciosa post-flag-day)**: `findActiveSessions` ahora acepta y usa los markers del namespace activo. Antes hardcodeaba `LEGACY_QTC_MARKERS` y devolvía `[]` para cualquier workspace `.workflow/` con markers `<!-- WORKFLOW-PROJECT-START -->`. Consecuencia: el PreCompact hook (`checkpoint-write` sin `--code`), el SessionEnd hook (`auto-compact-on-close`) y `resume-summary` retornaban "no hay sesiones activas" en producción aunque hubiera sesiones declaradas. Bug introducido en F4 (4.0.0) y no detectado hasta TDD en G1.
- 5 callsites actualizados en `checkpoint-service.ts` y `checkpoint-write-service.ts` para pasar `paths.blockMarkers()` a `findActiveSessions`.

### Added — Test coverage (49 nuevos tests)

- `tests/unit/plugin-doctor-service.test.ts` (16 tests) — manifest name extraction (B-17 regression), skills frontmatter validation, manifest version drift, qtcContractVersion gate, hooks JSON parsing, output status field. Cubre el servicio más complejo del codebase (700+ LOC, complexity 206).
- `tests/unit/release-data-service.test.ts` (15 tests) — `listSessionsForRelease` (empty workspace, since filter, legacy detection, includeOpen) + `readSessionArtifacts` (session_not_found, legacy_format error, OBJETIVO content, scripts dir, code normalization).
- `tests/unit/code-scan-service.test.ts` (11 tests) — root_not_found, hardcoded secret/TODO/localhost/console.log detection, default excludes (node_modules, dist, .workflow), maxPerPattern cap, inlinePatterns override, extension filtering.
- `tests/unit/checkpoint-write-service.test.ts` (7 tests) — incluye **regression test** para B-20 con markers WORKFLOW-PROJECT post-flag-day + back-compat con QTC-PROJECT legacy + multi-session ambiguity + idempotency.

### Tests

- 95 → 144 tests (+49). 18 archivos de test (+4).

### Notas

- Los 8 lint warnings de complexity siguen presentes (no parte de G1; el plan G2 aborda el refactor de `runPluginDoctor` con esta nueva red de seguridad).

## [4.2.0] — 2026-05-07

**Minor — fix bundle de la auditoría post-F5 (session008).** Cierra los 5 bugs estructurales detectados al ejecutar el TEST-PLAN.md sobre la 4.1.0.

### Added

- **Back-compat read de markers legacy** (B-19): `parseProjectBlock` ahora intenta primero los markers del namespace activo; si no matchean, fallback a `LEGACY_QTC_MARKERS` (`<!-- QTC-PROJECT-(START|END) -->`). Esto cumple la promesa del CHANGELOG 4.0.0. Write sigue usando los markers del namespace actual (no se introduce deuda nueva). (`src/application/parsers/project-block.ts`)
- **`plugin-doctor` deriva `plugin` de manifest.name** (B-17): el campo `plugin` del output reporta el nombre real del manifest leído (ej. `"qtc"`) en lugar del literal `${namespace}-${flow}` (ej. `"workflow-core"`). Fallback a la lógica anterior si el manifest no expone `name`. (`src/application/plugin-doctor-service.ts`)

### Fixed

- **Autodetect ignora `.qtc/sessions/` legacy** (B-15): nuevo `LEGACY_NAMESPACE_DENYLIST = {"qtc"}` en `namespace-resolver.ts`. Workspaces con `.qtc/sessions/` no se autodetectan; el CLI cae a default `agent-workflow` salvo que el usuario fuerce `qtc` vía `--namespace`, `AW_NAMESPACE` o user-config (override absoluto). Esto respeta el flag-day del RFC 001 D2. (`src/runtime/namespace-resolver.ts`)
- **`aw sessions` no lista sesiones legacy** (B-16): cierra como consecuencia de B-15 — sin namespace=`qtc` autodetectado, los comandos del lifecycle (`sessions`, `workspace-mode`) ya no operan sobre `.qtc/sessions/`.

### Tests

- 8 nuevos casos: 5 en `namespace-resolver.test.ts` (denylist + overrides + coexistencia con `.workflow/`), 3 en `project-block-markers.test.ts` (back-compat read positivo, ambiguo, prioridad current). 95/95 verdes.

## [4.1.0] — 2026-05-07

**Minor — F5 del RFC 001 (cleanup post-migración).** Cierra deuda técnica residual: nombre paquete actualizado en docs del skill bundled + nuevo check de leftover en `self doctor`.

### Added

- `self doctor` ahora detecta el directorio legacy `~/.claude/skills/agent-workflow-manager/` y agrega 3 campos opcionales al output (`skill.legacy_leftover`, `skill.legacy_leftover_path`, `skill.legacy_leftover_warning`) cuando existe. Recomienda `mv` al usuario sin ejecutar destructivo. (`src/application/self/doctor-self.ts`)

### Changed

- `skills/agent-workflow/SKILL.md` (bundled) — namespace resolution actualizada al modelo plugin-driven post-flag-day (ya no menciona `~/.qtc/`, `.qtc/sessions/`, `AW_NAMESPACE=qtc`). Bump del frontmatter `version: 1.1.0 → 1.2.0`.
- `skills/agent-workflow/MANUAL-FUNCIONAL.md`, `MANUAL-TECNICO.md`, `docs/TEST-PLAN.md` — refs a `npm install -g @tacuchi/agent-workflow` actualizadas a `…-cli`.

### Tests

- 2 nuevos casos en `tests/unit/self-doctor.test.ts` (leftover detected + new skill only). 87/87 verdes.

## [4.0.0] — 2026-05-07

**Major breaking — F4 del RFC 001 (flag-day namespace).** El CLI deja de tratar `.qtc/` como dirname canónico para los workspaces. La convención nueva es `.workflow/` (plugin-driven via SessionStart hook), pero la lógica de autodetect del CLI sigue siendo namespace-agnóstica: detecta cualquier `.<ns>/sessions/` en el CWD.

### BREAKING CHANGES

- **Default `historicoPath`** en `renderProjectBlock`: era `.qtc/HISTORY.md`, ahora es `.workflow/HISTORY.md`. Consumidores que llamen `renderProjectBlock` sin pasar `historicoPath` explícito reciben el path nuevo.
- **Workspaces existentes con `.qtc/sessions/`** quedan invisibles si se intenta autodetect tras instalar `qtc-workflow-plugin@^1.0.0`, porque el plugin reclama namespace `workflow` (autodetect busca `.workflow/sessions/` o el plugin escribe `workflow` al `~/.config/agent-workflow/namespace`). Migración manual: `mv .qtc .workflow` por workspace + edit del bloque QTC-PROJECT en `CLAUDE.md`/`AGENTS.md` (cambiar `Histórico: \`.qtc/HISTORY.md\`` por `\`.workflow/HISTORY.md\``).
- **Mensajes de error de `handoff.ts`** y help del CLI ya no mencionan `.qtc/sessions/`; usan el path resuelto por `PathsService.cwdSessionsDir()` (depende del namespace activo).

### Changed

- `src/application/handoff.ts:43,47` — error messages parametrizados via `paths.cwdSessionsDir()` (antes literal `.qtc/sessions/`).
- `src/cli/main.ts:240-242` — help text reescrito: menciona el mecanismo plugin-driven (SessionStart hook escribe namespace) en vez de hardcodear `qtc`/`.qtc/sessions/`.
- `src/application/render/project-block.ts:19,27` — JSDoc + default `historicoPath` actualizados a `.workflow/HISTORY.md`.
- Tests + fixtures (50+ refs): paths-service, namespace-resolver, runtime-config-service, self-doctor, self-namespace, project-block-markers, wave1-read, wave1b-write, sessions, golden JSON fixtures, sample-workspace, golden-write CLAUDE.md fixtures — todos migrados al namespace `workflow` con dirname `.workflow/` y markers `<!-- WORKFLOW-PROJECT-... -->`.
- Helper `makeQtcPaths` → `makeWorkflowPaths` (tests/golden/lib/before-after-fixture.ts).
- Fixture dirs renombradas via `git mv .qtc .workflow` (sample-workspace + 3 golden-write subdirs).

### Migration

Para cada workspace que el usuario quiera preservar tras este upgrade:

```bash
cd <workspace>
mv .qtc .workflow
# editar CLAUDE.md y AGENTS.md:
#   `Histórico: `.qtc/HISTORY.md`` → ``.workflow/HISTORY.md``
#   `<!-- QTC-PROJECT-START -->` → `<!-- WORKFLOW-PROJECT-START -->` (opcional; el CLI sigue parseando los markers legacy en el path de back-compat read)
```

Las sesiones activas en `.qtc/sessions/` que no se migren quedan invisibles al CLI tras el upgrade del plugin a `^1.0.0`.

## [3.0.2] — 2026-05-07

Patch — F3 del RFC 001. Skill bundled-only: rename de la skill `agent-workflow-manager` a `agent-workflow`, eliminación de toda referencia al repo standalone y simplificación del flow `self install-skill` (sin fallback URL).

### Changed

- **Skill rename**: `skills/agent-workflow-manager/` → `skills/agent-workflow/`. La skill se instala ahora en `~/.claude/skills/agent-workflow/`. Frontmatter `name: agent-workflow`. Bump del skill a v1.1.0.
- **`self install-skill` simplificado**: el flow queda con 2 ramas — `--from <path>` (override desde checkout local) o, sin flag, instala desde la ubicación bundled en el tarball. La rama de `git clone` desde URL fue removida.
- **`self doctor`**: reporta `skill.path = ~/.claude/skills/agent-workflow` (era `agent-workflow-manager`).

### Removed

- Constante exportada `DEFAULT_SOURCE` (URL al repo standalone `Tacuchi/agent-workflow-manager`).
- Helper `isRemoteUrl` y la rama de clone.
- Tests de URL clone (`clones when source is a URL`, `fails gracefully when git clone exits non-zero`, `default source is the canonical GitHub URL`).

### Added

- Validación al inicio de `self install-skill` que rechaza `--from <url>` con error claro `INVALID_SOURCE` (apuntando a usar `--from <local-path>` o eliminar el flag para usar el bundled).
- Tests nuevos cubriendo el rechazo de URLs (`https://`, `git@...`).

### Migration

Usuarios con la skill vieja instalada localmente:

```bash
rm -rf ~/.claude/skills/agent-workflow-manager
npm install -g @tacuchi/agent-workflow-cli@latest
agent-workflow self install-skill
```

El leftover `~/.claude/skills/agent-workflow-manager/` queda invisible al CLI nuevo. F5 del RFC 001 agrega un detector en `aw self doctor` que avisa al usuario sobre esto.

## [3.0.1] — 2026-05-07

Patch — cierra los gaps de tooling detectados durante el hub-init del upgrade (F1 del RFC 001). Bug fix de larga data en `project-md-upsert --init` + cleanup post-rename.

### Fixed

- **`project-md-upsert --init` ignoraba `--fuente` y `--main-branch`**: el bloque QTC-PROJECT inicial siempre quedaba con `## Fuentes` vacío al inicializar workspaces hub. Ahora `--fuente "alias:path[:rama-principal]"` es repetible y `--main-branch <rama>` aplica como fallback para fuentes que no declaran rama. Memoria del usuario `project_agent_workflow_cli_gaps.md` queda cerrada.
- **`--working-branch` sobrescribía en lugar de acumular**: `Map.set` reemplazado por array. Ahora pasar `--working-branch a:r1 --working-branch b:r2` resulta en ambos aliases mergeados en `## Status`.
- **Refs leftover al nombre viejo del paquete**: `src/runtime/types.ts` y `src/cli/interactive-menu.ts` aún apuntaban a `@tacuchi/agent-workflow` (pre-rename). Ajustados a `@tacuchi/agent-workflow-cli` para alinear con `package.json:name` (D1 del RFC).

### Added

- Multi-value flag support en `parseArgv`: nueva `valuesMulti: Map<string, string[]>` para flags repetibles. Conjunto inicial: `--fuente`, `--working-branch`. Flags single-value (`--main-branch`, etc.) mantienen semántica last-wins en `values`.
- `ProjectMdUpsertInput.fuentes?` y `ProjectMdUpsertInput.mainBranch?` permiten declarar fuentes desde la API del service (no sólo desde CLI).
- Tests unit nuevos: `tests/unit/parser-multi-value.test.ts` (4 casos) y `tests/unit/project-md-upsert-fuentes.test.ts` (6 casos cubriendo init de 1/2/3 fuentes, fallback de rama, hub mode con working-branches, re-init con override por alias).

## [3.0.0] — 2026-05-07

Breaking — paquete renombrado de `@tacuchi/agent-workflow` a `@tacuchi/agent-workflow-cli`. Repo upstream renombrado de `Tacuchi/agent-workflow` a `Tacuchi/agent-workflow-cli`. Bin (`agent-workflow`) y alias (`aw`) sin cambios. Roadmap del upgrade en hub `qtc-plugin-upgrade` (RFC 001 v2).

### Changed

- `package.json:name` → `@tacuchi/agent-workflow-cli`.
- `package.json:repository`, `bugs`, `homepage` → URLs del repo nuevo.

### Migration

Consumidores de `@tacuchi/agent-workflow@^2`:

```bash
npm uninstall -g @tacuchi/agent-workflow
npm install -g @tacuchi/agent-workflow-cli
```

Las rutas instaladas (`agent-workflow`, `aw`) y la API pública del CLI no cambian — sólo el nombre del paquete y la URL del repo.

## [2.0.2] — 2026-05-06

Patch UX fix for the interactive TUI menu. RFC 002 follow-up (session010 in the qtc-plugin-v2 hub).

### Fixed

- **Menu `Install/Update skill` failing with `DEST_EXISTS`**: when the bundled skill was already installed, selecting the menu option failed because the dispatcher invoked `self install-skill` without `--force`. Since the menu label literally reads "Install/**Update**", the user's intent on selection is overwrite. The dispatcher now passes `--force` automatically. The CLI directly (`agent-workflow self install-skill`) is unchanged and still requires explicit `--force` to overwrite — preserving the safety net for scripts and CI.

## [2.0.1] — 2026-05-06

Patch fix for the interactive TUI menu. RFC 002 follow-up (session009 in the qtc-plugin-v2 hub).

### Fixed

- **Interactive menu missing `install-skill` option**: when running `aw` or `agent-workflow` without arguments in a TTY, the menu only exposed `Doctor / Update / Help / Exit`. The bundled `self install-skill` command introduced in v2.0.0 was reachable only from the command line. The menu now lists 5 options: `Doctor / Install/Update skill (manager bundled) / Update CLI / Help / Exit`. The `Update CLI` label was clarified (previously just "Update").

### Internal

- `MenuAction` union extended with `"install-skill"`. `dispatchMenuAction` switch wires it to `["self", "install-skill"]`.

## [2.0.0] — 2026-05-06

Bundle the `agent-workflow-manager` skill in the published tarball. **Breaking change** in the default behavior of `agent-workflow self install-skill`: it now copies from the bundled skill shipped alongside the CLI instead of git-cloning the upstream repo. RFC 002 Fase D (session007 in the qtc-plugin-v2 hub).

### Breaking changes

- **`self install-skill` default source**: previously `git clone https://github.com/Tacuchi/agent-workflow-manager.git`; now copies from `<package_root>/skills/agent-workflow-manager/` (bundled in the tarball). Users who relied on the default to fetch bleeding-edge from git must now pass `--from <url>` explicitly.
- **`SelfInstallSkillData.source_kind`** gains a new variant `"bundled"` (alongside `"path"` and `"url"`). Consumers that exhaustively pattern-match must add the new variant.
- **New error code** `BUNDLED_NOT_FOUND` returned when `--from` is omitted and the resolver cannot locate `skills/agent-workflow-manager/SKILL.md` relative to the install (e.g., dev checkouts without a build, or tarballs missing `skills/`).

### Added

- **Bundled skill manager**: the npm tarball now ships `skills/agent-workflow-manager/` (5 files + `docs/` + `references/`). `package.json` `files` array extended to `["dist", "skills", "LICENSE", "README.md"]`.
- **`resolveBundledSkillPath()`** helper exported from `application/self/install-skill.js` — walks up from the current module's directory until it finds `skills/agent-workflow-manager/SKILL.md`. Works in both dist (post-build) and dev (vitest) layouts.
- **`BUNDLED_SKILL_REL_PATH`** constant exported (default `"skills/agent-workflow-manager"`).
- 2 new unit tests in `tests/unit/self-install-skill.test.ts` covering bundled-default and `BUNDLED_NOT_FOUND`. `selfInstallSkill` accepts an optional `resolveBundled` injector for testability.

### Changed

- `selfInstallSkill` flow: (1) `--from <X>` provided → use as path or url (unchanged behavior); (2) `--from` omitted → call bundled resolver; bundled found → use as `source_kind: "bundled"`; bundled missing → `BUNDLED_NOT_FOUND`.
- Package `description` updated to highlight the bundled skill manager.

### Migration guide (v1.2.0 → v2.0.0)

| Use case | v1.x | v2.x |
|---|---|---|
| Install bundled skill | `agent-workflow self install-skill` (clones git) | `agent-workflow self install-skill` (copies bundled, faster, offline-capable) |
| Install bleeding-edge | (default, implicit) | `agent-workflow self install-skill --from https://github.com/Tacuchi/agent-workflow-manager.git` |
| Install from local checkout | `agent-workflow self install-skill --from /path/to/repo` | unchanged |
| `--force` / `--dry-run` flags | unchanged | unchanged |

If your tooling pinned `^1.0.0`, bumping to `^2.0.0` is a single major bump. The CLI surface (commands, flags, output schema) stays compatible aside from the new `source_kind: "bundled"` enum value.

### Internal

- `agent-workflow-manager` repo (origin) is preserved unmodified. Strangler Fig: the standalone repo will be archived in Fase E (≥2 weeks post-v2.0.0).

## [1.2.0] — 2026-05-05

Workspace-aware namespace resolution. The CLI now infers `namespace` from the cwd when no flag/env/config is set, so qtc-* (and other) workspaces work out-of-the-box without per-invocation configuration.

### Added

- **Workspace auto-detect** as a 3rd resolution step (between env and user config). When no `--namespace` flag and no `AW_NAMESPACE` env are present, the resolver scans the current directory for hidden folders matching `^\.[a-z][a-z0-9-]{1,30}$/` that contain a `sessions/` subdirectory. If exactly one match is found, that namespace is used (source = `workspace`). This makes `agent-workflow sessions` "just work" inside qtc-* (or any other) workspace without per-invocation config.
- New `NamespaceSource` value `workspace` reported by `self namespace` and `self doctor`.
- 5 new unit tests in `tests/unit/namespace-resolver.test.ts` covering: detection of `.qtc/sessions/`, ignoring `.git/` (no sessions/ subdir), ambiguity fallback (multiple candidates → default), config-file precedence over auto-detect, and unreadable cwd graceful handling.

### Changed

- **Resolution order**: workspace auto-detect now wins over `~/.config/agent-workflow/namespace` (locality > preference). A user with `qtc` in their user config but cwd inside a `.foo/sessions/` workspace gets `foo`, not `qtc`. New full order: flag > env > workspace > user-config > default.
- `NAMESPACE_REGEX` exported from `runtime/namespace.ts` so the resolver can reuse the same validation pattern for workspace candidates.
- Help text updated to document the new resolution order.
- Package description: highlights the workspace auto-detect.

## [1.1.0] — 2026-05-05

Sub-proyecto 2 del spec `agent-workflow-agnostic-design`: poblar el repo `agent-workflow-manager` y entregar la implementación real de `self install-skill` que lo consume.

### Added

- `self install-skill` real implementation:
  - Default source: `https://github.com/Tacuchi/agent-workflow-manager.git` (cloneable via `git`).
  - `--from <url|path>` flag accepts an alternate git URL or a local filesystem path.
  - `--force` overwrites an existing `~/.claude/skills/agent-workflow-manager/` directory.
  - `--dry-run` previews source/destination without copying.
  - Validates `SKILL.md` frontmatter (`name`, `description`) before installing.
  - Skips `.git/` when copying so the installed skill folder is clean.
- 10 new unit tests in `tests/unit/self-install-skill.test.ts` covering local-path install, URL clone via fake `ProcessPort`, force overwrite, dry-run, missing source, missing/invalid SKILL.md, and clone failure.

### Changed

- `self doctor` now reports the skill at `~/.claude/skills/agent-workflow-manager/` (was `~/.claude/skills/agent-workflow/`). Skill folder name now matches the canonical skill repo name.

## [1.0.0] — 2026-05-DD

First stable release. The CLI is now namespace-agnostic and reusable beyond the `qtc-*` plugin family.

### ⚠ BREAKING CHANGES

- **Default namespace changed.** Previous default behavior wrote to `~/.qtc/...` and `.qtc/sessions/`. The new default namespace is `agent-workflow`, so paths become `~/.agent-workflow/...` and `.agent-workflow/sessions/`. To preserve previous behavior, set `AW_NAMESPACE=qtc` (recommended for qtc-* plugin users) or pass `--namespace qtc` per invocation.
- **Env var renamed:** `QTC_AGENT_WORKFLOW_BIN` → `AW_AGENT_WORKFLOW_BIN`.
- **Env vars renamed:** `QTC_SQL_GUARD` / `QTC_SQL_GUARD_ALLOW` → `AW_SQL_GUARD` / `AW_SQL_GUARD_ALLOW`.
- **MCP guard patterns no longer hardcoded.** The `hook sql-mutation-guard` PreToolUse hook now reads patterns from `runtime.mcpGuards.sqlMutation` in the runtime config JSON. Guard is disabled when no config is provided. qtc-* plugins must ship a runtime config with the qtc-cert/qtc-prod patterns.
- **Plugin-doctor expectations changed.**
  - `expectedScripts` input field removed (Python era ended).
  - `scripts` output field removed.
  - Expected MCP servers now read from `runtime.expectedMcpServers` (was hardcoded to `["qtc-cert", "qtc-prod"]`).
- **Block markers parametric.** `parseProjectBlock` and `renderProjectBlock` now accept optional `markers: ProjectBlockMarkers` and `historicoPath` parameters. Defaults still produce `<!-- QTC-PROJECT-START -->` and `.qtc/HISTORY.md` for legacy callers, but services that pass `paths.blockMarkers()` will get namespace-aware markers.
- **CLI exit code change:** Invoking `agent-workflow` with no arguments now exits 0 (was 1). This avoids "red" rendering in terminals that interpret non-zero exit as an error.

### Added

- `--namespace <name>` flag (or env `AW_NAMESPACE`) for runtime namespace selection. Resolution order: flag > env > `~/.config/agent-workflow/namespace` file > default `agent-workflow`.
- `Namespace` branded type with kebab-case validation (`^[a-z][a-z0-9-]{1,30}$`).
- `PathsService` central path resolver with namespace-aware paths.
- Runtime config schema extended with optional fields: `schemaVersion`, `displayName`, `mcpGuards.sqlMutation`, `expectedMcpServers`, `slashCommands.{migrate,projectInit,hubInit,resume,session}`.
- Interactive TTY menu when `agent-workflow` is invoked without arguments. Choices: Doctor / Update / Help / Exit.
- `self` subcommand family:
  - `self namespace` — print resolved namespace and source.
  - `self doctor` — report CLI version, namespace, paths, runtime config, skill install status.
  - `self update` — run `npm install -g @tacuchi/agent-workflow@latest` with optional TTY confirm.
  - `self install-skill` — STUB; full implementation deferred to sub-project 2 (the agent-workflow skill repo).

### Changed

- All hardcoded `.qtc/` and `~/.qtc/` paths in services replaced with `PathsService` calls.
- All `[qtc-core]` / `[qtc-dev]` message prefixes replaced with `runtime.displayName ?? "agent-workflow"`.
- Help text and `package.json` description genericized.
- Log filename `qtc-utils.log` renamed to `agent-workflow.log`.

### Removed

- Obsolete `// Mirror de qtc_core/...` comments referencing deleted Python sources.
- `DEFAULT_EXPECTED_SCRIPTS_BY_FLOW` table (Python script existence check).

### Migration for `qtc-*` plugin users

Install or upgrade your qtc-* plugins; they will set `AW_NAMESPACE=qtc` in their `SessionStart` hook (sub-project 3). Until then, manually set `export AW_NAMESPACE=qtc` in your shell, or pass `--namespace qtc` per invocation. Existing data under `~/.qtc/...` is unchanged and the CLI continues to read/write there with namespace=qtc.

## [0.9.1] — 2026-05-02

Last release before the agnostic refactor. See git history for details.
