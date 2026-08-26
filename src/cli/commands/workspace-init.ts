import {
  type WorkspaceInitResult,
  type WorkspaceSource,
  runWorkspaceInit,
} from "../../application/workspace-init-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import { type FuenteSpec, parseFuentesSpecs } from "../parsers/fuentes.js";
import { parseWorkingBranches } from "../parsers/working-branches.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const workspaceInitCommand: CliCommand<WorkspaceInitResult> = {
  name: "workspace-init",
  describe:
    "Materialize the minimal Workline runtime in the resolved directory, or configure sources when --source is supplied. Without sources it creates only the sessions marker and the Git runtime ignore block when applicable. With sources it reconciles the WORKSPACE block, branches and multi-root visibility. Usage: aw workspace-init [--source alias:path[:rama] (repeatable, 1+)] [--working-branch alias:rama] [--qa-branch alias:rama] [--proyecto <name>] [--main-branch <branch>] [--workspace <dir>] [--dry-run] [--format human|json] [--detail].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<WorkspaceInitResult>> {
    // Canonical flag is --source; --fuente kept as a back-compat alias.
    const sourcesRaw = [
      ...(args.valuesMulti.get("source") ?? []),
      ...(args.valuesMulti.get("fuente") ?? []),
    ];
    // No --source is the materialization-only form. Metadata options still
    // require sources so a partial configuration cannot invent a WORKSPACE block.
    const parsed = parseFuentesSpecs(sourcesRaw);
    if ("error" in parsed) return fail<WorkspaceInitResult>("INVALID_INPUT", parsed.error);
    const sources = parsed.fuentes.map(toWorkspaceSource);

    const proyecto = args.values.get("proyecto");
    const mainBranch = args.values.get("main-branch");
    const workspace = args.values.get("workspace");
    const workingBranches = parseWorkingBranches(args.valuesMulti.get("working-branch") ?? []);
    const qaBranches = parseWorkingBranches(args.valuesMulti.get("qa-branch") ?? []);

    const data = await runWorkspaceInit(ctx.rawFs ?? ctx.fs, ctx.env, ctx.paths, {
      sources,
      ...(proyecto !== undefined ? { proyecto } : {}),
      ...(mainBranch !== undefined ? { mainBranch } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      ...(workingBranches !== undefined ? { workingBranches } : {}),
      ...(qaBranches !== undefined ? { qaBranches } : {}),
      dryRun: args.flags.has("--dry-run"),
    });

    if ("error" in data) {
      return fail<WorkspaceInitResult>("INVALID_INPUT", data.hint ?? data.error);
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
  /**
   * The deterministic result, read. `--dry-run` is what makes it a preview; the
   * projection never decides anything the service did not already decide.
   */
  renderHuman(result: CommandResult<WorkspaceInitResult>, context: HumanRenderContext): string {
    const data = result.data;
    if (data === undefined) return "";
    const lines = [
      `workspace-init${data.dry_run ? " · dry-run (no escribe)" : ""} · ${data.workspace}`,
      `  Fuentes    ${data.sources}`,
      `  skills.toml ${data.skills_toml}`,
    ];
    if (context.detail) {
      lines.push(`  Runtime    ${JSON.stringify(data.materialization.effects)}`);
      lines.push(`  Scaffold   ${JSON.stringify(data.scaffold)}`);
      lines.push(`  Multiroot  ${JSON.stringify(data.attach_multiroot)}`);
    }
    // Unconditional, and never behind `--detail`: a line the rewrite could not
    // carry is the one thing here a person has to know, and declaring it only in
    // a JSON field this projection replaces is not declaring it at all.
    const projectMd = data.project_md;
    const dropped =
      projectMd !== undefined && "dropped_lines" in projectMd
        ? (projectMd.dropped_lines ?? [])
        : [];
    if (dropped.length > 0) {
      lines.push(
        `  Se retiraron ${dropped.length} línea(s) del bloque que ya no corresponden a ninguna fuente declarada:`,
      );
      for (const line of dropped) lines.push(`    ${line.trim()}`);
    }
    return `${lines.join("\n")}\n`;
  },
};

function toWorkspaceSource(spec: FuenteSpec): WorkspaceSource {
  return {
    alias: spec.alias,
    path: spec.path,
    ...(spec.mainBranch !== undefined ? { mainBranch: spec.mainBranch } : {}),
  };
}
