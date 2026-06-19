import {
  type SessionCreateInput,
  runSessionCreate,
} from "../../application/session-create-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const sessionCreateCommand: QtcCommand = {
  name: "session-create",
  describe:
    "Create an internal session folder + SESSION.md. Flags: --type {research|refine|exec|quick} --name <folder> --objetivo <text> [--from <origin>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: SessionCreateInput = {};
    const type = args.values.get("type");
    if (type !== undefined) input.type = type;
    const name = args.values.get("name");
    if (name !== undefined) input.name = name;
    const objetivo = args.values.get("objetivo");
    if (objetivo !== undefined) input.objetivo = objetivo;
    const from = args.values.get("from");
    if (from !== undefined) input.originRaw = from;

    const data = await runSessionCreate(ctx.fs, ctx.env, ctx.paths, input);
    if ("error" in data) {
      return {
        ok: false,
        error: { code: data.code ?? "INVALID_INPUT", message: data.error },
        data,
        exitCode: 1,
      };
    }
    return { ok: true, data: data.sessionCreate, exitCode: 0 };
  },
};
