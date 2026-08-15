import "../../application/capability/design-handler.js";
import {
  type CapabilityReadinessReport,
  capabilityReadiness,
} from "../../application/capability/readiness.js";
import { isHarnessId, runHarness } from "../../application/dev-only-services.js";
import {
  checkInstalledBindings,
  resolveSkills,
} from "../../application/skills-resolver-service.js";
import type { ResolvedSkills } from "../../domain/skills.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import type { CliContext } from "../types.js";

interface SkillsData {
  skills: ResolvedSkills;
  sources: { global: boolean; workspace: boolean };
  bindingChecks: Awaited<ReturnType<typeof checkInstalledBindings>>["checks"];
  warnings: string[];
  /**
   * Readiness per capability.
   *
   * Always present in the structured form: `--detail` widens the HUMAN
   * projection and never changes the model, which is this repo's rule and the
   * reason `--detail --format json` is refused outright. What `AC-DSC-02` asks
   * for is satisfied by WHERE this lives: `aw skills` is the diagnostic surface,
   * and `aw status` keeps carrying only the documentary pipeline.
   */
  capabilities: CapabilityReadinessReport[];
}

export const skillsCommand: CliCommand<SkillsData> = {
  name: "skills",
  describe:
    "Show resolved capability→skill bindings (skills.toml cascade). Usage: aw skills [--detail] — " +
    "con --detail agrega readiness por capacidad, exposición y operación, la instancia exacta o el " +
    "floor, y la forma de invocación que el host soporta de verdad.",

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<SkillsData>> {
    const requested = args.values.get("host");
    if (requested !== undefined && !isHarnessId(requested)) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: `--host inválido: '${requested}'. Usá un host del catálogo.`,
        },
        exitCode: 1,
      };
    }
    const resolution = await resolveSkills(ctx.fs, ctx.paths);
    const validation = await checkInstalledBindings(ctx.fs, ctx.env, resolution);
    const data: SkillsData = {
      skills: resolution.skills,
      sources: resolution.sources,
      bindingChecks: validation.checks,
      warnings: [...resolution.warnings, ...validation.warnings],
      capabilities: await capabilityReadiness({
        fs: ctx.fs,
        env: ctx.env,
        paths: ctx.paths,
        host: runHarness((k) => ctx.env.get(k), requested).agent_host,
      }),
    };
    return { ok: true, data, exitCode: 0 };
  },

  /**
   * The human projection of the SAME data. Nothing is re-derived: every line
   * reads a field the structured form also carries, so the two cannot disagree.
   */
  renderHuman(result: CommandResult<SkillsData>, context: HumanRenderContext): string {
    const data = result.data;
    if (data === undefined) return "";
    const lines: string[] = [];
    for (const [role, resolved] of Object.entries(data.skills)) {
      const bound = resolved.enabled ? resolved.skill : "off";
      lines.push(`${role.padEnd(10)} ${String(bound).padEnd(14)} (${resolved.source})`);
    }
    for (const report of context.detail ? data.capabilities : []) {
      lines.push("", ...renderReport(report));
    }
    for (const warning of data.warnings) lines.push(`aviso: ${warning}`);
    return `${lines.join("\n")}\n`;
  },
};

function renderReport(report: CapabilityReadinessReport): string[] {
  const lines = [`${report.capability} v${report.contract_version} — ${report.state}`];
  if (report.reason !== null) lines.push(`  motivo: ${report.reason}`);
  if (report.action !== null) lines.push(`  siguiente: ${report.action}`);
  lines.push(
    `  invocación (${report.invocation.host}): ${report.invocation.form ?? "no disponible"} — ${report.invocation.note}`,
  );
  lines.push(
    report.floor.running
      ? `  ejecuta el floor incorporado (${report.floor.kind})`
      : `  instancia: ${report.instance?.name ?? "—"}@${report.instance?.digest ?? "—"}`,
  );
  for (const [route, verdict] of Object.entries(report.exposures)) {
    lines.push(
      `  ${route}: ${verdict.state}${verdict.reason === null ? "" : ` — ${verdict.reason}`}`,
    );
  }
  for (const op of report.operations) {
    lines.push(
      `  · ${op.operation.padEnd(9)} ${op.state.padEnd(13)} ${op.workspace} · efectos: ${op.effects.join(", ")}`,
    );
  }
  for (const improvement of report.improvements) {
    lines.push(
      `  mejora ${improvement.name}: ${improvement.eligible ? "elegible" : `descartada — ${improvement.why}`}`,
    );
  }
  return lines;
}
