import { removeSource } from "../../application/source-remove-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const removeSourceCommand: CliCommand = {
  name: "remove-source",
  flags: { known: [] },
  help: {
    purpose:
      "Remove a source from the workspace: detach its multi-root visibility and prune it from the WORKSPACE block.",
    args: "<alias>",
    output: "{alias, path, materialization?}.",
    notes: ["It never deletes the repository nor alters its local artifacts."],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const alias = args.rest[0];
    if (!alias) {
      return fail("INVALID_INPUT", "Usage: aw remove-source <alias>");
    }

    const data = await removeSource({ fs: ctx.fs, env: ctx.env, paths: ctx.paths }, alias);
    if ("error" in data) {
      return fail("INVALID_INPUT", data.error, data);
    }
    return { ok: true, data, exitCode: 0 };
  },
};
