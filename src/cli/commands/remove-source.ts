import { removeSource } from "../../application/source-remove-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const removeSourceCommand: QtcCommand = {
  name: "remove-source",
  describe:
    "Remove a source from the workspace: detach multi-root visibility, prune the WORKSPACE block (Fuentes + working/qa branches), stop its processes, and delete .workflow/launch/<alias>. Does NOT delete the repo. Usage: aw remove-source <alias>.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const alias = args.rest[0];
    if (!alias) {
      return fail("INVALID_INPUT", "Usage: aw remove-source <alias>");
    }

    const data = await removeSource(
      { fs: ctx.fs, env: ctx.env, proc: ctx.process, paths: ctx.paths },
      alias,
    );
    if ("error" in data) {
      return fail("INVALID_INPUT", data.error, data);
    }
    return { ok: true, data, exitCode: 0 };
  },
};
