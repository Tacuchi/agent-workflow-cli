import { runCheckpointRead } from "../../application/checkpoint-service.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { failSessionResolution } from "../render.js";
import type { CliContext } from "../types.js";

export const checkpointReadCommand: CliCommand = {
  name: "checkpoint-read",
  flags: { known: ["code"] },
  help: {
    purpose: "Read the CHECKPOINT.md of the conversation's session or of the one named.",
    flags: {
      code: {
        value: "<code>",
        effect: "Session to read; defaults to the one bound to this conversation.",
      },
    },
    output:
      "{session, checkpoint (parsed fields, or null when CHECKPOINT.md does not exist), reason?}. Read-only.",
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const contextId = readContextId(ctx.env);
    const data = await runCheckpointRead(ctx.fs, ctx.paths, {
      ...(code !== undefined ? { code } : {}),
      ...(contextId !== undefined ? { contextId } : {}),
    });
    if ("sessionError" in data) return failSessionResolution(data.sessionError);
    return { ok: true, data, exitCode: 0 };
  },
};
