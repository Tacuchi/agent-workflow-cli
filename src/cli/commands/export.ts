import {
  type ExportApplied,
  type ExportCategory,
  type ExportPrepared,
  type ExportSelection,
  type ExportValidation,
  applyExport,
  prepareExport,
  validateExport,
} from "../../application/export-service.js";
import type { CommandResult } from "../../domain/types.js";
import { readRequiredStdin } from "../context-id.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { HumanRenderContext, QtcCommand } from "../registry.js";
import { fail, failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

type ExportData =
  | { stage: "prepare"; prepared: ExportPrepared }
  | ({ stage: "validate" } & ExportValidation)
  | ({ stage: "apply" } & ExportApplied);

const DESCRIBES: Record<ExportCategory, string> = {
  diagrams: "Publica un dossier de diagramas (README + Markdown, DSL opcional) en docs/diagrams.",
  manuals:
    "Publica un dossier de manuales en docs/manuals; docs/manuals/INDEX.md es el único archivo sobrescribible y exige --overwrite.",
  reports: "Publica un informe acotado en docs/reports.",
  scripts:
    "Consolida el SQL pendiente en un bundle de docs/scripts (00-ROLLBACK.sql + forwards continuos + README). NUNCA ejecuta SQL.",
};

/**
 * The four exports are the same command with a different policy: same stages,
 * same validation, same authorization. Only the category changes, which is why
 * they are built here instead of copied four times.
 */
function exportCommand(category: ExportCategory): QtcCommand<ExportData> {
  return {
    name: `export-${category}`,
    describe: `${DESCRIBES[category]} Escribe SOLO en su carpeta y nunca crea una sesión. Usage: aw export-${category} prepare | validate | apply --approval <digest> [--overwrite] [--sessions <a,b>] [--since <YYYY-MM-DD>] [--source <alias>] [--date <YYYY-MM-DD>].`,

    async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<ExportData>> {
      const stage = args.rest[0];
      if (stage !== "prepare" && stage !== "validate" && stage !== "apply") {
        return fail(
          "ARGS_INVALID",
          `uso: aw export-${category} prepare | validate | apply --approval <digest>`,
        );
      }

      // Each stage rebuilds the request from the workspace: stateless, and the
      // corpus digest is what detects a session that moved meanwhile.
      const prepared = await prepareExport(ctx.fs, ctx.env, ctx.paths, category, selection(args));
      if (!prepared.ok) return failSemantic(prepared.failure);

      if (stage === "prepare") {
        return { ok: true, data: { stage: "prepare", prepared: prepared.value }, exitCode: 0 };
      }

      const raw = await readRequiredStdin();
      return stage === "validate"
        ? runValidate(raw, prepared.value)
        : await runApply(args, ctx, raw, prepared.value);
    },

    renderHuman(result: CommandResult<ExportData>, context: HumanRenderContext): string {
      const data = result.data;
      if (data === undefined) return "";
      if (data.stage === "prepare") {
        const request = data.prepared.request;
        const lines = [
          `export-${category} · prepare (${request.metrics.request_bytes} B)`,
          `  Destino    ${data.prepared.unit}`,
          `  Corpus     ${request.read_set.length} sesión(es)`,
          `  Digest     ${request.input_digest.slice(0, 12)}…`,
        ];
        if (context.detail) lines.push("", request.contract);
        return `${lines.join("\n")}\n`;
      }
      if (data.stage === "validate") {
        const lines = [
          `export-${category} · propuesta validada — falta tu aprobación`,
          `  Destino    ${data.preview.destination}`,
        ];
        for (const file of data.preview.files) lines.push(`    ${file.path} (${file.bytes} B)`);
        if (data.preview.overwrites !== null) {
          lines.push(`  REEMPLAZA  ${data.preview.overwrites} — exige --overwrite`);
        }
        lines.push(
          `  Aprobación aw export-${category} apply --approval ${data.approval_digest}`,
          "",
        );
        return lines.join("\n");
      }
      return `export-${category} · publicados ${data.written.length} archivo(s):\n${data.written.map((w) => `  ${w}`).join("\n")}\n`;
    },
  };
}

function runValidate(raw: string, prepared: ExportPrepared): CommandResult<ExportData> {
  const result = validateExport(raw, prepared);
  if (!result.ok) return failSemantic(result.failure);
  return { ok: true, data: { stage: "validate", ...result.value }, exitCode: 0 };
}

async function runApply(
  args: ParsedArgs,
  ctx: CliContext,
  raw: string,
  prepared: ExportPrepared,
): Promise<CommandResult<ExportData>> {
  const approval = args.values.get("approval");
  if (approval === undefined) {
    return fail("ARGS_INVALID", "apply exige --approval <digest>: el que devolvió validate");
  }
  const result = await applyExport(ctx.fs, ctx.env, ctx.paths, {
    raw,
    prepared,
    approval,
    // Replacing the category's overwritable file is never implicit.
    allowOverwrite: args.flags.has("--overwrite"),
  });
  if (!result.ok) return failSemantic(result.failure);
  return { ok: true, data: { stage: "apply", ...result.value }, exitCode: 0 };
}

function selection(args: ParsedArgs): ExportSelection {
  const sessions = args.values.get("sessions");
  const since = args.values.get("since");
  // `source` is a MULTI_VALUE flag: `values.get` would silently miss it.
  const source = flagValue(args, "source");
  const date = args.values.get("date");
  return {
    ...(sessions !== undefined
      ? {
          sessions: sessions
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        }
      : {}),
    ...(since !== undefined ? { since } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(date !== undefined ? { date } : {}),
  };
}

export const exportDiagramsCommand = exportCommand("diagrams");
export const exportManualsCommand = exportCommand("manuals");
export const exportReportsCommand = exportCommand("reports");
export const exportScriptsCommand = exportCommand("scripts");
