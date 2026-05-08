import { chooseSpecialty } from "../../application/orchestration.js";
import type { CommandResult } from "../../domain/types.js";
import { readObjetivoIfPresent } from "../helpers/objetivo-loader.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";

export const specialtyChooseCommand: QtcCommand = {
  name: "specialty-choose",
  describe: "Recommend specialty skills for a phase + OBJETIVO.",
  async execute(args: ParsedArgs): Promise<CommandResult> {
    const phase = args.values.get("phase");
    if (!phase) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "--phase es obligatorio" },
        data: { error: "--phase es obligatorio" },
        exitCode: 1,
      };
    }
    const objetivo = await readObjetivoIfPresent(args);
    const result = chooseSpecialty(phase, objetivo ?? "");
    return {
      ok: true,
      data: {
        phase,
        suggestions: result.suggestions,
        rationale: result.rationale,
        invoke_explicitly: result.invoke_explicitly,
      },
      exitCode: 0,
    };
  },
};
