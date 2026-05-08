import { selfDoctor } from "../../application/self/doctor-self.js";
import { selfInstallSkill } from "../../application/self/install-skill.js";
import { selfNamespace } from "../../application/self/namespace-info.js";
import { selfUpdate } from "../../application/self/update-self.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

const SELF_SUBCOMMANDS = ["namespace", "doctor", "update", "install-skill"] as const;

export const selfCommand: QtcCommand = {
  name: "self",
  describe: "Manage the agent-workflow CLI itself (namespace, doctor, update, install-skill).",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const sub = args.rest[0];
    switch (sub) {
      case "namespace":
        return selfNamespace(ctx);
      case "doctor":
        return selfDoctor(ctx);
      case "update":
        return selfUpdate(args, ctx);
      case "install-skill":
        return selfInstallSkill(args, ctx);
      case undefined:
      case "":
        return {
          ok: true,
          data: {
            subcommands: [...SELF_SUBCOMMANDS],
            help_hint:
              "uso: aw self <subcommand>. Ej: 'aw self doctor' o 'aw self update --dry-run'",
          },
          exitCode: 0,
        };
      default:
        return {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: `unknown self subcommand: '${sub}'. uso: self <${SELF_SUBCOMMANDS.join("|")}>`,
          },
          exitCode: 1,
        };
    }
  },
};
