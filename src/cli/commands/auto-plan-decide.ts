import { shouldSkipFullPlan } from "../../application/auto-plan.js";
import type { CommandResult } from "../../domain/types.js";
import { readObjetivoIfPresent } from "../helpers/objetivo-loader.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { writeStdout } from "../render.js";

export const autoPlanDecideCommand: QtcCommand = {
  name: "auto-plan-decide",
  describe: "Decide plan scope (skip|lite|full) for an OBJETIVO.",
  async execute(args: ParsedArgs): Promise<CommandResult> {
    const objetivo = await readObjetivoIfPresent(args);
    const result = shouldSkipFullPlan(objetivo ?? "");
    writeStdout(`${stringifyWithFloatField(result, "eta_hours")}\n`);
    return { ok: true, exitCode: 0 };
  },
};

function stringifyWithFloatField(value: unknown, floatField: string): string {
  const json = JSON.stringify(value, null, 2);
  const re = new RegExp(`("${floatField}":\\s+)(-?\\d+)(,?)$`, "gm");
  return json.replace(re, "$1$2.0$3");
}
