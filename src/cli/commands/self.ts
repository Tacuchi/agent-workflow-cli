import { selfDoctor } from "../../application/self/doctor-self.js";
import { selfNamespace } from "../../application/self/namespace-info.js";
import { selfUpdate } from "../../application/self/update-self.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

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
        return selfUpdate(ctx);
      case undefined:
      case "":
        return {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: "uso: self <namespace|doctor|update|install-skill>",
          },
          exitCode: 1,
        };
      default:
        return {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: `unknown self subcommand: '${sub}'. uso: self <namespace|doctor|update|install-skill>`,
          },
          exitCode: 1,
        };
    }
  },
};
