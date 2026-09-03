/**
 * El ejecutor de un flujo de autenticación declarado.
 *
 * Es el único lugar del doctor que corre un programa que no es este CLI, y todo
 * lo que hace está puesto para que el secreto no pase por acá:
 *
 * - hereda la terminal, así que el prompt del programa y lo que la persona
 *   escribe van directo entre los dos; este proceso no ve ni un byte;
 * - no captura salida —el puerto no devuelve ninguna—, así que no hay buffer
 *   nuestro donde una credencial pueda quedar ni log donde pueda terminar;
 * - no arma entorno para el hijo: hereda el que ya hay. Un flujo no recibe del
 *   CLI ninguna variable, y menos una credencial;
 * - corre el `argv` SELLADO, tal como se aprobó, sin shell y sin recomponer
 *   nada.
 *
 * Sólo es alcanzable desde `apply`: la operación declara `execute`, que no se
 * autoriza sola, así que llegar hasta acá exige que una persona haya leído la
 * vista previa —con los tokens del flujo a la vista— y aprobado su digest.
 *
 * La custodia NO se vuelve a comprobar acá, y eso es deliberado: `apply`
 * recomputa la propuesta desde el estado vivo antes de ejecutar, así que el
 * `argv` que llega a esta función lo produjo el proveedor de diagnóstico en ESTE
 * proceso, que es donde `custodyViolation` decidió. Un segundo control acá
 * serían dos guardas tapándose una a la otra.
 *
 * Y el código de salida NO decide si quedó autenticado: eso lo dice la
 * recomprobación, que le vuelve a preguntar al proveedor. Un programa que
 * devuelve 0 y una credencial que funciona son dos hechos distintos.
 */
import type { CliContext } from "../../cli/types.js";
import type { DoctorActionOutcome } from "./apply.js";
import type { DoctorBatchAction } from "./prepare.js";

export async function runDoctorAuthFlow(
  action: DoctorBatchAction,
  ctx: CliContext,
): Promise<DoctorActionOutcome> {
  const argv = action.argv ?? [];
  const program = argv[0];
  if (program === undefined) {
    // Una acción de flujo sin `argv` es un lote que no puede haber salido del
    // anotador: se declara fallida en vez de correr algo inventado.
    return {
      status: "failed",
      detail: "flujo de autenticación: la acción aprobada no lleva ningún programa sellado",
    };
  }
  if (!ctx.process.hasTty()) {
    // `blocked` y no `failed`: nada corrió y el recurso quedó como estaba. Un
    // flujo interactivo sin terminal no es un intento fallido, es un intento que
    // no corresponde hacer.
    return {
      status: "blocked",
      detail:
        "flujo de autenticación: no hay terminal para heredar, y el secreto sólo puede ir de la persona al programa por ahí",
    };
  }
  const { code } = await ctx.process.runInteractive(program, [...argv.slice(1)], {
    cwd: ctx.paths.workspaceDir(),
  });
  return code === 0
    ? { status: "applied", detail: `flujo de autenticación: ${program} terminó con código 0` }
    : { status: "failed", detail: `flujo de autenticación: ${program} terminó con código ${code}` };
}
