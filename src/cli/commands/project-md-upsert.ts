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

    const input: ProjectMdUpsertInput = {
      op: opAndFolder.op,
      verbose,
    };
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
    const workingBranch = args.values.get("working-branch");
    if (workingBranch?.includes(":") === true) {
      const idx = workingBranch.indexOf(":");
      const alias = workingBranch.slice(0, idx).trim();
      const branch = workingBranch.slice(idx + 1).trim();
      if (alias && branch) input.workingBranches = { [alias]: branch };
    }

    const data = await runProjectMdUpsertWrite(ctx.fs, ctx.env, ctx.paths, input);
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

function pickOperation(args: ParsedArgs): { op: UpsertOp; folder?: string } | null {
  if (args.flags.has("--init")) return { op: "init" };
  for (const op of ["add-session", "remove-session", "update-phase"] as const) {
    const folder = args.values.get(op);
    if (folder !== undefined) return { op, folder };
  }
  return null;
}
