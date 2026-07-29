import {
  type BudgetLine,
  type ContextBudgetOutput,
  runContextBudget,
} from "../../application/context/budget-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { HumanRenderContext, QtcCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const contextBudgetCommand: QtcCommand<ContextBudgetOutput> = {
  name: "context-budget",
  describe:
    "Mide el costo de contexto del bundle w en sus tres tramos (discovery, activación, ejecución) y lo compara contra un baseline congelado. " +
    "Usage: aw context-budget [--root <bundle>] [--baseline <archivo>] [--format human|json] [--detail].",

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<ContextBudgetOutput>> {
    const input: Parameters<typeof runContextBudget>[1] = {};
    const root = args.values.get("root");
    const baseline = args.values.get("baseline");
    if (root !== undefined) input.root = root;
    if (baseline !== undefined) input.baselinePath = baseline;
    try {
      const data = await runContextBudget(ctx.fs, input);
      return { ok: true, data, exitCode: 0 };
    } catch (err) {
      const code = (err as { code?: string }).code ?? "CONTEXT_BUDGET_FAILED";
      return fail(code, (err as Error).message);
    }
  },

  /**
   * The human view leads with the verdict and the lines that broke it — a
   * budget report whose offenders are buried under 25 green rows is read as
   * "fine". `--detail` brings the full table back.
   */
  renderHuman(result: CommandResult<ContextBudgetOutput>, context: HumanRenderContext): string {
    const data = result.data;
    if (data === undefined) return "";

    const lines = [
      `bundle ${data.root} (${data.root_origin}) · ${data.revision.file_count} archivos · digest ${data.revision.content_digest}`,
      "",
      `discovery        ${data.discovery.bytes} B`,
      `activación (med) ${data.activation.median} B sobre ${data.activation.entries.length} comandos`,
      `ejecución (med)  ${data.execution.median} B sobre ${data.execution.journeys.length} recorridos`,
      "",
      `tokens: no disponible — ${data.tokens.reason}`,
    ];

    if (data.baseline_path === null) {
      lines.push("", "Sin baseline: solo medición (pasá --baseline para evaluar el presupuesto).");
    } else if (data.offenders.length === 0) {
      lines.push("", `✓ dentro de presupuesto contra ${data.baseline_path}`);
    } else {
      lines.push("", `✗ fuera de presupuesto (${data.offenders.length}):`);
      for (const offender of data.offenders) lines.push(`  ${offender}`);
    }

    if (context.detail) lines.push("", ...renderDetail(data));
    return `${lines.join("\n").trimEnd()}\n`;
  },
};

function renderDetail(data: ContextBudgetOutput): string[] {
  return [
    "Presupuesto por métrica:",
    ...data.budget.map(renderBudgetLine),
    "",
    "Recorridos:",
    ...data.execution.journeys.flatMap(renderJourney),
  ];
}

function renderBudgetLine(entry: BudgetLine): string {
  const verdict = entry.ok === undefined ? "—" : entry.ok ? "✓" : "✗";
  const against =
    entry.target === undefined ? "" : ` / techo ${entry.target} B (baseline ${entry.baseline} B)`;
  return `  ${verdict} ${entry.metric}: ${entry.actual} B${against}`;
}

function renderJourney(journey: ContextBudgetOutput["execution"]["journeys"][number]): string[] {
  const degraded = journey.degraded ? " · DEGRADADO" : "";
  return [
    `  ${journey.id} (${journey.label}) — ${journey.bytes} B · ${journey.files.length} archivos${degraded}`,
    ...journey.files.map(
      (file) => `      ${file.missing ? "ausente" : `${file.bytes} B`}  ${file.path}`,
    ),
  ];
}
