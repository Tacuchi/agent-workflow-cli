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
  flags: {
    known: [
      "workspace",
      "proyecto",
      "source",
      "fuente",
      "main-branch",
      "working-branch",
      "qa-branch",
      "dry-run",
      "untrack",
    ],
    repeatable: ["source", "fuente", "working-branch", "qa-branch"],
  },
  help: {
    purpose:
      "Materialize the minimal Workline runtime in a directory, or configure its sources when --source is given.",
    flags: {
      workspace: { value: "<dir>", effect: "Directory to initialize instead of the resolved one." },
      proyecto: { value: "<name>", effect: "Project name recorded in the WORKSPACE block." },
      source: {
        value: "<alias:path[:branch]>",
        effect: "Declare a source with its path and optional main branch.",
      },
      fuente: {
        value: "<alias:path[:branch]>",
        effect: "Alias of --source, kept for compatibility.",
      },
      "main-branch": { value: "<branch>", effect: "Default main branch for the declared sources." },
      "working-branch": {
        value: "<alias:branch>",
        effect: "Working branch of one source, recorded in the Status block.",
      },
      "qa-branch": { value: "<alias:branch>", effect: "QA branch of one source." },
      "dry-run": { effect: "Preview every effect without writing." },
      untrack: { effect: "Remove the runtime paths Git still tracks from its index." },
    },
    output:
      "{ok, dry_run, workspace, sources, source_actions[]? {alias, action, error?}, scaffold, materialization, untrack?, skills_toml (created|exists|skipped), project_md, attach_multiroot, detached_removed?}.",
    notes: [
      "Without sources it creates only the sessions marker and, in a Git repository, the runtime ignore block. With sources it reconciles the WORKSPACE block, the branches and the multi-root visibility; re-running is idempotent.",
      "A partial failure returns ok:false with error code WORKSPACE_INIT_FAILED and the full data.",
    ],
  },
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

    const data = await runWorkspaceInit(
      ctx.rawFs ?? ctx.fs,
      ctx.env,
      ctx.paths,
      {
        sources,
        ...(proyecto !== undefined ? { proyecto } : {}),
        ...(mainBranch !== undefined ? { mainBranch } : {}),
        ...(workspace !== undefined ? { workspace } : {}),
        ...(workingBranches !== undefined ? { workingBranches } : {}),
        ...(qaBranches !== undefined ? { qaBranches } : {}),
        dryRun: args.flags.has("--dry-run"),
        untrack: args.flags.has("--untrack"),
      },
      ctx.process,
    );

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
              message: workspaceInitFailureMessage(data),
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
    if (data.untrack?.paths.length) {
      lines.push(`  Índice Git ${data.untrack.applied ? "desindexado" : "por desindexar"}:`);
      for (const path of data.untrack.paths) lines.push(`    ${path}`);
    }
    if (context.detail) {
      lines.push(`  Runtime    ${JSON.stringify(data.materialization.effects)}`);
      lines.push(`  Scaffold   ${JSON.stringify(data.scaffold)}`);
      lines.push(`  Multiroot  ${JSON.stringify(data.attach_multiroot)}`);
    }
    // Unconditional, and never behind `--detail`: a line the rewrite could not
    // carry is the one thing here a person has to know, and declaring it only in
    // a JSON field this projection replaces is not declaring it at all.
    const projectMd = data.project_md;
    appendProjectFiles(lines, projectMd);
    for (const source of data.source_actions ?? [])
      lines.push(
        `  fuente ${source.alias}: ${source.error ? "revertida" : source.action}${source.error ? ` · error: ${source.error}` : ""}`,
      );
    appendProjectMigration(lines, projectMd);
    return `${lines.join("\n")}\n`;
  },
};

function workspaceInitFailureMessage(data: WorkspaceInitResult): string {
  const lines = ["workspace-init no completó exitosamente"];
  if ("results" in data.project_md) {
    for (const file of data.project_md.results ?? []) {
      lines.push(
        `${file.file}: ${file.error ? `revertido (${file.error})` : (file.action ?? "sin cambio")} · ${file.path}`,
      );
    }
  } else if ("error" in data.project_md) {
    lines.push(`bloque: ${data.project_md.error}`);
  }
  for (const source of data.source_actions ?? []) {
    lines.push(`fuente ${source.alias}: ${source.error ?? source.action}`);
  }
  if ("error" in data.attach_multiroot) lines.push(`multiroot: ${data.attach_multiroot.error}`);
  return lines.join("\n");
}

function toWorkspaceSource(spec: FuenteSpec): WorkspaceSource {
  return {
    alias: spec.alias,
    path: spec.path,
    ...(spec.mainBranch !== undefined ? { mainBranch: spec.mainBranch } : {}),
  };
}

function appendProjectFiles(lines: string[], projectMd: WorkspaceInitResult["project_md"]): void {
  if ("results" in projectMd) {
    for (const file of projectMd.results ?? []) {
      lines.push(
        `  ${file.file} ${file.action ?? "revertido"} · ${file.path}${file.error ? ` · error: ${file.error}` : ""}`,
      );
    }
  }
}

function appendProjectMigration(
  lines: string[],
  projectMd: WorkspaceInitResult["project_md"],
): void {
  if ("migrated" in projectMd) {
    for (const alias of projectMd.migrated ?? []) lines.push(`  fuente ${alias}: ruta migrada`);
    for (const alias of projectMd.not_migrated ?? [])
      lines.push(`  fuente ${alias}: ruta no migrada (no existe en este host)`);
  }
  const dropped =
    projectMd !== undefined && "dropped_lines" in projectMd ? (projectMd.dropped_lines ?? []) : [];
  if (dropped.length > 0) {
    lines.push(
      `  Se retiraron ${dropped.length} línea(s) del bloque que ya no corresponden a ninguna fuente declarada:`,
    );
    for (const line of dropped) lines.push(`    ${line.trim()}`);
  }
}
