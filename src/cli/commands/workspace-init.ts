import {
  type WorkspaceSource,
  runWorkspaceInit,
} from "../../application/workspace-init-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import { type FuenteSpec, parseFuentesSpecs } from "../parsers/fuentes.js";
import { parseWorkingBranches } from "../parsers/working-branches.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const workspaceInitCommand: QtcCommand = {
  name: "workspace-init",
  describe:
    "Initialize the current directory as an agent-workflow workspace (unifies the legacy hub-init + project-init; no project/hub distinction). Minimal scaffold: .workflow/sessions + skills.toml + WORKSPACE block + CLI-owned .gitignore; docs/ folders are born on demand (aw next-number). With external sources it also configures multi-root visibility. Idempotent; re-running reconciles and prunes the legacy upfront scaffold. Flags: --source alias:path[:rama] (repeatable, 1+), [--working-branch alias:rama (repeatable)], [--qa-branch alias:rama (repeatable)], [--proyecto], [--main-branch], [--workspace], [--dry-run].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    // Canonical flag is --source; --fuente kept as a back-compat alias.
    const sourcesRaw = [
      ...(args.valuesMulti.get("source") ?? []),
      ...(args.valuesMulti.get("fuente") ?? []),
    ];
    // No --source is allowed: on an already-initialized workspace the service
    // reconciles, preserving existing sources + description (so paths are never
    // re-passed through the shell). A genuinely empty workspace still errors.
    const parsed = parseFuentesSpecs(sourcesRaw);
    if ("error" in parsed) return invalid(parsed.error);
    const sources = parsed.fuentes.map(toWorkspaceSource);

    const proyecto = args.values.get("proyecto");
    const mainBranch = args.values.get("main-branch");
    const workspace = args.values.get("workspace");
    const workingBranches = parseWorkingBranches(args.valuesMulti.get("working-branch") ?? []);
    const qaBranches = parseWorkingBranches(args.valuesMulti.get("qa-branch") ?? []);

    const data = await runWorkspaceInit(ctx.fs, ctx.env, ctx.paths, {
      sources,
      ...(proyecto !== undefined ? { proyecto } : {}),
      ...(mainBranch !== undefined ? { mainBranch } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      ...(workingBranches !== undefined ? { workingBranches } : {}),
      ...(qaBranches !== undefined ? { qaBranches } : {}),
      dryRun: args.flags.has("--dry-run"),
    });

    if ("error" in data) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: data.hint ?? data.error },
        data,
        exitCode: 1,
      };
    }

    return {
      ok: data.ok,
      data,
      ...(data.ok
        ? {}
        : {
            error: {
              code: "WORKSPACE_INIT_FAILED",
              message:
                "workspace-init no completó exitosamente; revisar data.project_md y data.attach_multiroot",
            },
          }),
      exitCode: data.ok ? 0 : 1,
    };
  },
};

function toWorkspaceSource(spec: FuenteSpec): WorkspaceSource {
  return {
    alias: spec.alias,
    path: spec.path,
    ...(spec.mainBranch !== undefined ? { mainBranch: spec.mainBranch } : {}),
  };
}

function invalid(message: string): CommandResult {
  return {
    ok: false,
    error: { code: "INVALID_INPUT", message },
    exitCode: 1,
  };
}
