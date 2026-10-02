import {
  type HubInitResult,
  type HubSource,
  runHubInit,
} from "../../application/hub-init-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import { type FuenteSpec, parseFuentesSpecs } from "../parsers/fuentes.js";
import { parseWorkingBranches } from "../parsers/working-branches.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const hubInitCommand: CliCommand<HubInitResult> = {
  name: "hub-init",
  flags: {
    known: [
      "hub",
      "nombre",
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
      "Materialize the minimal Workline runtime in a hub, or configure its sources when --source is given.",
    flags: {
      hub: { value: "<dir>", effect: "Hub directory to initialize instead of the resolved one." },
      nombre: { value: "<name>", effect: "Hub name recorded in the hub block." },
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
      "{ok, dry_run, hub, sources, source_actions[]? {alias, action, error?}, scaffold, materialization, untrack?, skills_toml (created|exists|skipped), hub_block_files, attach_multiroot, detached_removed?, registry_warning?}.",
    notes: [
      "Except with --dry-run, it registers the hub in ~/.<ns>/hubs.json; registry_warning says why when that write fails.",
      "Without sources it creates only the sessions marker and, in a Git repository, the runtime ignore block. With sources it reconciles the hub block, the branches and the multi-root visibility; re-running is idempotent.",
      "A partial failure returns ok:false with error code HUB_INIT_FAILED and the full data.",
    ],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<HubInitResult>> {
    // Canonical flag is --source; --fuente kept as a back-compat alias.
    const sourcesRaw = [
      ...(args.valuesMulti.get("source") ?? []),
      ...(args.valuesMulti.get("fuente") ?? []),
    ];
    // No --source is the materialization-only form. Metadata options still
    // require sources so a partial configuration cannot invent a hub block.
    const parsed = parseFuentesSpecs(sourcesRaw);
    if ("error" in parsed) return fail<HubInitResult>("INVALID_INPUT", parsed.error);
    const sources = parsed.fuentes.map(toHubSource);

    const proyecto = args.values.get("nombre");
    const mainBranch = args.values.get("main-branch");
    const hub = args.values.get("hub");
    const workingBranches = parseWorkingBranches(args.valuesMulti.get("working-branch") ?? []);
    const qaBranches = parseWorkingBranches(args.valuesMulti.get("qa-branch") ?? []);

    const data = await runHubInit(
      ctx.rawFs ?? ctx.fs,
      ctx.env,
      ctx.paths,
      {
        sources,
        ...(proyecto !== undefined ? { proyecto } : {}),
        ...(mainBranch !== undefined ? { mainBranch } : {}),
        ...(hub !== undefined ? { hub } : {}),
        ...(workingBranches !== undefined ? { workingBranches } : {}),
        ...(qaBranches !== undefined ? { qaBranches } : {}),
        dryRun: args.flags.has("--dry-run"),
        untrack: args.flags.has("--untrack"),
      },
      ctx.process,
    );

    if ("error" in data) {
      return fail<HubInitResult>("INVALID_INPUT", data.hint ?? data.error);
    }

    return {
      ok: data.ok,
      data,
      ...(data.ok
        ? {}
        : {
            error: {
              code: "HUB_INIT_FAILED",
              message: hubInitFailureMessage(data),
            },
          }),
      exitCode: data.ok ? 0 : 1,
    };
  },
  /**
   * The deterministic result, read. `--dry-run` is what makes it a preview; the
   * projection never decides anything the service did not already decide.
   */
  renderHuman(result: CommandResult<HubInitResult>, context: HumanRenderContext): string {
    const data = result.data;
    if (data === undefined) return "";
    const lines = [
      `hub-init${data.dry_run ? " · dry-run (no escribe)" : ""} · ${data.hub}`,
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
    const hubBlock = data.hub_block_files;
    appendHubFiles(lines, hubBlock);
    for (const source of data.source_actions ?? [])
      lines.push(
        `  fuente ${source.alias}: ${source.error ? "revertida" : source.action}${source.error ? ` · error: ${source.error}` : ""}`,
      );
    appendHubMigration(lines, hubBlock);
    if (data.registry_warning !== undefined) lines.push(`  Registro   ${data.registry_warning}`);
    return `${lines.join("\n")}\n`;
  },
};

function hubInitFailureMessage(data: HubInitResult): string {
  const lines = ["hub-init no completó exitosamente"];
  if ("results" in data.hub_block_files) {
    for (const file of data.hub_block_files.results ?? []) {
      lines.push(
        `${file.file}: ${file.error ? `revertido (${file.error})` : (file.action ?? "sin cambio")} · ${file.path}`,
      );
    }
  } else if ("error" in data.hub_block_files) {
    lines.push(`bloque: ${data.hub_block_files.error}`);
  }
  for (const source of data.source_actions ?? []) {
    lines.push(`fuente ${source.alias}: ${source.error ?? source.action}`);
  }
  if ("error" in data.attach_multiroot) lines.push(`multiroot: ${data.attach_multiroot.error}`);
  return lines.join("\n");
}

function toHubSource(spec: FuenteSpec): HubSource {
  return {
    alias: spec.alias,
    path: spec.path,
    ...(spec.mainBranch !== undefined ? { mainBranch: spec.mainBranch } : {}),
  };
}

function appendHubFiles(lines: string[], hubBlock: HubInitResult["hub_block_files"]): void {
  if ("results" in hubBlock) {
    for (const file of hubBlock.results ?? []) {
      lines.push(
        `  ${file.file} ${file.action ?? "revertido"} · ${file.path}${file.error ? ` · error: ${file.error}` : ""}`,
      );
    }
  }
}

function appendHubMigration(lines: string[], hubBlock: HubInitResult["hub_block_files"]): void {
  if ("migrated" in hubBlock) {
    for (const alias of hubBlock.migrated ?? []) lines.push(`  fuente ${alias}: ruta migrada`);
    for (const alias of hubBlock.not_migrated ?? [])
      lines.push(`  fuente ${alias}: ruta no migrada (no existe en este host)`);
  }
  const dropped =
    hubBlock !== undefined && "dropped_lines" in hubBlock ? (hubBlock.dropped_lines ?? []) : [];
  if (dropped.length > 0) {
    lines.push(
      `  Se retiraron ${dropped.length} línea(s) del bloque que ya no corresponden a ninguna fuente declarada:`,
    );
    for (const line of dropped) lines.push(`    ${line.trim()}`);
  }
}
