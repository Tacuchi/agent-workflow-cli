import { type ContextPlanOutput, runContextPlan } from "../../application/context/plan-service.js";
import type { CommandResult } from "../../domain/types.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const contextPlanCommand: CliCommand<ContextPlanOutput> = {
  name: "context-plan",
  describe:
    "Devuelve el read-set ordenado de un comando —qué documentos leer, en qué orden y a qué costo— más el recibo de lo cargado. " +
    "Usage: aw context-plan --command <cmd> [--signal <s>]… [--root <bundle>] [--format human|json] [--detail].",

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<ContextPlanOutput>> {
    const command = flagValue(args, "command") ?? args.rest[0] ?? "";
    const input: Parameters<typeof runContextPlan>[1] = {
      command,
      signals: args.valuesMulti.get("signal") ?? [],
      capabilities: args.valuesMulti.get("capability") ?? [],
    };
    const root = args.values.get("root");
    if (root !== undefined) input.root = root;
    try {
      return { ok: true, data: await runContextPlan(ctx.fs, input), exitCode: 0 };
    } catch (err) {
      const code = (err as { code?: string }).code ?? "CONTEXT_PLAN_FAILED";
      return fail(code, (err as Error).message);
    }
  },

  /**
   * The human view IS the instruction: the absolute paths to read, in order.
   * The receipt is the on-demand diagnostic behind `--detail`; the JSON model
   * always carries both, so the two projections cannot disagree.
   */
  renderHuman(result: CommandResult<ContextPlanOutput>, context: HumanRenderContext): string {
    const data = result.data;
    if (data === undefined) return "";

    const signals = data.signals.length > 0 ? data.signals.join(", ") : "ninguna";
    const lines = [
      `${data.command} · perfil ${data.profile} · señales: ${signals} · ${data.bytes} B`,
      "",
      "Leé exactamente estos archivos, en este orden:",
    ];
    for (const entry of data.read_set) {
      const why = entry.signal === null ? "núcleo" : `módulo · señal ${entry.signal}`;
      const state = entry.missing ? "AUSENTE" : `${entry.bytes} B`;
      lines.push(`  ${entry.absolute}  (${why}, ${state})`);
    }
    if (data.notice !== null) lines.push("", data.notice);
    if (data.available_signals.length > 0) {
      lines.push("", "Señales que este comando acepta (pasá las que apliquen al caso):");
      for (const entry of data.available_signals) {
        lines.push(`  --signal ${entry.signal.padEnd(15)} ${entry.means}`);
      }
    }
    if (context.detail) lines.push("", ...renderReceipt(data));
    return `${lines.join("\n").trimEnd()}\n`;
  },
};

function renderReceipt(data: ContextPlanOutput): string[] {
  const receipt = data.receipt;
  return [
    "Recibo:",
    `  recorrido        ${receipt.command}`,
    `  perfil           ${receipt.profile}`,
    `  señales          ${receipt.signals.length > 0 ? receipt.signals.join(", ") : "ninguna"}`,
    `  cargado          ${receipt.loaded.length} documento(s): ${receipt.loaded.join(", ")}`,
    `  saltos de ref.   ${receipt.reference_hops}`,
    `  bytes            ${receipt.bytes}`,
    `  tokens           no disponible — ${receipt.tokens.reason}`,
    `  fallback         ${receipt.fallback.used ? receipt.fallback.reasons.join("; ") : "no"}`,
    `  bundle           ${receipt.root} (${receipt.root_origin})`,
    `  telemetría       ${receipt.telemetry}`,
  ];
}
