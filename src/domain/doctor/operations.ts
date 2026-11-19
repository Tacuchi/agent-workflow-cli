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
    summary: "instala el bundle de agent-workflow en ese host",
    verb: (args) => `aw self install-skill${flag(args, "target")}`,
  },
  {
    op: "self.uninstall",
    delegates: "selfUninstall",
    effects: ["destructive"],
    expected: "healthy",
    summary: "retira la configuración de agent-workflow que quedó sin runtime que la use",
    verb: (args) => `aw self uninstall${flag(args, "target")}`,
  },
  {
    op: "self.install-hooks",
    delegates: "selfInstallHooks",
    effects: ["mutate_overwrite"],
    expected: "healthy",
    summary: "arma los hooks de agent-workflow en la configuración de ese host",
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
    op: "multiroot.attach",
    delegates: "runMultiroot",
    effects: ["mutate_overwrite"],
    expected: "healthy",
    summary: "registra en el host las rutas del hub que faltaban",
    verb: () => "aw attach-multiroot --from-sources",
  },
  {
    op: "multiroot.detach",
    delegates: "runMultiroot",
    effects: ["mutate_overwrite"],
    expected: "healthy",
    summary: "quita del host sólo las rutas sobrantes nombradas en la propuesta sellada",
    verb: (args) => {
      try {
        const exact: unknown = JSON.parse(args.paths ?? "null");
        if (Array.isArray(exact) && exact.every((path) => typeof path === "string"))
          return `aw detach-multiroot ${exact.map((path: string) => `--path '${path.replaceAll("'", "'\\''")}'`).join(" ")}`;
      } catch {
        /* una propuesta sin rutas legibles se rechaza al aplicar */
      }
      return "aw detach-multiroot --path <rutas selladas>";
    },
  },
  {
    op: "hub.remove-retired-section",
    delegates: "applyRetiredSectionRemoval",
    effects: ["destructive"],
    expected: "healthy",
    summary: "quita las secciones que citan comandos o skills retirados del archivo del proyecto",
    verb: () => "aw doctor prepare --select <hallazgo-archivo>",
  },
];

const BY_OP = new Map(DOCTOR_OPERATIONS.map((spec) => [spec.op, spec]));

export function doctorOperation(op: string): DoctorOperationSpec | null {
  return BY_OP.get(op) ?? null;
}
