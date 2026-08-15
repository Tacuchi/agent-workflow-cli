import {
  type GenerateLaunchResult,
  runGenerateLaunch,
} from "../../application/generate-launch-service.js";
import type { LaunchMode } from "../../application/source-launch-scripts-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const generateLaunchCommand: CliCommand<GenerateLaunchResult> = {
  name: "generate-launch",
  describe:
    "(Re)generate the per-source launch scripts (.workflow/launch/<alias>/: launch.json + run.sh + run.ps1) by detecting each source's stack. Idempotent: pristine files are regenerated, hand-edited ones preserved (--force overwrites them). Reads sources from the WORKSPACE block; the launch flow also generates these on demand at the first launch. Each source gets a launch MODE — interactive (owns the TTY, for TUIs) or server (background + log) — overridable with --mode; --command overrides the detected run command for a single source. " +
    "Usage: aw generate-launch [--source <alias> (repeatable)] [--mode interactive|server] [--command <cmd>] [--force] [--dry-run] [--workspace <dir>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<GenerateLaunchResult>> {
    const aliases = args.valuesMulti.get("source") ?? [];
    const workspace = args.values.get("workspace");
    const modeRaw = args.values.get("mode");
    if (modeRaw !== undefined && modeRaw !== "interactive" && modeRaw !== "server") {
      return fail("INVALID_INPUT", `--mode must be 'interactive' or 'server' (got '${modeRaw}')`);
    }
    const mode = modeRaw as LaunchMode | undefined;
    const command = args.values.get("command");
    const data = await runGenerateLaunch(ctx.fs, ctx.env, ctx.paths, {
      ...(aliases.length > 0 ? { aliases } : {}),
      force: args.flags.has("--force"),
      dryRun: args.flags.has("--dry-run"),
      ...(workspace !== undefined ? { workspace } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(command !== undefined ? { command } : {}),
    });
    if ("error" in data) {
      return fail<GenerateLaunchResult>("INVALID_INPUT", data.hint ?? data.error);
    }
    return { ok: data.ok, data, exitCode: data.ok ? 0 : 1 };
  },

  /**
   * The same deterministic result, read instead of parsed. Nothing is recomputed
   * here: a skill that renders this must not re-derive which sources changed.
   */
  renderHuman(result: CommandResult<GenerateLaunchResult>, context: HumanRenderContext): string {
    const data = result.data;
    if (data === undefined) return "";
    const lines = [
      `generate-launch${data.dry_run ? " · dry-run (no escribe)" : ""} · ${data.workspace}`,
    ];
    for (const source of data.sources) {
      lines.push(`  ${source.alias} — ${describeSource(source, context.detail)}`);
    }
    if (data.unknown_aliases?.length) {
      lines.push(`  Alias no declarados: ${data.unknown_aliases.join(", ")}`);
    }
    if (data.missing_sources?.length) {
      lines.push(`  Sin ruta en disco: ${data.missing_sources.join(", ")}`);
    }
    return `${lines.join("\n")}\n`;
  },
};

function describeSource(source: GenerateLaunchResult["sources"][number], detail: boolean): string {
  const head = source.launchable
    ? `${source.stack} · ${source.mode} · ${source.run ?? "sin comando"}`
    : `${source.stack} · no lanzable`;
  if (!detail) return head;
  const o = source.outcomes;
  return `${head} · launch.json: ${o.launchJson}, run.sh: ${o.runSh}, run.ps1: ${o.runPs1}`;
}
