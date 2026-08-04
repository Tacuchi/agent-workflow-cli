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
    // A broken design reference is PENDING work, not history: it stays in the
    // default view for the same reason an open plan does. Valid references and
    // orphaned packages are inventory and wait for `--detail`.
    lines.push(...renderDesignAlerts(data, lines.at(-1)));
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

/**
 * Only what needs a hand: a reference that moved, and one that no longer
 * resolves. `before` keeps the block one blank line away from whatever came
 * before it, without stacking a second one when the pipeline already ended blank.
 */
function renderDesignAlerts(data: StatusOutput, before: string | undefined): string[] {
  const broken = data.designs.references.filter((r) => r.state !== "valid");
  if (broken.length === 0) return [];
  const lines = before === "" ? [] : [""];
  lines.push(`Diseño con referencias a reparar (${broken.length})`);
  for (const reference of broken) {
    lines.push(`  [${reference.state}] ${reference.from} → ${reference.baseline}`);
    if (reference.detail !== null) lines.push(`    ${reference.detail}`);
  }
  return lines;
}

function renderDesignGraph(data: StatusOutput): string[] {
  const graph = data.designs;
  if (graph.packages.length === 0 && graph.references.length === 0) return [];
  const { valid, stale, missing, orphaned } = graph.counts;
  const lines = [
    `Diseño: ${graph.packages.length} package(s) — ${valid} válida(s), ${stale} stale, ${missing} missing, ${orphaned} huérfano(s)`,
  ];
  for (const pkg of graph.packages) {
    const revision = pkg.current_revision === null ? "sin baseline" : `@r${pkg.current_revision}`;
    const broken = pkg.ok ? "" : " · manifest inválido";
    lines.push(
      `  · ${pkg.id ?? "(sin identidad)"} ${revision} ${pkg.path} [${pkg.state}]${broken}`,
    );
  }
  for (const reference of graph.references) {
    lines.push(`  · ${reference.from} → ${reference.baseline} [${reference.state}]`);
    // The roots ARE the graph's last hop: without them the chain stops at the
    // package and nobody can see which screens a plan actually pinned.
    for (const root of reference.roots) lines.push(`      ${root}`);
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
    // A run stopped at a boundary is what that session is actually waiting on,
    // and at an execution boundary the invocation is printed verbatim: whoever
    // resumes must never have to reconstruct the command from prose.
    if (session.flow !== null) lines.push(`      ${session.flow.summary}`);
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
  lines.push(...renderDesignGraph(data));
  return lines;
}
