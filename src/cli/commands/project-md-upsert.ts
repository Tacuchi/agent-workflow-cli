import { runProjectMdRead } from "../../application/project-md-service.js";
import {
  type ProjectMdUpsertInput,
  runProjectMdUpsertWrite,
} from "../../application/project-md-upsert-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import { parseFuentesSpecs } from "../parsers/fuentes.js";
import { parseWorkingBranches } from "../parsers/working-branches.js";
import type { QtcCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const projectMdUpsertCommand: QtcCommand = {
  name: "project-md-upsert",
  describe:
    "Read or update the <NS>-PROJECT block in CLAUDE.md/AGENTS.md. " +
    "Usage: aw project-md-upsert [--read] [--init] [--proyecto <name>] " +
    "[--fuente <alias:path[:rama]> ...] [--working-branch <alias:rama> ...] " +
    "[--main-branch <rama>] [--verbose].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const verbose = args.flags.has("--verbose");
    if (args.flags.has("--read")) {
      const data = await runProjectMdRead(ctx.fs, ctx.env, ctx.paths, { verbose });
      return { ok: true, data, exitCode: 0 };
    }

    if (!args.flags.has("--init")) {
      return fail("INVALID_INPUT", "Especifica una operación: --init | --read");
    }

    const inputResult = buildUpsertInput(args, verbose);
    if ("error" in inputResult) {
      return fail("INVALID_INPUT", inputResult.error);
    }

    const data = await runProjectMdUpsertWrite(ctx.fs, ctx.env, ctx.paths, inputResult.input);
    if ("error" in data) {
      return fail("INVALID_INPUT", data.error, data);
    }
    return { ok: data.ok, data, exitCode: data.ok ? 0 : 1 };
  },
};

function buildUpsertInput(
  args: ParsedArgs,
  verbose: boolean,
): { input: ProjectMdUpsertInput } | { error: string } {
  const input: ProjectMdUpsertInput = { op: "init", verbose };

  const proyecto = args.values.get("proyecto");
  if (proyecto !== undefined) input.proyecto = proyecto;

  const workingBranches = parseWorkingBranches(args.valuesMulti.get("working-branch") ?? []);
  if (workingBranches !== undefined) input.workingBranches = workingBranches;

  const fuentesParsed = parseFuentesSpecs(args.valuesMulti.get("fuente") ?? []);
  if ("error" in fuentesParsed) return { error: fuentesParsed.error };
  if (fuentesParsed.fuentes.length > 0) input.fuentes = fuentesParsed.fuentes;

  const mainBranch = args.values.get("main-branch");
  if (mainBranch !== undefined && mainBranch.length > 0) input.mainBranch = mainBranch;

  return { input };
}
