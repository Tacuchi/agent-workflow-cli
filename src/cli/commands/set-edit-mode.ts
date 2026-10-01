import { runProjectMdUpsertWrite } from "../../application/project-md-upsert-service.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";

export const setEditModeCommand: CliCommand = {
  name: "set-edit-mode",
  flags: { known: [] },
  help: {
    purpose: "Declare whether the hub edits sources in place or in isolation units.",
    args: "<in-place|unit>",
    output:
      "{ok, action, results[] {file, path, action?, error?}, working_branches?, qa_branches?, dropped_lines[]?, migrated[]?, not_migrated[]?}.",
  },
  async execute(args, ctx) {
    const mode = args.rest[0];
    if (args.rest.length !== 1 || (mode !== "in-place" && mode !== "unit"))
      return fail("INVALID_INPUT", "Usage: aw set-edit-mode in-place|unit");
    const result = await runProjectMdUpsertWrite(ctx.fs, ctx.env, ctx.paths, {
      op: "init",
      editMode: mode,
    });
    if ("error" in result) return fail("INVALID_INPUT", result.error);
    return { ok: result.ok, data: result, exitCode: result.ok ? 0 : 1 };
  },
};
