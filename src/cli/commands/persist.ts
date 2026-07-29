import {
  type PersistApplied,
  type PersistValidation,
  applyPersist,
  preparePersist,
  validatePersist,
} from "../../application/persist-service.js";
import type { SemanticRequest } from "../../application/semantic-operation/protocol.js";
import type { CommandResult } from "../../domain/types.js";
import { readRequiredStdin } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { HumanRenderContext, QtcCommand } from "../registry.js";
import { fail, failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

type PersistData =
  | { stage: "prepare"; request: SemanticRequest }
  | ({ stage: "validate" } & PersistValidation)
  | ({ stage: "apply" } & PersistApplied);

export const persistCommand: QtcCommand<PersistData> = {
  name: "persist",
  describe:
    "Adopta trabajo terminado de la conversación en docs/ (research | spec | plan) en una sola operación. " +
    "El CLI resuelve inventario, duplicados, numeración, destino y escritura; la IA solo clasifica y redacta. " +
    "Usage: aw persist prepare | validate | apply --approval <digest>  (validate/apply leen la respuesta por stdin).",

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<PersistData>> {
    const stage = args.rest[0];
    // The request is never carried between stages: each one rebuilds it from
    // the workspace. That is what makes the handshake stateless AND what
    // detects staleness — a docs/ that moved yields a different digest.
    if (stage === "prepare") {
      const request = await preparePersist(ctx.fs, ctx.env, ctx.paths);
      return { ok: true, data: { stage: "prepare", request }, exitCode: 0 };
    }

    if (stage === "validate" || stage === "apply") {
      const raw = await readRequiredStdin();
      const request = await preparePersist(ctx.fs, ctx.env, ctx.paths);

      if (stage === "validate") {
        const result = validatePersist(raw, request);
        if (!result.ok) return failSemantic(result.failure);
        return { ok: true, data: { stage: "validate", ...result.value }, exitCode: 0 };
      }

      const approval = args.values.get("approval");
      if (approval === undefined) {
        return fail(
          "ARGS_INVALID",
          "apply exige --approval <digest>: el que devolvió validate y aprobó el usuario",
        );
      }
      const result = await applyPersist(ctx.fs, ctx.env, ctx.paths, { raw, request, approval });
      if (!result.ok) return failSemantic(result.failure);
      return { ok: true, data: { stage: "apply", ...result.value }, exitCode: 0 };
    }

    return fail("ARGS_INVALID", "uso: aw persist prepare | validate | apply --approval <digest>");
  },

  renderHuman(result: CommandResult<PersistData>, context: HumanRenderContext): string {
    const data = result.data;
    if (data === undefined) return "";
    if (data.stage === "prepare") {
      const request = data.request;
      const lines = [
        `persist · prepare (${request.metrics.request_bytes} B)`,
        `  Destinos   ${request.allowed_destinations.join(", ")}`,
        `  Read-set   ${request.read_set.length} documento(s)`,
        `  Digest     ${request.input_digest.slice(0, 12)}…`,
      ];
      if (context.detail) lines.push("", request.contract);
      return `${lines.join("\n")}\n`;
    }
    if (data.stage === "validate") {
      return [
        "persist · propuesta validada — falta tu aprobación",
        `  Categoría  ${data.preview.category} (${data.preview.mode})`,
        `  Destino    ${data.preview.target ?? `${data.preview.destination}/ (número nuevo)`}`,
        `  Tamaño     ${data.preview.bytes} B`,
        `  Aprobación aw persist apply --approval ${data.approval_digest}`,
        "",
      ].join("\n");
    }
    return `persist · escrito ${data.written.join(", ")} (${data.category}, ${data.mode})\n`;
  },
};
