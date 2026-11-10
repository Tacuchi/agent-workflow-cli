import {
  type DocFlowReading,
  type DocFlowSaveApplied,
  type DocFlowSavePreview,
  isDocumentFlow,
  readDocFlow,
  saveDocFlow,
} from "../../application/doc-flow/doc-flow-service.js";
import type { CommandResult } from "../../domain/types.js";
import { readRequiredStdin } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import { failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

export type DocumentVerbResult = DocFlowReading | DocFlowSavePreview | DocFlowSaveApplied;

/** `aw flow read` / `aw flow save`: the stateless document flows (spec 066, ID03-ID04). */
export async function documentVerb(
  verb: "read" | "save",
  args: ParsedArgs,
  ctx: CliContext,
  stdin: () => Promise<string> = () => readRequiredStdin(),
): Promise<CommandResult<DocumentVerbResult>> {
  const flow = args.values.get("flow");
  if (!isDocumentFlow(flow)) {
    return fail(
      "ARGS_INVALID",
      `aw flow ${verb} necesita --flow spec-new | spec-refine | plan-new | plan-refine`,
      `uso: aw flow ${verb} --flow <flow> [--doc <ruta>]`,
    );
  }
  const doc = args.values.get("doc");
  if (verb === "read") {
    const read = await readDocFlow(ctx.fs, ctx.paths, {
      flow,
      ...(doc !== undefined ? { doc } : {}),
    });
    return read.ok
      ? { ok: true, data: read.value, exitCode: 0 }
      : fail(read.failure.code, read.failure.message, read.failure.action);
  }
  const readDigest = args.values.get("read-digest");
  if (readDigest === undefined) {
    return fail(
      "ARGS_INVALID",
      "aw flow save necesita --read-digest: el digest que devolvió 'aw flow read'",
      "leé el documento con 'aw flow read' y citá su read_digest",
    );
  }
  const content = await stdin();
  if (content.trim() === "") {
    return fail(
      "ARGS_INVALID",
      "aw flow save lee el documento completo por stdin y llegó vacío",
      "pasá el Markdown por stdin",
    );
  }
  const slug = args.values.get("slug");
  const approval = args.values.get("approval");
  const saved = await saveDocFlow(ctx.fs, ctx.paths, {
    flow,
    read_digest: readDigest,
    content,
    ...(doc !== undefined ? { doc } : {}),
    ...(slug !== undefined ? { slug } : {}),
    ...(approval !== undefined ? { approval } : {}),
  });
  return saved.ok
    ? { ok: true, data: saved.value, exitCode: 0 }
    : fail(saved.failure.code, saved.failure.message, saved.failure.action);
}

function fail<T>(code: string, message: string, action: string): CommandResult<T> {
  return failSemantic<T>({ code, message, action });
}

/** Human projection of a document verb's result, `null` for anything else. */
export function renderDocumentHuman(data: object): string | null {
  if ("read_digest" in data) {
    const read = data as DocFlowReading;
    return `${read.flow} · ${read.doc ?? "documento nuevo"} · estado ${read.state ?? "—"}\nread_digest: ${read.read_digest}\n${read.next}\n`;
  }
  if ("content_digest" in data) {
    const preview = data as DocFlowSavePreview;
    return `vista previa de ${preview.target} (estado ${preview.state})\naprobación: ${preview.approval}\n`;
  }
  if ("status" in data && (data as DocFlowSaveApplied).status === "written") {
    const written = data as DocFlowSaveApplied;
    return `escrito ${written.path} (estado ${written.state})\n`;
  }
  return null;
}
