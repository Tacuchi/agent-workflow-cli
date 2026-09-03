/**
 * El contrato de un proveedor de autenticación, y la regla de custodia que
 * decide si su flujo puede llegar a ejecutarse.
 *
 * Existe porque «está autenticado» es la única categoría del doctor donde el
 * recurso no es un archivo: es un secreto que pertenece a una persona. Eso
 * cambia quién puede hacer qué. Un proveedor puede DECIR si el sujeto está
 * autenticado, puede dar la guía para autenticarlo, y puede declarar un flujo
 * interactivo — pero el valor nunca pasa por el CLI, y esa promesa no se cumple
 * con buena intención sino con la forma de este contrato:
 *
 * - `check` y `verify` devuelven un estado y su evidencia, y la evidencia dice
 *   PRESENTE o AUSENTE. Leer el valor para describirlo dejaría al informe a un
 *   defecto de redacción de distancia de publicarlo.
 * - `guidance` nombra la variable y el archivo de arranque, nunca el valor: lo
 *   que la persona pega, el CLI no lo ve ni lo guarda.
 * - `flow` es la ÚNICA forma en que un proveedor puede pedir que se ejecute
 *   algo, y su forma no tiene dónde poner un secreto: no lleva entorno ni
 *   archivo, así que un flujo no puede pedirle al CLI que escriba la credencial
 *   en ninguna parte. Lo que sí puede expresar —un secreto en el `argv`, un
 *   flujo no interactivo, un flujo que escribe— lo ataja {@link custodyViolation}.
 *
 * El contrato es genérico sobre su contexto a propósito: el dominio no puede
 * saber qué es un contexto de CLI, y un proveedor real necesita uno para leer el
 * entorno. Quién lo instancia es el registro, que vive en la aplicación por esa
 * misma razón.
 */
import type { EffectClass } from "../capability/effects.js";
import { carriesSecretMaterial, isSecretFlag } from "../redaction.js";

/**
 * Los tres estados, y el tercero es el que hace honesto al informe.
 *
 * `unverified` no es «no sé»: es «no se pudo concluir», y presentarlo como
 * `present` es exactamente la falsa salud que el modelo del doctor existe para
 * no decir. Una credencial que está pero que el servicio rechaza cae acá: la
 * variable existe y la autenticación no sirve, y las dos cosas van en la
 * evidencia.
 */
export type DoctorAuthState = "present" | "absent" | "unverified";

/**
 * Una cosa autenticable, nombrada sin su valor.
 *
 * `id` es la identidad del hallazgo que este sujeto va a producir, así que tiene
 * que ser único en TODO el registro: dos sujetos con el mismo id colapsan en una
 * fila y el informe pierde uno sin decirlo. Cada proveedor prefija los suyos, y
 * el proveedor de diagnóstico denuncia la colisión en vez de dejarla pasar.
 */
export interface DoctorAuthSubject {
  id: string;
  /** Qué es, para mostrar: la variable, el servicio. Nunca un valor. */
  label: string;
  /** Dónde vive la credencial — un archivo, un nombre de variable. Nunca un valor. */
  locator: string | null;
}

/** Un estado con lo que se observó para afirmarlo. La evidencia no lleva valores. */
export interface DoctorAuthCheck {
  state: DoctorAuthState;
  evidence: string[];
}

/**
 * Un flujo declarado: lo único que un proveedor puede pedir que se ejecute.
 *
 * No tiene `env` ni `file` y eso es la mitad de la custodia: un flujo no puede
 * pedirle al CLI que ponga el secreto en el entorno de un hijo ni que lo escriba
 * en un archivo, porque no hay dónde declararlo. La otra mitad es que el `argv`
 * se comprueba antes de sellar el lote.
 *
 * `interactive` no es una preferencia: un flujo de credenciales que no hereda la
 * terminal sólo puede obtener el secreto de algo que el CLI le pase, y eso es
 * justamente lo que no puede pasar. `effects` son las clases que el flujo
 * necesita, y se suman a las de la operación para que la aprobación cubra lo que
 * el flujo realmente hace.
 */
export interface DoctorAuthFlow {
  kind: "command";
  /** El programa y sus argumentos, ya separados. Nunca una línea de shell. */
  argv: readonly string[];
  interactive: boolean;
  effects: readonly EffectClass[];
}

/**
 * La verificación, con el nivel de autorización que exige.
 *
 * `authorization` es la clase de efecto que la verificación PROFUNDA necesita
 * (salir de la máquina, por ejemplo). `run` recibe lo que la corrida autorizó: si
 * no incluye esa clase, la verificación se degrada a la superficial y lo DICE en
 * su evidencia. Una verificación que se salta su autorización en silencio y otra
 * que miente sobre lo que comprobó son el mismo defecto.
 */
export interface DoctorAuthVerify<Ctx> {
  authorization: EffectClass | null;
  run(
    subject: DoctorAuthSubject,
    ctx: Ctx,
    granted: readonly EffectClass[],
  ): Promise<DoctorAuthCheck>;
}

export interface DoctorAuthProvider<Ctx> {
  /** Id estable del proveedor. Viaja en la acción para volver a encontrarlo. */
  id: string;
  /** Qué hay que autenticar en este entorno. Vacío = nada que comprobar. */
  subjects(ctx: Ctx): readonly DoctorAuthSubject[];
  /** La lectura barata que el informe hace siempre. */
  check(subject: DoctorAuthSubject, ctx: Ctx): Promise<DoctorAuthCheck>;
  /** El flujo declarado, o `null` cuando autenticarlo no es automatizable. */
  flow(subject: DoctorAuthSubject, ctx: Ctx): DoctorAuthFlow | null;
  verify: DoctorAuthVerify<Ctx>;
  /** Cómo lo autentica una persona. Nombra la variable y el archivo, nunca el valor. */
  guidance(subject: DoctorAuthSubject, ctx: Ctx): string[];
}

/**
 * Las clases que un flujo puede declarar sin romper la custodia.
 *
 * Correr un programa es lo que un flujo ES, y salir de la máquina es lo que un
 * login hace. Cualquier clase que ESCRIBA —crear, pisar, destruir— significa que
 * el flujo dejaría algo en disco, y lo único que un flujo de autenticación
 * tendría para dejar es la credencial.
 */
const CUSTODY_SAFE_EFFECTS: ReadonlySet<EffectClass> = new Set<EffectClass>([
  "execute",
  "network_external",
]);

/**
 * Por qué este flujo NO puede ejecutarse, o `null` si puede.
 *
 * Las tres formas en que un flujo declarado rompería la custodia, y las tres son
 * expresables —por eso se comprueban acá y no se confían a una revisión—:
 *
 * 1. El secreto viaja en el `argv`. Se usan los MISMOS predicados que el recibo
 *    MCP: un valor con forma de credencial, o un flag que pide una. Un argumento
 *    queda en la tabla de procesos de la máquina y en el historial del shell, así
 *    que ahí el secreto ya se filtró antes de que el programa arranque.
 *    Los nombres se reconocen por la lista de claves sensibles del propio
 *    redactor, así que `--access-token`, `--client-secret`, `--credentials` y
 *    `--private-key` bloquean igual que `--token`. Lo que NINGUNA lista de
 *    nombres puede cubrir es un flag que no dice qué transporta (`--pat`, `-t`):
 *    ese residuo queda, y por eso esta comprobación no es la única defensa —
 *    también hace falta que el flujo sea interactivo, que es lo que hace
 *    innecesario poner el secreto en la línea de comandos.
 * 2. El flujo no es interactivo. Un programa que no hereda la terminal no tiene
 *    de dónde leer la credencial salvo de lo que el CLI le pase —su entorno, su
 *    stdin, un archivo—, y entonces la custodia pasó a ser del CLI.
 * 3. El flujo declara una clase que escribe. Lo único que un flujo de
 *    autenticación podría escribir es el secreto.
 *
 * Devuelve la razón y no un booleano porque el hallazgo la publica: «bloqueado
 * por custodia» sin decir cuál de las tres es un informe que no se puede
 * accionar.
 */
export function custodyViolation(flow: DoctorAuthFlow): string | null {
  if (flow.argv.length === 0) {
    return "el flujo declarado no tiene ningún programa que correr";
  }
  const secret = flow.argv.find((token) => isSecretFlag(token) || carriesSecretMaterial(token));
  if (secret !== undefined) {
    // El token NO se cita: es lo que se está acusando de ser un secreto.
    return "el flujo pediría la credencial en un argumento de la línea de comandos, donde queda a la vista de toda la máquina";
  }
  if (!flow.interactive) {
    return "el flujo no hereda la terminal, así que la credencial tendría que pasar por el entorno o por un archivo que escribiría el CLI";
  }
  const writes = flow.effects.filter((effect) => !CUSTODY_SAFE_EFFECTS.has(effect));
  if (writes.length > 0) {
    return `el flujo declara efectos que escriben (${writes.join(", ")}), y lo único que tendría para escribir es la credencial`;
  }
  return null;
}

/** El estado de hallazgo que le corresponde a un estado de autenticación. */
export function authFindingState(state: DoctorAuthState): "healthy" | "warning" | "unverified" {
  if (state === "present") return "healthy";
  return state === "absent" ? "warning" : "unverified";
}
