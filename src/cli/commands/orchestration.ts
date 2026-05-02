import { readFile } from "node:fs/promises";
import { shouldSkipFullPlan } from "../../application/auto-plan.js";
import { chooseSpecialty, detectTopicChange } from "../../application/orchestration.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { writeStdout } from "../render.js";

async function readObjetivoIfPresent(args: ParsedArgs): Promise<string | undefined> {
  const inline = args.values.get("objetivo");
  if (inline !== undefined) return inline;
  const file = args.values.get("objetivo-file");
  if (file !== undefined) {
    try {
      return await readFile(file, "utf8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const autoPlanDecideCommand: QtcCommand = {
  name: "auto-plan-decide",
  describe: "Decide plan scope (skip|lite|full) for an OBJETIVO.",
  async execute(args: ParsedArgs): Promise<CommandResult> {
    const objetivo = await readObjetivoIfPresent(args);
    const result = shouldSkipFullPlan(objetivo ?? "");
    // Mirror Python json.dumps which emits floats with `.0` suffix even when integral.
    writeStdout(`${stringifyWithFloatField(result, "eta_hours")}\n`);
    return { ok: true, exitCode: 0 };
  },
};

function stringifyWithFloatField(value: unknown, floatField: string): string {
  const json = JSON.stringify(value, null, 2);
  // Replace `"floatField": <integer>` with `"floatField": <integer>.0` (preserve Python repr).
  const re = new RegExp(`("${floatField}":\\s+)(-?\\d+)(,?)$`, "gm");
  return json.replace(re, "$1$2.0$3");
}

export const topicChangeCheckCommand: QtcCommand = {
  name: "topic-change-check",
  describe: "Check whether the current request diverges from session OBJETIVO.",
  async execute(args: ParsedArgs): Promise<CommandResult> {
    const objetivo = await readObjetivoIfPresent(args);
    const request = args.values.get("request");
    if (!objetivo || !request) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "se requieren --objetivo (o --objetivo-file) y --request",
        },
        data: { error: "se requieren --objetivo (o --objetivo-file) y --request" },
        exitCode: 1,
      };
    }
    return { ok: true, data: detectTopicChange(objetivo, request), exitCode: 0 };
  },
};

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
