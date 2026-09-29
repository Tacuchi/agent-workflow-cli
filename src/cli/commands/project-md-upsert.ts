import { runProjectMdRead } from "../../application/project-md-service.js";
import {
  type ProjectMdUpsertInput,
  runProjectMdUpsertWrite,
} from "../../application/project-md-upsert-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import { parseFuentesSpecs } from "../parsers/fuentes.js";
import { parseWorkingBranches } from "../parsers/working-branches.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const projectMdUpsertCommand: CliCommand = {
  name: "project-md-upsert",
  flags: {
    known: ["init", "read", "proyecto", "fuente", "main-branch", "working-branch", "verbose"],
    exclusive: [["read", "init"]],
    repeatable: ["fuente", "working-branch"],
  },
  help: {
    purpose: "Read or update the workspace block that CLAUDE.md and AGENTS.md carry.",
    flags: {
      init: { effect: "Write the block, merging the given values over the existing ones." },
      read: { effect: "Read the block without writing." },
      proyecto: {
        value: "<name>",
        effect: "Project description; a single line renames the workspace.",
      },
      fuente: { value: "<alias:path[:branch]>", effect: "Declare a source with --init." },
      "main-branch": { value: "<branch>", effect: "Main branch for sources that declare none." },
      "working-branch": { value: "<alias:branch>", effect: "Working branch of one source." },
      verbose: { effect: "Return the full detail." },
    },
    output:
      "With --read: {block, files[], cache_used?}. With --init: {ok, action, results[] {file, path, action?, error?}, working_branches?, qa_branches?, dropped_lines[]?, migrated[]?, not_migrated[]?}.",
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const verbose = args.flags.has("--verbose");
    if (args.flags.has("--read") === args.flags.has("--init")) {
      return fail("INVALID_INPUT", "Especifica exactamente uno de --read o --init");
    }
    if (args.flags.has("--read")) {
      const data = await runProjectMdRead(ctx.fs, ctx.env, ctx.paths, { verbose });
      return { ok: true, data, exitCode: 0 };
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
