import {
  type PipelineItem,
  type StatusOutput,
  runStatusCommand,
} from "../../application/status-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { HumanRenderContext, QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const statusCommand: QtcCommand<StatusOutput> = {
  name: "status",
  describe:
    "Read-only workspace dashboard: specs, plans, sessions y descartados con fechas relativas en español. " +
    "Usage: aw status [--format human|json] [--detail].",

  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult<StatusOutput>> {
    const data = await runStatusCommand(ctx.fs, ctx.env, ctx.paths);
    return { ok: true, data, exitCode: 0 };
  },

  /**
   * The human view shows PENDING work only. Finished history, sessions and
   * discarded items are real and stay in the JSON model — they just stop
   * competing for attention with what is actually left to do. `--detail`
   * brings them back; the filter never removes anything from the domain.
   */
  renderHuman(result: CommandResult<StatusOutput>, context: HumanRenderContext): string {
    const data = result.data;
    if (data === undefined) return "";

    const lines = [`${data.workspace.name} · ${data.workspace.path}`, ""];
    if (data.pipeline.length === 0) {
      lines.push("Sin pipeline pendiente.");
    } else {
      lines.push(...renderPipeline(data.pipeline));
    }
    if (context.detail) lines.push("", ...renderDetail(data));
    return `${lines.join("\n").trimEnd()}\n`;
  },
};

const GROUP_TITLES: Record<PipelineItem["kind"], string> = {
  "spec-unrefined": "Specs sin refinar",
  "spec-unplanned": "Specs sin plan",
  "plan-open": "Planes abiertos",
  "checkpoint-orphan": "Checkpoints sueltos",
};

function renderPipeline(pipeline: PipelineItem[]): string[] {
  const lines: string[] = [];
  for (const kind of Object.keys(GROUP_TITLES) as Array<PipelineItem["kind"]>) {
    const items = pipeline.filter((item) => item.kind === kind);
    if (items.length === 0) continue;
    lines.push(`${GROUP_TITLES[kind]} (${items.length})`);
    for (const item of items) {
      lines.push(`  ${item.summary}`);
      lines.push(`    ${item.command}`);
    }
    lines.push("");
  }
  return lines;
}

function renderDetail(data: StatusOutput): string[] {
  const done = data.plans.filter((p) => p.plan_state === "done");
  const lines = [
    `Terminado: ${done.length} plan(es) done de ${data.plans.length}`,
    `Sesiones: ${data.counts.sessions_active} activa(s), ${data.counts.sessions_closed} cerrada(s)`,
  ];
  for (const session of data.sessions.active) {
    lines.push(`  · ${session.folder} — ${session.summary} (${session.relative})`);
  }
  if (data.discarded.length > 0) {
    lines.push(`Descartados: ${data.discarded.length}`);
    for (const item of data.discarded) {
      lines.push(`  · [${item.kind}] ${item.text} — ${item.source}`);
    }
  }
  const unproven = data.plans.filter((p) => p.spec.status !== "resolved");
  if (unproven.length > 0) {
    lines.push(`Planes sin spec demostrada: ${unproven.map((p) => p.number).join(", ")}`);
  }
  return lines;
}
