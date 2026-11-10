import { join } from "node:path";
import { withSpecBaseline } from "../../domain/lineage.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { resolveCoreDocsCanon } from "../docs-canon-service.js";
import { parseMdSectionBilingual, scanMarkdown } from "../markdown.js";
import { readHubBlock } from "../parsers/hub-block.js";
import { type PlanStateValue, parsePlanStatus } from "../parsers/plan-status.js";
import type { PathsService } from "../paths-service.js";
import { resolveHubRootFrom } from "../paths-service.js";
import { planGrammarAtPublication } from "../plan-lint-service.js";
import { HUB_MIGRATE_COMMAND, validatePlanStatusContract } from "../plan-status-contract.js";
import {
  ABSENT_DOCUMENT,
  approvalDigest,
  guardUnchanged,
  readDigestOf,
  textDigest,
} from "./doc-digest.js";
import { publishNumbered } from "./numbering.js";

/** The four flows whose only durable effect is their own document. */
export const DOCUMENT_FLOWS = ["spec-new", "spec-refine", "plan-new", "plan-refine"] as const;

export type DocumentFlow = (typeof DOCUMENT_FLOWS)[number];

export function isDocumentFlow(value: string | undefined): value is DocumentFlow {
  return (DOCUMENT_FLOWS as readonly string[]).includes(value ?? "");
}

export interface DocFlowFailure {
  code: string;
  message: string;
  action: string;
}

export type DocFlowResult<T> = { ok: true; value: T } | { ok: false; failure: DocFlowFailure };

/** Where a document flow stands, derived on every call from the document alone. */
export interface DocFlowReading {
  flow: DocumentFlow;
  /** Hub-relative document the flow reads (the spec for plan-new), `null` for spec-new. */
  doc: string | null;
  /** What this instance read; every save quotes it back. Lives in the conversation only. */
  read_digest: string;
  /** The document's own state field, as the position of the flow. */
  state: string | null;
  /** What the flow does next, in one line. */
  next: string;
  /** The folder a new document is published into, when the flow creates one. */
  destination: string | null;
}

export interface DocFlowSavePreview {
  status: "preview";
  flow: DocumentFlow;
  target: string;
  /** The approval the person gives in the conversation; `save --approval` quotes it. */
  approval: string;
  /** SHA-256 of the bytes that would be written (state sealed by the CLI). */
  content_digest: string;
  state: string;
}

export interface DocFlowSaveApplied {
  status: "written";
  flow: DocumentFlow;
  path: string;
  digest: string;
  state: string;
}

interface Located {
  root: string;
  specDir: string;
  planDir: string;
}

async function locate(fs: FileSystemPort, paths: PathsService): Promise<DocFlowResult<Located>> {
  const canon = await resolveCoreDocsCanon(fs, paths);
  if (!canon.ok) {
    return refuse("DOC_FLOW_CANON_INVALID", canon.error, "corregí [docs] y volvé a intentar");
  }
  const root = await resolveHubRootFrom(fs, paths);
  return { ok: true, value: { root, specDir: canon.canon.spec, planDir: canon.canon.plan } };
}

/**
 * Reads where a document flow stands (spec 066, ID03): from the document's own
 * state field, never from a run file. Writes nothing, creates no session.
 */
export async function readDocFlow(
  fs: FileSystemPort,
  paths: PathsService,
  input: { flow: DocumentFlow; doc?: string },
): Promise<DocFlowResult<DocFlowReading>> {
  const located = await locate(fs, paths);
  if (!located.ok) return located;
  const { root, specDir, planDir } = located.value;
  if (input.flow === "spec-new") {
    return ok({
      flow: input.flow,
      doc: null,
      read_digest: ABSENT_DOCUMENT,
      state: null,
      next: "redactá la spec y guardala con 'aw flow save --flow spec-new --slug <slug>'",
      destination: specDir,
    });
  }
  if (input.doc === undefined) {
    return refuse(
      "DOC_FLOW_DOC_REQUIRED",
      `--flow ${input.flow} lee un documento y no llegó --doc`,
      `pasá --doc <ruta bajo ${input.flow.startsWith("spec") || input.flow === "plan-new" ? specDir : planDir}/>`,
    );
  }
  const absolute = join(root, input.doc);
  if (!(await fs.exists(absolute))) {
    return refuse("DOC_FLOW_DOC_ABSENT", `'${input.doc}' no existe`, "verificá la ruta");
  }
  const text = await fs.readText(absolute);
  const read_digest = await readDigestOf(fs, absolute);
  const position = positionOf(input.flow, text);
  if (!position.ok) return position;
  return ok({
    flow: input.flow,
    doc: input.doc,
    read_digest,
    state: position.value.state,
    next: position.value.next,
    destination: input.flow === "plan-new" ? planDir : null,
  });
}

function positionOf(
  flow: Exclude<DocumentFlow, "spec-new">,
  text: string,
): DocFlowResult<{ state: string; next: string }> {
  if (flow === "spec-refine" || flow === "plan-new") {
    const status = specStatusOf(text);
    if (status === "abandoned" || status === "superseded") {
      return refuse(
        "DOC_FLOW_SPEC_CLOSED",
        `la spec está ${status}: no se refina ni se planifica`,
        "elegí una spec vigente",
      );
    }
    if (flow === "plan-new" && status !== "ready-for-plan") {
      return refuse(
        "DOC_FLOW_SPEC_NOT_READY",
        `la spec está ${status}: plan-new necesita ready-for-plan`,
        "refinala primero con /w:spec-refine",
      );
    }
    return ok({
      state: status,
      next:
        flow === "plan-new"
          ? "redactá el plan y guardalo con 'aw flow save --flow plan-new --doc <spec> --slug <slug>'"
          : "cerrá los huecos de la spec y guardala con 'aw flow save --flow spec-refine --doc <spec>'",
    });
  }
  const status = parsePlanStatus(text);
  if (status.unmigrated !== null) {
    return refuse(
      "HUB_MIGRATION_REQUIRED",
      `el plan declara un estado del modelo de sesiones ('${status.declared}')`,
      `migrá el hub con '${HUB_MIGRATE_COMMAND}'`,
    );
  }
  if (status.declared !== "draft" && status.declared !== "ready" && status.declared !== "absent") {
    return refuse(
      "DOC_FLOW_PLAN_NOT_REFINABLE",
      `el plan está ${status.declared}: plan-refine sólo reforma un plan draft o ready`,
      "un plan en ejecución sigue con /w:plan-exec",
    );
  }
  return ok({
    state: status.declared === "absent" ? "draft" : status.declared,
    next: "reformá el plan y guardalo con 'aw flow save --flow plan-refine --doc <plan>'",
  });
}

/**
 * Saves a document flow's result in two calls that share nothing on disk:
 * without `approval` it returns the sealed preview and the approval digest; with
 * the digest the person approved it writes — only if the document is still the
 * one read (`DOC_CHANGED_SINCE_READ` otherwise) and only that document.
 * A refused answer costs nothing: there are no attempts to count.
 */
export async function saveDocFlow(
  fs: FileSystemPort,
  paths: PathsService,
  input: {
    flow: DocumentFlow;
    doc?: string;
    slug?: string;
    read_digest: string;
    content: string;
    approval?: string;
  },
): Promise<DocFlowResult<DocFlowSavePreview | DocFlowSaveApplied>> {
  const located = await locate(fs, paths);
  if (!located.ok) return located;
  const { root, specDir, planDir } = located.value;
  const shape = checkSaveShape(input);
  if (shape !== null) return { ok: false, failure: shape };
  const creates = input.flow === "spec-new" || input.flow === "plan-new";
  const sealed = await sealContent(fs, paths, { root, specDir }, input.flow, input.content);
  if (!sealed.ok) return sealed;
  const kind = input.flow.startsWith("spec") ? "spec" : "plan";
  const dir = kind === "spec" ? specDir : planDir;
  const target = creates ? `${dir}/NNN-${kind}-${input.slug}.md` : (input.doc as string);
  const content_digest = textDigest(sealed.value.content);
  const approval = approvalDigest({
    flow: input.flow,
    target,
    read: input.read_digest,
    content: content_digest,
  });
  const { state } = sealed.value;
  if (input.approval === undefined) {
    return ok({ status: "preview", flow: input.flow, target, approval, content_digest, state });
  }
  if (input.approval !== approval) {
    return refuse(
      "DOC_FLOW_APPROVAL_MISMATCH",
      "la aprobación no corresponde a estos bytes, este documento o esta lectura",
      "pedí una vista previa nueva sin --approval y aprobá su digest",
    );
  }
  // The guard runs on the very document the instance read: the spec for
  // plan-new (a plan derived from a spec that moved is derived from nothing).
  if (input.doc !== undefined) {
    const changed = await guardUnchanged(fs, join(root, input.doc), input.doc, input.read_digest);
    if (changed !== null) return { ok: false, failure: changed };
  }
  if (!creates) {
    await fs.writeText(join(root, input.doc as string), sealed.value.content);
    return ok({
      status: "written",
      flow: input.flow,
      path: input.doc as string,
      digest: content_digest,
      state,
    });
  }
  const published = await publishNumbered(fs, join(root, dir), kind, input.slug as string, (n) =>
    numbered(sealed.value.content, n),
  );
  return ok({
    status: "written",
    flow: input.flow,
    path: `${dir}/${published.path.split("/").at(-1)}`,
    digest: textDigest(numbered(sealed.value.content, published.number)),
    state,
  });
}

/** What a save needs before anything is read: the slug of a new document, the read one's path. */
function checkSaveShape(input: {
  flow: DocumentFlow;
  doc?: string;
  slug?: string;
}): DocFlowFailure | null {
  const creates = input.flow === "spec-new" || input.flow === "plan-new";
  if (creates && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug ?? "")) {
    return {
      code: "DOC_FLOW_SLUG_INVALID",
      message: `--flow ${input.flow} publica un documento nuevo y necesita --slug en kebab-case`,
      action: "pasá --slug <slug>",
    };
  }
  if (input.flow !== "spec-new" && input.doc === undefined) {
    return {
      code: "DOC_FLOW_DOC_REQUIRED",
      message: "falta --doc",
      action: "pasá la ruta que leíste",
    };
  }
  return null;
}

/** The CLI seals the state the flow promises; the author never writes it. */
async function sealContent(
  fs: FileSystemPort,
  paths: PathsService,
  { root, specDir }: { root: string; specDir: string },
  flow: DocumentFlow,
  content: string,
): Promise<DocFlowResult<{ content: string; state: string }>> {
  if (flow === "spec-new" || flow === "spec-refine") {
    const state = flow === "spec-new" ? "draft" : "ready-for-plan";
    return ok({ content: withSpecStatus(content, state), state });
  }
  const state: PlanStateValue = hasOpenQuestions(content) ? "draft" : "ready";
  let text = withPlanState(content, state);
  const block = await readHubBlock(fs, root, paths.blockMarkers()).catch(() => null);
  const declared = block === null ? null : block.fuentes.map((source) => source.alias);
  const grammar = await planGrammarAtPublication(fs, root, text, declared, specDir, paths);
  const failures = [...grammar.failures, ...validatePlanStatusContract(text)];
  if (failures.length > 0) {
    return refuse(
      "DOC_FLOW_PLAN_GRAMMAR",
      failures.map((failure) => `${failure.code}: ${failure.message}`).join(" · "),
      "corregí los bytes y pedí otra vista previa; 'aw plan lint' lista la gramática entera",
    );
  }
  if (grammar.seal.status === "sealed") text = withSpecBaseline(text, grammar.seal.baseline);
  return ok({ content: text, state });
}

function numbered(content: string, number: string): string {
  const lines = content.split("\n");
  const title = lines.findIndex((line) => /^#\s/.test(line));
  if (title >= 0) lines[title] = (lines[title] ?? "").replace(/\b(NNN|PPP)\b/, number);
  return lines.join("\n");
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

export function specStatusOf(text: string): string {
  const match = FRONTMATTER.exec(text);
  const line = (match?.[1] ?? "").split(/\r?\n/).find((entry) => /^status\s*:/.test(entry));
  return line?.split(":")[1]?.trim() || "draft";
}

function withSpecStatus(content: string, status: string): string {
  const match = FRONTMATTER.exec(content);
  if (match === null) return `---\nstatus: ${status}\n---\n\n${content}`;
  const lines = (match[1] ?? "").split(/\r?\n/);
  const at = lines.findIndex((line) => /^status\s*:/.test(line));
  if (at >= 0) lines[at] = `status: ${status}`;
  else lines.push(`status: ${status}`);
  return `---\n${lines.join("\n")}\n---${match[2] ?? "\n"}${content.slice(match[0].length)}`;
}

/** Writes `> Estado: <state>` under the title, replacing the one there or adding it. */
export function withPlanState(content: string, state: string): string {
  const scanned = scanMarkdown(content);
  const [title, ...rest] = scanned.headings;
  const end = (title?.level === 1 ? rest[0] : title)?.line ?? scanned.lines.length;
  const lines = [...scanned.lines];
  const at = lines.findIndex(
    (line, index) => index < end && !scanned.fenced[index] && /^>\s*Estado\s*:/.test(line),
  );
  if (at >= 0) {
    lines[at] = `> Estado: ${state}`;
    return lines.join("\n");
  }
  const start = title?.level === 1 ? title.line + 1 : 0;
  let last = -1;
  for (let index = start; index < end; index += 1) {
    if (/^>/.test(lines[index] ?? "")) last = index;
  }
  if (last >= 0) lines.splice(last + 1, 0, `> Estado: ${state}`);
  else lines.splice(start, 0, "", `> Estado: ${state}`);
  return lines.join("\n");
}

function hasOpenQuestions(content: string): boolean {
  const section = parseMdSectionBilingual(content, "Open questions") ?? "";
  return /^\s*[-*]\s+\S/m.test(section) && !/^\s*[-*]\s+(ninguna|none)\b/im.test(section);
}

function ok<T>(value: T): DocFlowResult<T> {
  return { ok: true, value };
}

function refuse<T>(code: string, message: string, action: string): DocFlowResult<T> {
  return { ok: false, failure: { code, message, action } };
}
