import { readWorkspaceBlock } from "../../application/parsers/project-block.js";
import { runProjectMdUpsertWrite } from "../../application/project-md-upsert-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

const usage = "aw set-pipeline <alias> <build|test> <comando|ninguno>";

export const setPipelineCommand: CliCommand = {
  name: "set-pipeline",
  flags: { known: [] },
  help: {
    purpose: "Declare the versioned build or test command of one declared source.",
    args: "<alias> <build|test> <command|ninguno>",
    output:
      "{ok, action, results[] {file, path, action?, error?}, working_branches?, qa_branches?, dropped_lines[]?, migrated[]?, not_migrated[]?}.",
    notes: ["The value ninguno declares that the source has no such command."],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const [alias, field, command] = args.rest;
    if (
      !alias ||
      !/^[^:\s`]+$/.test(alias) ||
      (field !== "build" && field !== "test") ||
      !command?.trim() ||
      args.rest.length !== 3 ||
      /[\r\n`]/.test(command)
    ) {
      return fail("INVALID_INPUT", `Uso: ${usage}`);
    }
    const block = await readWorkspaceBlock(
      ctx.fs,
      ctx.paths.workspaceDir(),
      ctx.paths.blockMarkers(),
    );
    if (!block?.fuentes.some((source) => source.alias === alias)) {
      return fail("SOURCE_UNKNOWN", `${alias} no es una fuente declarada`, {
        aliases: block?.fuentes.map((source) => source.alias) ?? [],
      });
    }
    const result = await runProjectMdUpsertWrite(ctx.fs, ctx.env, ctx.paths, {
      op: "init",
      pipeline: { [alias]: { [field]: command.trim() } },
      verbose: true,
    });
    if ("error" in result) return fail("INVALID_INPUT", result.error);
    return { ok: result.ok, data: result, exitCode: result.ok ? 0 : 1 };
  },
};
