/**
 * `aw amend`: correcting the WORDING of a closed spec or plan, in one act.
 *
 * The lane exists because the alternative was disproportionate. A sentence in a
 * closed document that reads wrong — a typo, an ambiguous phrase, a stale
 * pointer — had exactly one way out: a whole refinement, with its journey, its
 * preview and its approval, to change a line nobody disagrees about. That is the
 * ceremony this closes, and it closes it without touching the other half: the
 * refinement stays the human's act, and nothing here starts one.
 *
 * ONE ACT, deliberately. `aw reseal` splits into `prepare` and `apply` because a
 * PERSON stands between the two steps: re-sealing asserts that somebody read a
 * plan against its spec. Here there is no such assertion to stage — the caller
 * declares that the correction changes no scope, no criteria and no rules, and
 * that declaration is what gets recorded. What protects the write is not a second
 * step but the workspace lock plus the compare-and-swap on the document's own
 * digest, which is the same protection `reseal apply` ends up with.
 *
 * And the declaration is not what stops a change to the contract. That is
 * checked, with what the checkout already knows how to compute:
 *
 * - a spec's FUNCTIONAL digest — the editorial payload is exactly what it
 *   ignores, so a wording fix leaves it still and a moved criterion does not;
 * - a plan's structure — its header blockquote, its phase/task graph, its
 *   closing clauses (read with the gate's own extractor) and its declared
 *   execution batches.
 *
 * Anything that moves one of those is refused and sent to the refinement that
 * owns it. What the declaration adds is the part no rule can see: WHY the caller
 * believes the correction is editorial.
 */

import { join } from "node:path";
import { normalizeCorrelativeInput } from "../domain/correlative.js";
import { type CoreDocsCanon, coreDocumentKindForPath } from "../domain/docs-canon.js";
import { baseDigest, sealProposal } from "../domain/proposal.js";
import { checkSafeRelativePath } from "../domain/safe-path.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { resolveCoreDocsCanon } from "./docs-canon-service.js";
import { applyLocalProposal } from "./local-proposal.js";
import { scanMarkdown } from "./markdown.js";
import { parsePhases } from "./parsers/phases.js";
import { parsePlanStatus } from "./parsers/plan-status.js";
import { functionalSpecDigest } from "./parsers/spec-functional.js";
import { parseTasks } from "./parsers/tasks.js";
import { type PathsService, resolveWorkspaceRoot } from "./paths-service.js";
import { closingClausesOf, parsePlanSourceBoundary } from "./source-boundary-policy.js";

/** Lives next to `claims.jsonl`: workspace state, never workspace corpus. */
const LEDGER_FILE = "amendments.jsonl";
const LEDGER_VERSION = 1;
const AMEND_OPERATION = "amend.wording";

/** Every refusal this lane owns. The publication's own codes travel verbatim. */
export type AmendCode =
  | "AMEND_TARGET_UNKNOWN"
  | "AMEND_TARGET_OPEN"
  | "AMEND_DECLARATION_MISSING"
  | "AMEND_TEXT_ABSENT"
  | "AMEND_TEXT_AMBIGUOUS"
  | "AMEND_TEXT_UNCHANGED"
  | "AMEND_CONTRACT_TOUCHED"
  | "AMEND_RECORD_UNKNOWN";

export interface AmendFailure {
  /** An {@link AmendCode}, or the publication's own when the write refused. */
  code: string;
  message: string;
  /** One valid next move — never a dead end. */
  action: string;
}

/**
 * What one correction records, and it is a RECORD rather than a diff to replay.
 *
 * The pre-image is the exact fragment that was replaced, not the whole document:
 * the ledger is append-only and one line per record — the same reason
 * `claims.jsonl` keeps its records small, because a single small write is atomic
 * under `O_APPEND` and a pretty-printed document would stop being one. The two
 * document digests are what makes the record verifiable anyway: `before` says
 * which bytes were corrected and `after` which ones resulted.
 */
export interface Amendment {
  id: string;
  /** Workspace-relative path of the corrected document. */
  document: string;
  /** `direct` is what distinguishes this from a change born of a refinement. */
  origin: "direct";
  /** The caller's declaration that no scope, criteria or rule moved. */
  declaration: string;
  /** The exact text that was there. */
  from: string;
  /** The exact text that replaced it. */
  to: string;
  before_digest: string;
  after_digest: string;
}

export interface AmendmentEvent {
  version: number;
  at: string;
  event: "amended" | "reverted";
  amendment: Amendment;
  cause?: string;
}

export interface AmendInput {
  /** Path inside the workspace, or a correlative the canon can resolve. */
  target: string;
  /** The exact text to replace — it must appear exactly once. */
  from: string;
  to: string;
  /** Why this changes no scope, no criteria and no rules. */
  declaration: string;
}

export type AmendResult =
  | { status: "applied"; amendment: Amendment; written: string[] }
  | { status: "failed"; failure: AmendFailure };

export type AmendRevertResult =
  | { status: "reverted"; amendment: Amendment; written: string[] }
  | { status: "failed"; failure: AmendFailure };

function fail(
  code: AmendCode,
  message: string,
  action: string,
): { status: "failed"; failure: AmendFailure } {
  return { status: "failed", failure: { code, message, action } };
}

/** Correct the wording of a closed document, in one act. */
export async function amendDocument(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: AmendInput,
): Promise<AmendResult> {
  if (input.declaration.trim().length === 0) {
    return fail(
      "AMEND_DECLARATION_MISSING",
      "una corrección directa se registra con su declaración, y no llegó ninguna",
      "declará con --declaracion por qué la corrección no cambia alcance, criterios ni reglas; si sí los cambia, la vía es /w:spec-refine o /w:plan-refine",
    );
  }
  const resolved = await resolveTarget(fs, env, paths, input.target);
  if ("failure" in resolved) return { status: "failed", failure: resolved.failure };
  const { document, absolute, text, kind } = resolved;

  const closed = closureOf(kind, text);
  if (closed !== null) {
    return fail(
      "AMEND_TARGET_OPEN",
      `'${document}' ${closed}: la corrección directa es para documentos ya cerrados`,
      "mientras el documento está abierto lo escribe el recorrido que lo tiene: corregí ahí, o cerralo antes de corregirlo por esta vía",
    );
  }
  const located = locate(text, input.from, input.to);
  if ("failure" in located) return { status: "failed", failure: located.failure };

  const guard = contractGuard(kind, text, located.after);
  if (guard !== null) {
    return fail(
      "AMEND_CONTRACT_TOUCHED",
      `la corrección mueve ${guard} de '${document}': eso no es redacción`,
      kind === "spec"
        ? "lo que cambia el contenido funcional de una spec se refina: /w:spec-refine"
        : "lo que cambia la estructura de un plan se refina: /w:plan-refine",
    );
  }
  const amendment: Amendment = {
    id: baseDigest(`${document}\n${input.from}\n${input.to}\n${baseDigest(text)}`).slice(0, 16),
    document,
    origin: "direct",
    declaration: input.declaration.trim(),
    from: input.from,
    to: input.to,
    before_digest: baseDigest(text),
    after_digest: baseDigest(located.after),
  };
  const written = await publish(fs, env, paths, {
    document,
    absolute,
    content: located.after,
    base: amendment.before_digest,
  });
  if ("failure" in written) return { status: "failed", failure: written.failure };
  await appendAmendmentEvent(fs, paths, { event: "amended", amendment });
  return { status: "applied", amendment, written: written.written };
}

/** Undo one recorded correction, re-applying its exact pre-image. */
export async function revertAmendment(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  id: string,
): Promise<AmendRevertResult> {
  const events = await readAmendmentEvents(fs, paths);
  const applied = events.filter((event) => event.amendment.id === id);
  const last = applied.at(-1);
  if (last === undefined) {
    return fail(
      "AMEND_RECORD_UNKNOWN",
      `no hay ninguna corrección registrada con el identificador '${id}'`,
      "listá las correcciones del documento con 'aw amend list <documento>' y revertí una de las que aparecen",
    );
  }
  if (last.event === "reverted") {
    return fail(
      "AMEND_RECORD_UNKNOWN",
      `la corrección '${id}' ya fue revertida`,
      "una reversión es su propio evento: no se revierte dos veces la misma corrección",
    );
  }
  const resolved = await resolveTarget(fs, env, paths, last.amendment.document);
  if ("failure" in resolved) return { status: "failed", failure: resolved.failure };
  const { document, absolute, text } = resolved;

  // The inverse replacement, under the same uniqueness rule: the image has to be
  // there exactly once, which is what keeps a revert from guessing which of two
  // identical fragments it was about.
  const located = locate(text, last.amendment.to, last.amendment.from);
  if ("failure" in located) return { status: "failed", failure: located.failure };

  const written = await publish(fs, env, paths, {
    document,
    absolute,
    content: located.after,
    base: baseDigest(text),
  });
  if ("failure" in written) return { status: "failed", failure: written.failure };
  await appendAmendmentEvent(fs, paths, {
    event: "reverted",
    amendment: last.amendment,
    cause: `reversión de '${id}': el documento vuelve a su preimagen`,
  });
  return { status: "reverted", amendment: last.amendment, written: written.written };
}

/** Every correction recorded for one document — or for all of them. */
export async function amendmentsOf(
  fs: FileSystemPort,
  paths: PathsService,
  document?: string,
): Promise<AmendmentEvent[]> {
  const events = await readAmendmentEvents(fs, paths);
  if (document === undefined) return events;
  return events.filter((event) => event.amendment.document === document);
}

export function amendmentLedgerPath(paths: PathsService): string {
  return join(paths.cwdRoot(), LEDGER_FILE);
}

async function appendAmendmentEvent(
  fs: FileSystemPort,
  paths: PathsService,
  event: Omit<AmendmentEvent, "version" | "at"> & { at?: string },
): Promise<void> {
  const record: AmendmentEvent = {
    version: LEDGER_VERSION,
    at: event.at ?? new Date().toISOString(),
    event: event.event,
    amendment: event.amendment,
    ...(event.cause === undefined ? {} : { cause: event.cause }),
  };
  await fs.appendText(amendmentLedgerPath(paths), `${JSON.stringify(record)}\n`);
}

async function readAmendmentEvents(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<AmendmentEvent[]> {
  const path = amendmentLedgerPath(paths);
  if (!(await fs.exists(path))) return [];
  const raw = await fs.readText(path);
  const events: AmendmentEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as AmendmentEvent;
      if (typeof parsed?.amendment?.id === "string") events.push(parsed);
    } catch {
      // An unreadable line is not a reason to refuse the readable ones, and it is
      // not silently a missing record either: it cannot be reverted, because a
      // revert needs the pre-image this line no longer yields.
    }
  }
  return events;
}

interface ResolvedTarget {
  document: string;
  absolute: string;
  text: string;
  kind: "spec" | "plan";
}

async function resolveTarget(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  target: string,
): Promise<ResolvedTarget | { failure: AmendFailure }> {
  const root = await resolveWorkspaceRoot(fs, env, paths);
  const canon = await resolveCoreDocsCanon(fs, paths);
  if (!canon.ok) {
    return {
      failure: {
        code: "AMEND_TARGET_UNKNOWN",
        message: canon.error,
        action: "corregí el canon documental del workspace y volvé a intentar",
      },
    };
  }
  const relative = await resolveRelative(fs, root, canon.canon, target);
  if (relative === null || !checkSafeRelativePath(relative).ok) {
    return {
      failure: {
        code: "AMEND_TARGET_UNKNOWN",
        message: `no se pudo resolver '${target}' a una spec o un plan del workspace`,
        action: `pasá la ruta relativa del documento (${canon.canon.spec}/… o ${canon.canon.plan}/…) o su correlativo`,
      },
    };
  }
  const kind = coreDocumentKindForPath(relative, canon.canon);
  if (kind !== "spec" && kind !== "plan") {
    return {
      failure: {
        code: "AMEND_TARGET_UNKNOWN",
        message: `'${relative}' no es una spec ni un plan: esta vía corrige la redacción de esos dos`,
        action: `pasá un documento bajo ${canon.canon.spec}/ o ${canon.canon.plan}/`,
      },
    };
  }
  const absolute = join(root, relative);
  if (!(await fs.exists(absolute))) {
    return {
      failure: {
        code: "AMEND_TARGET_UNKNOWN",
        message: `'${relative}' no existe en el workspace`,
        action: "corregí la ruta: no se corrige un documento que nadie puede mostrar",
      },
    };
  }
  return { document: relative, absolute, text: await fs.readText(absolute), kind };
}

/** A relative path as given, or the document a correlative names inside its folder. */
async function resolveRelative(
  fs: FileSystemPort,
  root: string,
  canon: CoreDocsCanon,
  target: string,
): Promise<string | null> {
  const given = target.trim();
  if (given.length === 0) return null;
  if (given.includes("/")) return given;
  const correlative = normalizeCorrelativeInput(given);
  if (correlative === null) return null;
  for (const dir of [canon.plan, canon.spec]) {
    const absolute = join(root, dir);
    if (!(await fs.exists(absolute))) continue;
    const entries = await fs.list(absolute);
    const found = entries.find((entry) => entry.name.startsWith(`${correlative}-`));
    if (found !== undefined) return `${dir}/${found.name}`;
  }
  return null;
}

/** Why this document is not closed, or `null` when it is. */
function closureOf(kind: "spec" | "plan", text: string): string | null {
  if (kind === "plan") {
    const status = parsePlanStatus(text);
    return status.declared === "done" ? null : `declara '> Estado: ${status.declared}'`;
  }
  const status = specStatus(text);
  return status === "ready-for-plan" ? null : `declara 'status: ${status ?? "ausente"}'`;
}

/** The spec's frontmatter `status`, or `null` when it declares none. */
function specStatus(text: string): string | null {
  const { lines } = scanMarkdown(text);
  if ((lines[0] ?? "").trim() !== "---") return null;
  for (let index = 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "---") return null;
    const match = /^status\s*:\s*(.+)$/i.exec(line);
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return null;
}

/** The replacement, applied exactly once — or why it could not be. */
function locate(
  text: string,
  from: string,
  to: string,
): { after: string } | { failure: AmendFailure } {
  if (from.length === 0) {
    return {
      failure: {
        code: "AMEND_TEXT_ABSENT",
        message: "no se declaró qué texto se corrige",
        action: "pasá en --de el texto exacto que hay que reemplazar",
      },
    };
  }
  if (from === to) {
    return {
      failure: {
        code: "AMEND_TEXT_UNCHANGED",
        message: "el texto a corregir y su reemplazo son idénticos",
        action: "no se escribe una corrección que no corrige nada",
      },
    };
  }
  const occurrences = text.split(from).length - 1;
  if (occurrences === 0) {
    return {
      failure: {
        code: "AMEND_TEXT_ABSENT",
        message: "el texto declarado en --de no está en el documento",
        action: "copiá el fragmento exacto tal como está escrito, con sus acentos y su puntuación",
      },
    };
  }
  if (occurrences > 1) {
    return {
      failure: {
        code: "AMEND_TEXT_AMBIGUOUS",
        message: `el texto declarado aparece ${occurrences} veces: cuál de ellas se corrige no se puede adivinar`,
        action: "extendé el fragmento hasta que sea único en el documento",
      },
    };
  }
  return { after: text.replace(from, to) };
}

/** What the correction moved of the contract, or `null` when it moved nothing. */
function contractGuard(kind: "spec" | "plan", before: string, after: string): string | null {
  if (kind === "spec") {
    return functionalSpecDigest(before) === functionalSpecDigest(after)
      ? null
      : "el contenido funcional";
  }
  const moved: string[] = [];
  if (headerOf(before) !== headerOf(after)) moved.push("las líneas de su cabecera");
  if (graphOf(before) !== graphOf(after)) moved.push("el grafo de fases y tareas");
  if (clausesOf(before) !== clausesOf(after)) moved.push("sus cláusulas de cierre");
  if (batchesOf(before) !== batchesOf(after)) moved.push("sus lotes de ejecución");
  return moved.length === 0 ? null : moved.join(", ");
}

/** The blockquote under the title: the plan's own declarations live there. */
function headerOf(text: string): string {
  const { lines, headings } = scanMarkdown(text);
  const [title, ...rest] = headings;
  const end = (title?.level === 1 ? rest[0]?.line : title?.line) ?? lines.length;
  return lines
    .slice(0, end)
    .filter((line) => line.trim().startsWith(">"))
    .map((line) => line.trim())
    .join("\n");
}

/** Phases and tasks as structure: ids, states, sources and checkbox status. */
function graphOf(text: string): string {
  return JSON.stringify({
    phases: parsePhases(text).items.map((phase) => ({ n: phase.n, state: phase.state })),
    tasks: parseTasks(text).items.map((task) => ({
      n: task.n,
      phase: task.phase,
      status: task.status,
      sources: task.sources,
    })),
    sources: parsePlanSourceBoundary(text).phases.map((phase) => ({
      n: phase.n,
      sources: phase.sources,
      tasks: phase.tasks.map((task) => ({ n: task.n, sources: task.sources })),
    })),
  });
}

/** The closing clauses, read with the gate's own extractor. */
function clausesOf(text: string): string {
  return JSON.stringify(closingClausesOf(text));
}

/** The declared `## Execution batches` rows, as written. */
function batchesOf(text: string): string {
  const { lines, headings } = scanMarkdown(text);
  const heading = headings.find(
    (entry) => entry.level === 2 && /execution batches|lotes de ejecuci[oó]n/i.test(entry.title),
  );
  if (heading === undefined) return "";
  const next = headings.find((entry) => entry.level <= 2 && entry.line > heading.line);
  return lines
    .slice(heading.line + 1, next?.line ?? lines.length)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** One document, one write: the lock, the compare-and-swap and the all-or-nothing. */
async function publish(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: { document: string; absolute: string; content: string; base: string },
): Promise<{ written: string[] } | { failure: AmendFailure }> {
  const root = await resolveWorkspaceRoot(fs, env, paths);
  const proposal = sealProposal({
    operation: AMEND_OPERATION,
    artifacts: [{ path: input.document, content: input.content, overwrite: true }],
    bases: [{ path: input.document, digest: input.base }],
    effects: ["mutate_overwrite"],
    requiresApproval: [],
  });
  const applied = await applyLocalProposal(fs, paths, {
    root,
    proposal,
    approval: { digest: proposal.digest, granted: ["mutate_overwrite"] },
    selfAuthorized: [],
  });
  if (!applied.ok) {
    // Verbatim, like the re-seal's: re-coding `PROPOSAL_BASE_STALE` as something
    // of this lane's own would hide WHICH guarantee stopped the write — and a
    // document that moved between the read and the write is exactly the case the
    // compare-and-swap exists to report by name.
    return { failure: applied.failure };
  }
  return { written: [...applied.result.written] };
}
