import {
  type ExportApplied,
  type ExportCategory,
  type ExportPrepared,
  type ExportScope,
  type ExportSelection,
  type ExportValidation,
  applyExport,
  conflictingScopeFlags,
  prepareExport,
  readExportScope,
  validateExport,
} from "../../application/export-service.js";
import type { SemanticFailure } from "../../application/semantic-operation/protocol.js";
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
 * The answer envelope, published where an executor can read it WITHOUT running
 * the operation.
 *
 * Same reason as `aw flow`'s: the contract is enforced in
 * `semantic-operation/protocol.ts` and, until now, was documented nowhere — so
 * the only way to learn that the field is `state` and not `status` was to send
 * an answer without it and read `estado desconocido: undefined`, which names
 * the value and not the field. A contract only a failed attempt can teach
 * charges every executor the same tuition.
 *
 * Kept beside the command rather than in the doctrine bundle because the
 * bundle's context budget is a frozen gate and this is reference material: it
 * is read while composing an answer, not on every run.
 */
const ENVELOPE = [
  "Sobre de `validate` / `apply` — un único objeto JSON por stdin, con sus campos en el NIVEL SUPERIOR:",
  "",
  "  obligatorio     version: el número que el request trae en 'version'.",
  "                  operation: 'export-<categoría>', copiado del request.",
  "                  input_digest: el 'input_digest' del request, copiado tal cual.",
  "                  state: proposed | ambiguous | unsupported.",
  "",
  "  proposed        artifacts: [{path, content}] — cada path dentro del destino que el request declara en 'allowed_destinations'.",
  "                  scope: el 'scope' del request, copiado TAL CUAL. Es el alcance con el que se preparó: validate y apply lo leen en vez de re-derivarlo, así que NO hace falta repetir --sessions/--since/--source/--date. Repetirlos con otro valor se rechaza.",
  "",
  "  ambiguous       reason: por qué no se puede decidir. No se escribe nada.",
  "  unsupported     reason: por qué la operación no aplica. No se escribe nada.",
  "",
  "  aprobación      --approval <digest> con el 'approval_digest' que devolvió validate — viaja como flag, no dentro del sobre.",
].join("\n");

/**
 * The four exports are the same command with a different policy: same stages,
 * same validation, same authorization. Only the category changes, which is why
 * they are built here instead of copied four times.
 */
function exportCommand(category: ExportCategory): QtcCommand<ExportData> {
  return {
    name: `export-${category}`,
    describe: `${DESCRIBES[category]} Escribe SOLO en su carpeta y nunca crea una sesión. Usage: aw export-${category} prepare | validate | apply --approval <digest> [--overwrite] [--sessions <a,b>] [--since <YYYY-MM-DD>] [--source <alias>] [--date <YYYY-MM-DD>].

${ENVELOPE}`,

    async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<ExportData>> {
      const stage = args.rest[0];
      if (stage !== "prepare" && stage !== "validate" && stage !== "apply") {
        return fail(
          "ARGS_INVALID",
          `uso: aw export-${category} prepare | validate | apply --approval <digest>`,
        );
      }

      // stdin FIRST on the later stages: the answer carries the scope its
      // proposal was written against, and rebuilding the request without it is
      // what used to reject a perfectly current answer as stale.
      const raw = stage === "prepare" ? "" : await readRequiredStdin();
      const scope = resolveStageScope(stage, raw, args);
      if (!scope.ok) return failSemantic(scope.failure);

      // Each stage rebuilds the request from the workspace: stateless, and the
      // corpus digest is what detects a session that moved meanwhile.
      const prepared = await prepareExport(ctx.fs, ctx.env, ctx.paths, category, scope.selection);
      if (!prepared.ok) return failSemantic(prepared.failure);

      if (stage === "prepare") {
        return { ok: true, data: { stage: "prepare", prepared: prepared.value }, exitCode: 0 };
      }
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

type StageScope =
  | { ok: true; selection: ExportSelection }
  | { ok: false; failure: SemanticFailure };

/**
 * What this stage should prepare over: the scope the answer echoes when there
 * is one, the invocation's own flags otherwise.
 */
function resolveStageScope(stage: string, raw: string, args: ParsedArgs): StageScope {
  const flags = selection(args);
  if (stage === "prepare") return { ok: true, selection: flags };

  const echoed = readExportScope(raw);
  if (!echoed.ok) return echoed;
  if (echoed.value === null) return { ok: true, selection: flags };

  const conflicts = conflictingScopeFlags(echoed.value, flags);
  if (conflicts.length > 0) {
    return {
      ok: false,
      failure: {
        code: "EXPORT_SCOPE_CONFLICT",
        message: `${conflicts.join(" y ")} contradice(n) el alcance con el que se preparó (${describeScope(echoed.value)})`,
        action: `quitá los flags de alcance en ${stage}: el sobre ya trae el alcance de la preparación`,
      },
    };
  }
  return { ok: true, selection: echoed.value };
}

function describeScope(scope: ExportScope): string {
  const parts = [
    ...(scope.sessions === undefined ? [] : [`--sessions ${scope.sessions.join(",")}`]),
    ...(scope.since === undefined ? [] : [`--since ${scope.since}`]),
    ...(scope.source === undefined ? [] : [`--source ${scope.source}`]),
    `--date ${scope.date}`,
  ];
  return parts.join(" ");
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
