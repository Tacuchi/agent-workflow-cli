import {
  type VisibilityDoctorResult,
  type VisibilityDriftStatus,
  type VisibilityHostReport,
  runVisibilityDoctor,
} from "../../application/visibility-doctor-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const visibilityCommand: CliCommand<VisibilityDoctorResult> = {
  name: "visibility",
  describe:
    "Inspector de visibilidad multi-root del hub. Subcomandos: doctor [--workspace dir] [--global] " +
    "[--format human|json] [--detail].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<VisibilityDoctorResult>> {
    const subcommand = args.rest[0];
    if (subcommand === "doctor") return runDoctorSub(args, ctx);
    return fail("INVALID_INPUT", "visibility requiere subcomando: doctor");
  },

  /**
   * The human projection of the SAME result the JSON carries: one line per host
   * with its verdict and the file(s) the verdict was read from, plus the paths
   * that are missing or left over. It re-derives nothing.
   */
  renderHuman(result: CommandResult<VisibilityDoctorResult>, context: HumanRenderContext): string {
    const data = result.data;
    if (data === undefined) return "";
    return renderDoctor(data, context.detail);
  },
};

async function runDoctorSub(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<VisibilityDoctorResult>> {
  const workspace = args.values.get("workspace");
  const data = await runVisibilityDoctor(ctx.fs, ctx.env, ctx.paths, {
    ...(workspace !== undefined ? { workspace } : {}),
    global: args.flags.has("--global"),
  });

  const totalReports = data.reports.length + data.global_reports.length;
  const okCount = data.summary.ok;
  if (okCount === totalReports) return { ok: true, data, exitCode: 0 };

  // Drift stays `ok:false` (exit 1 is the contract scripts already gate on), and
  // the host renders `ok:false` ONLY through the failure projection — so the
  // report travels in `action`, or `--format human` would print a bare count in
  // exactly the case the person needs the per-host diagnosis.
  return fail(
    "VISIBILITY_DRIFT",
    `${totalReports - okCount}/${totalReports} reports con drift (ver data.reports/global_reports)`,
    {
      ...data,
      // `--detail` is read HERE and not in the renderer because the failure
      // projection never reaches `renderHuman` — and detail is precisely what
      // the person asked for in the only case that prints this text.
      action: `revisá el drift host por host:\n\n${renderDoctor(data, args.flags.has("--detail"))}`,
    } as unknown as VisibilityDoctorResult,
  );
}

const STATUS_MARK: Record<VisibilityDriftStatus, string> = {
  ok: "✓",
  "missing-paths": "✗",
  "extra-paths": "✗",
  "no-settings": "✗",
  "no-project-block": "✗",
  "global-pollution": "✗",
};

/**
 * Statuses whose `detail` only restates the line it would sit under: `ok` is the
 * line itself, and missing/extra already print the paths one by one. Every other
 * status prints no list, so its `detail` is the only thing that explains it.
 */
const REDUNDANT_DETAIL: ReadonlySet<VisibilityDriftStatus> = new Set([
  "ok",
  "missing-paths",
  "extra-paths",
]);

const STATUS_WIDTH = Math.max(...Object.keys(STATUS_MARK).map((s) => s.length));

function renderDoctor(data: VisibilityDoctorResult, detail: boolean): string {
  const lines = [`Visibilidad multi-root · ${data.workspace_dir}`, ""];
  lines.push(...renderScope("workspace", data.reports, detail));
  if (data.global_reports.length > 0) {
    lines.push("", ...renderScope("global", data.global_reports, detail));
  }
  const total = data.reports.length + data.global_reports.length;
  lines.push("", `${data.summary.ok}/${total} host(s) sin drift`);
  lines.push(...renderFixes([...data.reports, ...data.global_reports]));
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderScope(title: string, reports: VisibilityHostReport[], detail: boolean): string[] {
  if (reports.length === 0) return [];
  const hostWidth = Math.max(...reports.map((r) => r.host.length));
  const lines = [title];
  for (const report of reports) {
    const head = `${report.host.padEnd(hostWidth)}  ${report.status.padEnd(STATUS_WIDTH)}`;
    // The file(s) the verdict was actually read from — never a hardcoded name.
    lines.push(`  ${STATUS_MARK[report.status]} ${head}  ${report.targets.join(" + ")}`);
    if (report.missing.length > 0) lines.push(`      faltan: ${report.missing.join(", ")}`);
    if (report.extra.length > 0) lines.push(`      sobran: ${report.extra.join(", ")}`);
    if (report.detail !== undefined && (detail || !REDUNDANT_DETAIL.has(report.status))) {
      lines.push(`      ${report.detail}`);
    }
    if (detail && report.declared_paths.length > 0) {
      lines.push(`      declarados: ${report.declared_paths.join(", ")}`);
      lines.push(`      registrados: ${report.registered_paths.join(", ") || "(ninguno)"}`);
    }
  }
  return lines;
}

/**
 * One command per kind of drift present — never advice for drift nobody has.
 *
 * The trigger is the LIST, not the status: `status` reports only the most severe
 * drift, so a host with paths missing AND left over would otherwise print
 * `sobran:` above and no command to remove them.
 */
function renderFixes(reports: VisibilityHostReport[]): string[] {
  const fixes: string[] = [];
  if (reports.some((r) => r.missing.length > 0)) {
    fixes.push("  aw attach-multiroot --from-sources          registra las fuentes que faltan");
  }
  // Global leftovers are the hub's own sources leaking into ~/: a different
  // command, and `--path` on the workspace scope would not touch them.
  if (reports.some((r) => r.scope === "workspace" && r.extra.length > 0)) {
    fixes.push("  aw detach-multiroot --path <dir>            quita las rutas que sobran");
  }
  if (reports.some((r) => r.status === "global-pollution")) {
    fixes.push("  aw detach-multiroot --global --from-sources limpia el scope global");
  }
  if (reports.some((r) => r.status === "no-project-block")) {
    fixes.push("  aw workspace-init --source <alias>:<path>   declara las fuentes del workspace");
  }
  return fixes.length === 0 ? [] : ["", "Para corregir:", ...fixes];
}
