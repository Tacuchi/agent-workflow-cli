import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";

export const workflowsCommand: QtcCommand = {
  name: "workflows",
  describe: "Dump registered specialty workflows (empty when no flow plugin loaded).",
  async execute(args: ParsedArgs): Promise<CommandResult> {
    const targetFlow = args.values.get("flow");
    if (targetFlow !== undefined) {
      return {
        ok: true,
        data: {
          error: `Workflow no registrado para flow=${pythonRepr(targetFlow)}`,
          registered_flows: [],
        },
        exitCode: 0,
      };
    }
    return {
      ok: true,
      data: {
        registered_flows: [],
        count: 0,
        workflows: [],
      },
      exitCode: 0,
    };
  },
};

function pythonRepr(s: string): string {
  return `'${s}'`;
}
