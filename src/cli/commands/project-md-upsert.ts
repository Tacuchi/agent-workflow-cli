import { runProjectMdRead } from "../../application/project-md-service.js";
import {
  type ProjectMdUpsertInput,
  type UpsertOp,
  runProjectMdUpsertWrite,
} from "../../application/project-md-upsert-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import { parseFuentesSpecs } from "../parsers/fuentes.js";
import { parseWorkingBranches } from "../parsers/working-branches.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const projectMdUpsertCommand: QtcCommand = {
  name: "project-md-upsert",
  describe: "Read or update the <NS>-PROJECT block in CLAUDE.md/AGENTS.md.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const verbose = args.flags.has("--verbose");
    if (args.flags.has("--read")) {
      const data = await runProjectMdRead(ctx.fs, ctx.env, ctx.paths, { verbose });
      return { ok: true, data, exitCode: 0 };
    }

    const opAndFolder = pickOperation(args);
    if (!opAndFolder) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message:
            "Especifica una operación: --init | --add-session | --remove-session | --update-phase | --read",
        },
        exitCode: 1,
      };
    }

    const inputResult = buildUpsertInput(args, opAndFolder, verbose);
    if ("error" in inputResult) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: inputResult.error },
        exitCode: 1,
      };
    }

    const data = await runProjectMdUpsertWrite(ctx.fs, ctx.env, ctx.paths, inputResult.input);
    if ("error" in data) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: data.error },
        data,
        exitCode: 1,
      };
    }
    return { ok: data.ok, data, exitCode: data.ok ? 0 : 1 };
  },
};

function buildUpsertInput(
  args: ParsedArgs,
  opAndFolder: { op: UpsertOp; folder?: string },
  verbose: boolean,
): { input: ProjectMdUpsertInput } | { error: string } {
  const input: ProjectMdUpsertInput = { op: opAndFolder.op, verbose };
  if (opAndFolder.folder !== undefined) input.sessionFolder = opAndFolder.folder;

  const phase = args.values.get("phase");
  if (phase !== undefined) input.phase = phase;

  const branchesRaw = args.values.get("branches");
  if (branchesRaw !== undefined) {
    input.branches = branchesRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  const proyecto = args.values.get("proyecto");
  if (proyecto !== undefined) input.proyecto = proyecto;

  const mode = args.values.get("mode");
  if (mode === "hub" || mode === "project") input.mode = mode;

  const workingBranches = parseWorkingBranches(args.valuesMulti.get("working-branch") ?? []);
  if (workingBranches !== undefined) input.workingBranches = workingBranches;

  const fuentesParsed = parseFuentesSpecs(args.valuesMulti.get("fuente") ?? []);
  if ("error" in fuentesParsed) return { error: fuentesParsed.error };
  if (fuentesParsed.fuentes.length > 0) input.fuentes = fuentesParsed.fuentes;

  const mainBranch = args.values.get("main-branch");
  if (mainBranch !== undefined && mainBranch.length > 0) input.mainBranch = mainBranch;

  return { input };
}

function pickOperation(args: ParsedArgs): { op: UpsertOp; folder?: string } | null {
  if (args.flags.has("--init")) return { op: "init" };
  for (const op of ["add-session", "remove-session", "update-phase"] as const) {
    const folder = args.values.get(op);
    if (folder !== undefined) return { op, folder };
  }
  return null;
}
