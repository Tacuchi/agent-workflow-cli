/**
 * El proveedor de autenticación de las conexiones registradas.
 *
 * Es el único proveedor real que este CLI tiene, y su sujeto es la variable
 * `DB_<X>_DSN` de cada conexión del registro. Declara `flow: null` y lo declara
 * A PROPÓSITO: autenticar una conexión es exportar una cadena que sólo la
 * persona conoce, y no existe ningún comando que el CLI pueda correr para
 * obtenerla sin custodiarla. Un flujo acá sería el CLI pidiendo el secreto para
 * ponerlo en algún lado.
 *
 * La verificación tiene dos niveles y la diferencia es material: la presencia se
 * lee del entorno y del archivo de DSNs, y no sale de la máquina; el `SELECT 1`
 * sí sale, así que este proveedor lo DECLARA en `verify.authorization` y el
 * recorrido del registro sólo llama a `run` cuando la corrida concedió esa clase.
 * Sin ella la observación se degrada a la presencia, y quien lo dice es ese mismo
 * recorrido: acá no hay un segundo control del mismo hecho.
 */
import type { CliContext } from "../../cli/types.js";
import type {
  DoctorAuthCheck,
  DoctorAuthProvider,
  DoctorAuthSubject,
} from "../../domain/doctor/auth.js";
import { readMcpConnections } from "../mcp-connections-service.js";
import { testMcpConnection } from "../mcp-test-connection-service.js";
import { buildEnvHelp, isDsnVisible } from "../self/mcp-config.js";

/** El prefijo que hace único el id de un sujeto de este proveedor en todo el registro. */
const SUBJECT_PREFIX = "env:";

export const dsnAuthProvider: DoctorAuthProvider<CliContext> = {
  id: "dsn",

  subjects(ctx: CliContext): readonly DoctorAuthSubject[] {
    return readMcpConnections(ctx.paths, ctx.env).map((connection) => ({
      id: `${SUBJECT_PREFIX}${connection.name}`,
      label: connection.dsnVar,
      locator: ctx.paths.userDsnFile(),
    }));
  },

  async check(subject: DoctorAuthSubject, ctx: CliContext): Promise<DoctorAuthCheck> {
    const visible = isDsnVisible(ctx, subject.label);
    return {
      state: visible ? "present" : "absent",
      // La evidencia dice PRESENTE o AUSENTE y se detiene ahí. Leer el valor
      // para describirlo dejaría al informe a un defecto de redacción de
      // publicarlo.
      //
      // El nombre de la variable va SIEMPRE entre paréntesis, y eso es
      // load-bearing: el redactor lee `<algo>_DSN` seguido de `=`, `:` o un
      // espacio como una asignación y reemplaza lo que viene después. Nombrar la
      // variable es exactamente lo que este hallazgo le debe a la persona, así
      // que el único lugar donde aparece tiene que ser una forma que el redactor
      // no pueda leer como un valor: un paréntesis de cierre no es un separador,
      // así que `(DB_X_DSN)` sobrevive y `DB_X_DSN: presente` no.
      evidence: [`variable de entorno (${subject.label}): ${visible ? "presente" : "ausente"}`],
    };
  },

  /**
   * Ningún flujo, y declarado como tal.
   *
   * El informe lo publica: «esta autenticación no es automatizable» es una
   * respuesta, y dejarla implícita haría que la persona espere una reparación
   * que nunca va a existir.
   */
  flow(): null {
    return null;
  },

  verify: {
    authorization: "network_external",
    async run(subject: DoctorAuthSubject, ctx: CliContext): Promise<DoctorAuthCheck> {
      const visible = isDsnVisible(ctx, subject.label);
      if (!visible) {
        return {
          state: "absent",
          evidence: [`variable de entorno (${subject.label}): ausente, no hay nada que verificar`],
        };
      }
      // Acá NO se vuelve a comprobar la autorización: el llamador hace valer el
      // `authorization` que este proveedor declara y sólo llega hasta acá cuando
      // está concedida. Repetirlo serían dos controles del mismo hecho, y el que
      // se rompiera quedaría tapado por el otro.
      const result = await testMcpConnection({
        dsnVar: subject.label,
        env: { [subject.label]: ctx.env.get(subject.label) },
        paths: ctx.paths,
        platform: process.platform,
      });
      if (result.ok) {
        return {
          state: "present",
          evidence: [
            `variable de entorno (${subject.label}): presente`,
            "la base respondió a un SELECT 1 de sólo lectura",
          ],
        };
      }
      // La credencial ESTÁ y no sirve, y eso no es «ausente»: es una
      // verificación que no pudo concluir que la autenticación funciona. Decirlo
      // `present` porque la variable existe es la falsa salud que este modelo
      // existe para no decir.
      return {
        state: "unverified",
        evidence: [
          `variable de entorno (${subject.label}): presente`,
          `la base no respondió: ${result.error ?? "sin detalle"}`,
        ],
      };
    },
  },

  /**
   * La guía nombra la variable y el archivo de arranque, nunca el valor.
   *
   * El nombre de la conexión sale del id del sujeto por el prefijo que ESTE
   * archivo le puso: es su propia codificación, decodificada con la misma
   * constante y en el mismo módulo. No es leer un id ya renderizado por otro
   * lado para recuperar un dato estructural — el prefijo está acá justamente
   * para que los ids de este proveedor sean únicos en todo el registro.
   */
  guidance(subject: DoctorAuthSubject, _ctx: CliContext): string[] {
    return survivingGuidance(buildEnvHelp(subject.label, subject.id.slice(SUBJECT_PREFIX.length)));
  },
};

/**
 * La guía de `buildEnvHelp`, reescrita para que la redacción no la vuelva dañina.
 *
 * `buildEnvHelp` emite `export DB_X_DSN='<DSN>'`, que es correcto y no lleva
 * ningún valor — pero `redactSensitiveText` lee `…_DSN=` como una asignación y
 * reemplaza lo que sigue, así que la línea LLEGA a la persona como
 * `export DB_X_DSN=***`. Quien la copie deja literalmente `***` en su archivo de
 * arranque y el MCP falla con una credencial inválida en vez de con una ausente:
 * una guía que empeora las cosas es peor que ninguna.
 *
 * Así que la línea se parte en dos: el nombre de la variable —lo único
 * accionable que este hallazgo puede dar— va parentizado, y el valor se nombra
 * como lo que es, algo que la persona pega y el CLI nunca ve. `next_step` se
 * releva tal cual: no lleva el nombre pegado a un separador.
 */
function survivingGuidance(help: ReturnType<typeof buildEnvHelp>): string[] {
  return [
    // Ojo con la prosa: cualquier aparición del token de un secreto SEGUIDA de
    // espacio se lleva la palabra siguiente. Por eso acá no se escribe la sigla
    // suelta, y el nombre de la variable va siempre entre paréntesis.
    `exportá en tu entorno la variable (${help.variable}) con la cadena de conexión; el valor lo pegás vos y el CLI no lo guarda en ningún lado`,
    durableStep(help),
    help.next_step,
  ];
}

/**
 * Cómo hacer que la variable sobreviva a la próxima terminal, en ESTA plataforma.
 *
 * `buildEnvHelp` sólo nombra un archivo de arranque en la rama *nix; en Windows
 * devuelve dos comandos de PowerShell y ninguno lleva `>>`. Buscar el archivo y
 * caer en «el de tu shell» dejaba a quien corre en Windows con una guía que
 * nombra algo que no existe, y descartaba el único mecanismo durable que su
 * plataforma tiene — que `buildEnvHelp` sí conoce y que acá se NOMBRA en vez de
 * relevarse como comando: la línea literal es una asignación, y el redactor la
 * entrega con `***` donde iba el valor.
 */
function durableStep(help: ReturnType<typeof buildEnvHelp>): string {
  if (help.platform === "windows") {
    return `para que sobreviva a la próxima terminal, guardala en tu entorno de usuario con SetEnvironmentVariable de PowerShell a nivel "User", nombrando la misma variable (${help.variable})`;
  }
  const named = help.commands.find((command) => command.includes(">>"));
  const file = named?.split(">>").pop()?.trim();
  const where = file === undefined || file.length === 0 ? "el de tu shell" : file;
  return `dejala en tu archivo de arranque (${where}) para que sobreviva a la próxima terminal`;
}
