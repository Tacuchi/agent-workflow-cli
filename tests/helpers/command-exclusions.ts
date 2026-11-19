/**
 * A public command with no journey decision of its own, and why.
 *
 * The exclusion is the honest half of exhaustiveness: a command that decides
 * nothing about how a flow advances still has to say so. Leaving it unlisted
 * would look identical to forgetting it, so the guard demands one or the other.
 */
export interface CommandExclusion {
  command: string;
  reason: string;
}

/**
 * Public commands with no journey decision of their own.
 *
 * Read together with `FLOW_DECISIONS` this is the exhaustiveness claim:
 * every registered command is either classified or excluded on the record.
 *
 * The universe is TWO surfaces, not one. Most entries name an `aw` command, but a
 * `/w:` command that starts no loop is a public journey just the same, and the
 * only one of those the engine cannot direct earns its exclusion here rather than
 * a second list: one field, one reason, one guard.
 */
export const COMMAND_EXCLUSIONS: readonly CommandExclusion[] = [
  {
    command: "hub-compact",
    reason:
      "capacidad transversal sin AgentWorkflowFlow ni sesión: inventory y prepare leen; apply exige el digest exacto, revalida bajo bloqueo y conserva originales recuperables; restore tiene su propia propuesta aprobada",
  },
  {
    command: "hub-commit",
    reason:
      "comando transversal sin corrida propia: prepare sella mensaje y pathspec del hub y apply exige ese digest; el cierre del chasis también lo invoca sólo después del consentimiento humano",
  },
  {
    command: "hub-move",
    reason:
      "mudanza o reparación puntual de un hub; valida el destino y las referencias vivas antes de mover, sin abrir una corrida adicional",
  },
  {
    command: "hubs",
    reason:
      "registro de hubs de la máquina, sin corrida propia: la lista, scan sin --apply y status sólo leen; scan --apply y prune escriben ~/.<ns>/hubs.json por la escritura atómica del registro",
  },
  {
    command: "spec-new",
    reason:
      "comando `/w:` de una sola pasada que no abre loop: sin corrida que dirigir, su gate de división lo aplica el propio comando con la regla de modules/SPLIT-GATE.md, que por eso conserva su enunciado",
  },
  {
    command: "discard",
    reason:
      "comando transversal de retiro: no abre AgentWorkflowFlow ni sesión a propósito, porque puede terminar borrando la sesión que lo dirigiera. Su autoridad es su propio contrato: `prepare` read-only y `apply` con el digest exacto, recomputado bajo el lock del hub",
  },
  {
    command: "reset",
    reason:
      "comando transversal de retiro: mismo contrato que `discard` en modo restauración, sin corrida propia por la misma razón — la sesión que vuelve atrás es la que se retira",
  },
  {
    command: "claims",
    reason:
      "comando transversal de reservas: mismo contrato que `discard` y `reset` —vista previa y `--approval` con el digest recomputado sobre el árbol vivo— y sin corrida propia por una razón más fuerte todavía, porque la reserva que libera puede ser la de la corrida que lo dirigiera. Su autoridad es el orden que aplica: comprobar que el marcador sigue intacto, sellar la revocación irrevocable acotada al claim y sólo después liberar",
  },
  {
    command: "cut-intent",
    reason:
      "comando declarativo de estado del hub: registra la intención con que un corte de planes se pensó ejecutar y la relee, sin corrida propia porque no hay recorrido que dirigir —declarar un orden es UN acto, no un tramo con fronteras—. No lleva `prepare`/`apply` porque no ejerce ningún efecto sobre el trabajo: agrega un evento a un libro append-only bajo el namespace del hub, y corregir es declarar de nuevo, con el registro anterior conservado y legible. Su autoridad es lo que NO hace: no impone el orden que registra, así que ejecutar fuera de él se avisa y nunca se rechaza",
  },
  {
    command: "release-pass",
    reason:
      "comando declarativo de estado del hub, hermano de `cut-intent`: declara un pase a producción, registra la llegada de cada fuente y su reversión, sin corrida propia por la misma razón —registrar un hecho que ya ocurrió no es un tramo con fronteras—. Su autoridad también es lo que se niega a hacer: una llegada se DECLARA y no se comprueba contra un registro de paquetes ni contra un host desplegado, porque el registro no puede depender de alcanzar la red para decir lo que alguien ya sabe; y enlazar un artefacto sólo comprueba que la ruta existe, sin abrirlo, moverlo, renumerarlo ni ejecutarlo",
  },
  {
    command: "reseal",
    reason:
      "comando transversal de mantenimiento documental: mismo contrato que `discard`, `reset` y `claims` —`prepare` read-only y `apply` con el digest exacto recomputado bajo el lock del hub— y sin corrida propia porque no hay recorrido que dirigir: re-sellar es UNA afirmación humana sobre un plan que sigue valiendo, no un tramo con fronteras. La divergencia que sí exige rediseñar el plan sigue entregándose a `/w:plan-refine`",
  },
  {
    command: "amend",
    reason:
      "comando transversal de mantenimiento documental, un escalón por debajo de `reseal`: corrige la REDACCIÓN de una spec o un plan ya cerrados en un solo acto, sin corrida propia porque no hay recorrido que dirigir —una frase que se lee mal no es un tramo con fronteras—. No lleva `prepare`/`apply` porque ese molde existe para que una persona decida entre los dos pasos, y acá el candado del hub más el compare-and-swap sobre el digest del documento dan la misma seguridad en una invocación. Lo que sí toca el contrato se rechaza estructuralmente y se entrega a `/w:spec-refine` o `/w:plan-refine`",
  },
  {
    command: "settle",
    reason:
      "comando transversal de mantenimiento documental, hermano de `reseal`: salda o reconoce las obligaciones que una nota de decisión dejó vivas sobre un plan cuya corrida de ejecución ya cerró. Sin corrida propia por la misma razón que `reseal` —lo que ocurre entre sus dos pasos es UNA afirmación humana, que el trabajo compensatorio se hizo o que era de otra gente, no un tramo con fronteras— y con el mismo contrato: `prepare` read-only y `apply` con el digest recomputado sobre el árbol vivo bajo el lock del hub. Mientras una corrida de ejecución tenga ese plan, se niega y la nombra: el cierre de esa corrida salda sus propias obligaciones",
  },
  {
    command: "plan",
    reason:
      "comando transversal de lectura de un plan: `lint` corre sobre el documento las mismas funciones que la publicación y la entrada a ejecución, y devuelve todas las violaciones de la gramática de una vez, sin corrida propia porque no hay recorrido que dirigir ni nada que escribir —juzgar un documento no es un tramo con fronteras—. No crea sesión, no toca ninguna corrida y no gasta intento",
  },
  {
    command: "recall",
    reason:
      "comando transversal sin recorrido propio, apoyado en `aw host-memory`: el contraste y la oferta son juicio del agente, y guardar es el acto del host actual por su propio canal tras la confirmación de la persona, nunca un tramo con fronteras que dirigir",
  },
  {
    command: "host-memory",
    reason:
      "lectura read-only de la memoria curada de los otros hosts, sin corrida propia porque no hay recorrido que dirigir: informa y no escribe. Guardar un aprendizaje es el acto del host actual por su propio canal, nunca de este comando",
  },
  { command: "sessions", reason: "listado read-only del inventario de sesiones" },
  { command: "session-artifacts", reason: "inspección read-only de lo que guarda una sesión" },
  { command: "checkpoint-read", reason: "lectura del CHECKPOINT sin decidir continuación" },
  { command: "stack", reason: "detección de stack informativa" },
  { command: "sources", reason: "inventario de fuentes del hub" },
  { command: "set-working-branch", reason: "configuración declarativa de rama" },
  {
    command: "doc-branch",
    reason:
      "asociación declarativa de una rama de trabajo a un documento, con lectura sin efectos y escritura append-only después de asegurar la rama",
  },
  { command: "set-qa-branch", reason: "configuración declarativa de rama" },
  { command: "set-exception-branch", reason: "configuración declarativa de rama" },
  { command: "set-edit-mode", reason: "configuración declarativa del hub" },
  { command: "set-pipeline", reason: "configuración declarativa de build y test por fuente" },
  { command: "remove-source", reason: "operación de configuración del hub" },
  { command: "add-source", reason: "operación de configuración del hub" },
  { command: "git-flow", reason: "utilidad de ramas sin recorrido de flow" },
  { command: "merge-state", reason: "lectura del estado de una fusión" },
  { command: "attach-multiroot", reason: "configuración de multiroot" },
  { command: "detach-multiroot", reason: "configuración de multiroot" },
  { command: "visibility", reason: "configuración de visibilidad de fuentes" },
  { command: "skills", reason: "diagnóstico de capacidades propias y su readiness" },
  {
    command: "export-diagrams",
    reason:
      "comparte la clasificación de export-reports: selección semántica del agente más corpus, numeración y escritura del CLI, con su propio destino documental",
  },
  {
    command: "export-manuals",
    reason:
      "comparte la clasificación de export-reports: selección semántica del agente más corpus, numeración y escritura del CLI, con su propio destino documental",
  },
  {
    command: "export-scripts",
    reason:
      "comparte la clasificación de export-reports: selección semántica del agente más corpus, numeración y escritura del CLI, con su propio destino documental",
  },
  { command: "history-update", reason: "reparación del registro durable" },
  {
    command: "session-pause",
    reason: "marca explícita de pausa por decisión humana, fuera de recorridos",
  },
  { command: "history", reason: "reconciliación de sólo lectura del registro de sesiones" },
  { command: "hub-block", reason: "escritura del bloque del hub en el host" },
  {
    command: "hub-migrate",
    reason:
      "puesta al día puntual de un hub con serie legacy: no abre recorrido ni sesión, y su autoridad es su propio contrato — sin `--apply` no escribe nada, y una sesión sobre la que el histórico y el disco se contradicen queda intacta",
  },
  { command: "code-scan", reason: "barrido read-only del código" },
  { command: "plugin-doctor", reason: "diagnóstico de instalación" },
  { command: "host-doctor", reason: "diagnóstico de hosts" },
  {
    command: "doctor",
    reason:
      "misma clasificación que los doctores que compone: diagnóstico sin recorrido propio, y el veredicto viaja en el código de salida sin decidir nada por la persona. Sus subverbos de reparación no abren corrida por la misma razón que `discard`, `reset` y `claims`: su autoridad es el orden que aplican —`prepare` sin escribir, y `apply` recomputando la propuesta bajo el lock del hub para comparar el digest exacto que la persona aprobó—",
  },
  { command: "release-data", reason: "datos de release del paquete" },
  { command: "self", reason: "instalación y mantenimiento del propio CLI" },
  { command: "harness", reason: "dev-only: inspección del harness" },
  { command: "profiles", reason: "dev-only: perfiles de ejecución" },
  { command: "logs", reason: "dev-only: lectura de logs" },
  { command: "flow", reason: "el motor mismo: aplica el registro, no declara una fila propia" },
];
