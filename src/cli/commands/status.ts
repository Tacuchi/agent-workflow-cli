import {
  type PipelineItem,
  type StatusOutput,
  runStatusCommand,
} from "../../application/status-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import type { CliContext } from "../types.js";

export const statusCommand: CliCommand<StatusOutput> = {
  name: "status",
  describe:
    "Read-only workspace dashboard: specs, plans, sessions y descartados con fechas relativas en español. " +
    "Usage: aw status [--format human|json] [--detail].",

  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult<StatusOutput>> {
    const data = await runStatusCommand(ctx.fs, ctx.env, ctx.paths, { git: ctx.git });
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

    const header = `${data.workspace.name} · ${data.workspace.path}`;
    const lines = [header, ""];
    lines.push(...renderPipeline(data.pipeline));
    // A broken design reference is PENDING work, not history: it stays in the
    // default view for the same reason an open plan does. Valid references and
    // orphaned packages are inventory and wait for `--detail`.
    lines.push(...renderDesignAlerts(data, lines.at(-1)));
    lines.push(...renderLooseSessions(data, lines.at(-1)));
    // Nothing rendered, and the two reasons for that are not the same answer: a
    // folder nobody initialized has an empty pipeline because no workspace is
    // tracking it, and reporting peace there sends someone looking for work that
    // was never registered. One line either way, and no empty section under it.
    if (lines.length === 2) {
      return data.workspace.initialized
        ? `${header} — sin pendientes\n`
        : `${header} — sin workspace de Workline: creá uno con /w:workspace-init\n`;
    }
    // With something to show, the same fact is a notice: the documents are real
    // and worth listing, and they are still outside a workspace.
    if (!data.workspace.initialized) {
      lines.push(
        ...(lines.at(-1) === "" ? [] : [""]),
        "Aviso: este directorio no es un workspace de Workline — creá uno con /w:workspace-init",
      );
    }
    if (context.detail) lines.push("", ...renderDetail(data));
    return `${lines.join("\n").trimEnd()}\n`;
  },
};

const GROUP_TITLES: Record<PipelineItem["kind"], string> = {
  "spec-unrefined": "Specs sin refinar",
  "spec-unplanned": "Specs sin plan",
  "plan-open": "Planes abiertos",
  // Kept because the model keeps the class: a loose checkpoint is reported as a
  // notice now, so nothing reaches this row — and the day something does, it is
  // titled rather than rendered as a blank group.
  "checkpoint-orphan": "Checkpoints sueltos",
};

/** `plan` · `spec` · `sesión` — how an item names itself when its detail leads. */
const KIND_NOUNS: Record<PipelineItem["kind"], string> = {
  "spec-unrefined": "spec",
  "spec-unplanned": "spec",
  "plan-open": "plan",
  "checkpoint-orphan": "sesión",
};

/**
 * Each pending item over three lines: what it is, what it still owes, and the
 * command that continues it.
 *
 * The middle line is the whole point — a board that listed only the title and the
 * command could say `plan 031 — 100%, fases 6/6` about a plan whose final
 * validation had never run. When what it owes is an OBLIGATION that leaves it
 * neither runnable nor closable, that obligation takes the headline and the
 * percentage drops below it: read in the other order, the number is the part
 * people believe.
 */
function renderPipeline(pipeline: PipelineItem[]): string[] {
  const lines: string[] = [];
  for (const kind of Object.keys(GROUP_TITLES) as Array<PipelineItem["kind"]>) {
    const items = pipeline.filter((item) => item.kind === kind);
    if (items.length === 0) continue;
    lines.push(`${GROUP_TITLES[kind]} (${items.length})`);
    for (const item of items) {
      const { next, progress, obligation } = item.detail;
      lines.push(
        obligation ? `  ${KIND_NOUNS[item.kind]} ${item.number} — ${next}` : `  ${item.summary}`,
      );
      lines.push(`    ${obligation ? progress : next}`);
      lines.push(`    ${item.command}`);
    }
    lines.push("");
  }
  return lines;
}

/**
 * Loose sessions, as a notice with its count and how to look.
 *
 * The folders stay out of the default view on purpose: what a person needs here
 * is to know the work exists and that nothing on this board accounts for it.
 * Retiring one is another job, and this read does not do it.
 */
function renderLooseSessions(data: StatusOutput, before: string | undefined): string[] {
  const count = data.loose_sessions.length;
  if (count === 0) return [];
  const lines = before === "" ? [] : [""];
  lines.push(
    `Aviso: ${count} sesión(es) con trabajo y sin documento asociado — vela con 'aw status --detail'`,
  );
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
