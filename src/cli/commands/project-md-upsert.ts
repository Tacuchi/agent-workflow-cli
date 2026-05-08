import { runProjectMdRead } from "../../application/project-md-service.js";
import {
  type ProjectMdUpsertInput,
  type UpsertOp,
  runProjectMdUpsertWrite,
} from "../../application/project-md-upsert-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const projectMdUpsertCommand: QtcCommand = {
  name: "project-md-upsert",
  describe: "Read or update the QTC-PROJECT block in CLAUDE.md/AGENTS.md.",
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

function parseWorkingBranches(specs: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const raw of specs) {
    const idx = raw.indexOf(":");
    if (idx <= 0) continue;
    const alias = raw.slice(0, idx).trim();
    const branch = raw.slice(idx + 1).trim();
    if (alias && branch) out[alias] = branch;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

interface FuenteSpec {
  alias: string;
  path: string;
  mainBranch?: string;
}

function parseFuentesSpecs(specs: string[]): { fuentes: FuenteSpec[] } | { error: string } {
  const out: FuenteSpec[] = [];
  for (const raw of specs) {
    const trimmed = raw.trim();
    const firstColon = trimmed.indexOf(":");
    if (firstColon <= 0) {
      return {
        error: `--fuente formato inválido '${raw}': se esperaba 'alias:path[:rama-principal]'`,
      };
    }
    const alias = trimmed.slice(0, firstColon).trim();
    const rest = trimmed.slice(firstColon + 1);
    const lastColon = rest.lastIndexOf(":");
    let path: string;
    let rama: string | undefined;
    if (lastColon < 0) {
      path = rest.trim();
    } else {
      path = rest.slice(0, lastColon).trim();
      const ramaCandidate = rest.slice(lastColon + 1).trim();
      if (ramaCandidate.length > 0) rama = ramaCandidate;
    }
    if (!alias || !path) {
      return {
        error: `--fuente formato inválido '${raw}': alias y path son obligatorios`,
      };
    }
    const entry: FuenteSpec = { alias, path };
    if (rama !== undefined) entry.mainBranch = rama;
    out.push(entry);
  }
  return { fuentes: out };
}
