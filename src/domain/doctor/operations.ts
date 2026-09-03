/**
 * El catálogo de reparaciones: qué operación ya soportada arregla cada hallazgo.
 *
 * Ninguna entrada acá implementa una reparación. Cada una NOMBRA la función de
 * aplicación que ya sabe escribir —la misma que el comando especializado
 * invoca— y declara tres cosas que el lote necesita antes de existir: sus clases
 * de efecto del vocabulario cerrado, el estado que el recurso debería alcanzar
 * cuando aplique, y el verbo del CLI que una persona podría tipear en su lugar.
 *
 * El verbo es para MOSTRAR y nada más: se compone para la vista previa y jamás
 * se ejecuta como texto. Una reparación que se aplicara pasando una cadena a un
 * shell sería una inyección esperando el nombre de recurso equivocado, y los
 * nombres de este informe vienen de archivos que escribió otra persona.
 *
 * `delegates` no es documentación: es lo que ata cada operación a su única
 * implementación. Dos formas de instalar el bundle terminan discrepando, y el
 * plan existe justamente para no volver a tener dos reglas de lo mismo.
 */
import type { EffectClass } from "../capability/effects.js";
import type { DoctorFindingState } from "./model.js";

export interface DoctorOperationSpec {
  /** Id estable. Viaja en la acción, en el sello del lote y en la selección. */
  op: string;
  /** La función de aplicación que escribe. Una por operación, nunca dos. */
  delegates: string;
  effects: readonly EffectClass[];
  /** El estado que el recurso debería alcanzar. La recomprobación lo confirma o no. */
  expected: DoctorFindingState;
  /** Qué hace, en una frase, para la vista previa. */
  summary: string;
  /** El comando equivalente, compuesto para mostrar. Nunca se ejecuta. */
  verb: (args: Readonly<Record<string, string>>) => string;
}

function flag(args: Readonly<Record<string, string>>, name: string): string {
  const value = args[name];
  return value === undefined ? "" : ` --${name} ${value}`;
}

export const DOCTOR_OPERATIONS: readonly DoctorOperationSpec[] = [
  {
    op: "self.install-skill",
    delegates: "selfInstallSkill",
    // Crea el bundle donde falta y REESCRIBE el que quedó viejo: las dos clases,
    // porque aprobar una instalación nueva no es aprobar que se pise una que ya
    // estaba.
    effects: ["local_additive", "mutate_overwrite"],
    expected: "healthy",
    summary: "instala el bundle de Workline en ese host",
    verb: (args) => `aw self install-skill${flag(args, "target")}`,
  },
  {
    op: "self.uninstall",
    delegates: "selfUninstall",
    effects: ["destructive"],
    expected: "healthy",
    summary: "retira la configuración de Workline que quedó sin runtime que la use",
    verb: (args) => `aw self uninstall${flag(args, "target")}`,
  },
  {
    op: "self.install-hooks",
    delegates: "selfInstallHooks",
    effects: ["mutate_overwrite"],
    expected: "healthy",
    summary: "arma los hooks de Workline en la configuración de ese host",
    verb: (args) => `aw self install-hooks${flag(args, "target")}`,
  },
  {
    op: "self.clean-legacy",
    delegates: "selfCleanLegacy",
    effects: ["destructive"],
    expected: "healthy",
    summary: "retira el bundle que dejó una instalación anterior",
    verb: (args) => `aw self clean-legacy${flag(args, "target")}`,
  },
  {
    op: "mcp.setup",
    delegates: "runMcpSetup",
    effects: ["mutate_overwrite"],
    expected: "healthy",
    summary: "registra la entrada MCP de esa conexión en el host",
    verb: (args) =>
      `aw mcp setup${flag(args, "host")}${flag(args, "instance")}${flag(args, "scope")}`,
  },
  {
    op: "mcp.remove",
    delegates: "runMcpRemove",
    effects: ["destructive"],
    expected: "healthy",
    summary: "retira del host una entrada MCP que ya no está registrada",
    verb: (args) =>
      `aw mcp remove${flag(args, "host")}${flag(args, "instance")}${flag(args, "scope")}`,
  },
  {
    op: "mcp.migrate",
    delegates: "runMcpMigration",
    effects: ["mutate_overwrite", "destructive"],
    expected: "healthy",
    summary: "mueve una entrada histórica a su ubicación vigente y retira la vieja",
    verb: (args) =>
      `aw mcp migrate${flag(args, "host")}${flag(args, "instance")}${flag(args, "scope")}`,
  },
  {
    op: "skills.reinstall",
    delegates: "reinstallSkill",
    effects: ["mutate_overwrite"],
    expected: "healthy",
    summary: "vuelve a materializar las réplicas de una skill registrada",
    verb: (args) => `aw self skills reinstall${flag(args, "name")}`,
  },
  {
    op: "auth.flow",
    delegates: "runDoctorAuthFlow",
    // `execute` y nada más de este lado: correr el flujo es lo que la operación
    // ES. Lo que el flujo además necesite —salir a la red, por ejemplo— lo
    // declara el flujo, y el anotador SUMA esas clases a estas antes de sellar.
    // Ninguna de las dos se autoriza sola.
    effects: ["execute"],
    expected: "healthy",
    summary: "corre el flujo de autenticación que declara el proveedor, heredando la terminal",
    // El verbo NOMBRA el flujo; no lo compone. Los tokens del `argv` viajan
    // sellados en la acción y la vista previa los muestra desde ahí: escribir
    // acá una línea de comando armada invitaría a ejecutarla como texto, que es
    // exactamente lo que este catálogo no hace en ningún caso.
    // Los dos nombres van PARENTIZADOS, y no es estética: el id del único
    // proveedor real es `dsn`, y el redactor lee cualquier token de secreto
    // seguido de un espacio como una asignación y borra la palabra siguiente. Sin
    // los paréntesis, este verbo llega al informe como «por dsn *** env:x».
    verb: (args) =>
      `el flujo declarado por el proveedor (${args.provider ?? "sin nombre"}) para el sujeto (${args.subject ?? "sin nombre"})`,
  },
  {
    op: "multiroot.attach",
    delegates: "runMultiroot",
    effects: ["mutate_overwrite"],
    expected: "healthy",
    summary: "registra en el host las rutas del workspace que faltaban",
    verb: () => "aw attach-multiroot --from-sources",
  },
  {
    op: "multiroot.detach",
    delegates: "runMultiroot",
    effects: ["mutate_overwrite"],
    expected: "healthy",
    summary: "quita del host rutas registradas que el workspace no declara",
    verb: () => "aw detach-multiroot --from-sources",
  },
];

const BY_OP = new Map(DOCTOR_OPERATIONS.map((spec) => [spec.op, spec]));

export function doctorOperation(op: string): DoctorOperationSpec | null {
  return BY_OP.get(op) ?? null;
}
