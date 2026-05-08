import { detectTopicChange } from "../../application/orchestration.js";
import type { CommandResult } from "../../domain/types.js";
import { readObjetivoIfPresent } from "../helpers/objetivo-loader.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";

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
