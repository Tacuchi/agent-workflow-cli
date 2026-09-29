import {
  type PersistApplied,
  type PersistValidation,
  applyPersist,
  preparePersist,
  validatePersistWithAttachments,
} from "../../application/persist-service.js";
import type { SemanticRequest } from "../../application/semantic-operation/protocol.js";
import type { CommandResult } from "../../domain/types.js";
import { readRequiredStdin } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import { fail, failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

type PersistData =
  | { stage: "prepare"; request: SemanticRequest }
  | ({ stage: "validate" } & PersistValidation)
  | ({ stage: "apply" } & PersistApplied);

export const persistCommand: CliCommand<PersistData> = {
  name: "persist",
  flags: {
    known: ["approval"],
    actions: { prepare: { known: [] }, validate: { known: [] }, apply: { known: [] } },
  },
  help: {
    purpose:
      "Adopt work from the conversation into docs/ (publish a document) as research, a spec or a plan.",
    flags: {
      approval: {
        value: "<digest>",
        effect: "apply only, where it is required: the approval_digest validate returned.",
      },
    },
    actions: {
      prepare: {
        purpose:
          "Build the semantic request: inventory, allowed destinations, read set and limits.",
        output:
          "{stage: prepare, request {operation, input_digest, contract, inventory, allowed_destinations[], limits, read_set[], metrics}}. Read-only.",
      },
      validate: {
        purpose:
          "Check the classified and drafted response from stdin and preview what would be written.",
        output:
          "{stage: validate, preview {category, mode: new|update, destination, bytes, target, lineage?, attachments[]?}, approval_digest}. Writes nothing.",
      },
      apply: {
        purpose:
          "Write the approved response from stdin into docs/ under the numbering the CLI assigns.",
        output: "{stage: apply, written[], category, mode: new|update}.",
      },
    },
    notes: [
      "The CLI owns inventory, duplicates, numbering, destination and the write; the agent only classifies and drafts. Each stage rebuilds the request from the workspace, so a docs/ that moved changes the digest. validate and apply read the response JSON on stdin; binary attachments go in decisions.attachments [{source, path}] and their byte digest is part of the approval.",
    ],
  },

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<PersistData>> {
    const stage = args.rest[0];
    // The request is never carried between stages: each one rebuilds it from
    // the workspace. That is what makes the handshake stateless AND what
    // detects staleness — a docs/ that moved yields a different digest.
    if (stage !== "prepare" && stage !== "validate" && stage !== "apply") {
      return fail("ARGS_INVALID", "uso: aw persist prepare | validate | apply --approval <digest>");
    }
    const prepared = await preparePersist(ctx.fs, ctx.env, ctx.paths);
    if (!prepared.ok) return failSemantic(prepared.failure);
    if (stage === "prepare") {
      return { ok: true, data: { stage, request: prepared.value }, exitCode: 0 };
    }

    const raw = await readRequiredStdin();
    if (stage === "validate") return await validateStage(ctx, raw, prepared.value);
    return await applyStage(args, ctx, raw, prepared.value);
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
        ...(data.preview.attachments ?? []).map(
          (item) => `  Adjunto    ${item.path} (${item.bytes} B · ${item.digest})`,
        ),
        ...(data.preview.lineage === undefined
          ? []
          : [
              `  Linaje     ${data.preview.lineage === "derived-from" ? "sellado al escribir" : "standalone, sin sello"}`,
            ]),
        `  Aprobación aw persist apply --approval ${data.approval_digest}`,
        "",
      ].join("\n");
    }
    return `persist · escrito ${data.written.join(", ")} (${data.category}, ${data.mode})\n`;
  },
};

async function validateStage(
  ctx: CliContext,
  raw: string,
  request: SemanticRequest,
): Promise<CommandResult<PersistData>> {
  const result = await validatePersistWithAttachments(ctx.fs, ctx.paths, raw, request);
  if (!result.ok) return failSemantic(result.failure);
  return { ok: true, data: { stage: "validate", ...result.value }, exitCode: 0 };
}

async function applyStage(
  args: ParsedArgs,
  ctx: CliContext,
  raw: string,
  request: SemanticRequest,
): Promise<CommandResult<PersistData>> {
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
