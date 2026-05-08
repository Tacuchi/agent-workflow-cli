import { runGraduate } from "../../application/dev-graduate-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const graduateCommand: QtcCommand = {
  name: "graduate",
  describe:
    "Graduate session artifacts (decision/manual/script/especificacion/conclusion) to docs/.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: Parameters<typeof runGraduate>[3] = {};
    const kind = args.values.get("kind");
    if (kind !== undefined) input.kind = kind;
    const session = args.values.get("session");
    if (session !== undefined) input.session = session;
    const slug = args.values.get("slug");
    if (slug !== undefined) input.slug = slug;
    const source = args.values.get("source");
    if (source !== undefined) input.source = source;
    if (kind === "decision") {
      const id = args.values.get("id") ?? args.values.get("dec-id");
      if (id !== undefined) input.decId = id;
    }
    const data = await runGraduate(ctx.fs, ctx.env, ctx.paths, input);
    if ("error" in data) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: data.error },
        data,
        exitCode: 1,
      };
    }
    return { ok: true, data, exitCode: 0 };
  },
};
