import { join } from "node:path";
import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import {
  type DelegatedAction,
  type FlowDecision,
  proposalContractOf,
} from "../../domain/flow/authority.js";
import type { FlowRunState } from "../../domain/flow/run-state.js";
import { canonicalEol } from "../../domain/proposal.js";
import { checkSafeRelativePath } from "../../domain/safe-path.js";
import { SOURCE_BOUNDED_EVIDENCE } from "../../domain/source-boundary.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import { scanMarkdown } from "../markdown.js";
import { parsePlanStatus } from "../parsers/plan-status.js";
import type { PathsService } from "../paths-service.js";
import { effectsOfTransition, resolveBoundary } from "./advance.js";
import { captureCheckoutProof } from "./prove.js";
import { journeyForRun } from "./run-journey.js";
import { locateRun, readRun } from "./run-state-service.js";

/**
 * The answer an agent sends, completed with what the CLI already knows before it
 * is observed and judged (plan 082 F5 · spec 061 AC-06, AC-07).
 *
 * The agent brings its judgment and the real output (`detail`); the CLI fills
 * the continuity digest, the sealed invocation, the effects, the id of a single
 * evidence and the checkout proofs, expands a document sent by path and seals
 * its status. A field the agent sends is never replaced: it is judged exactly as
 * before, so a hand-built complete answer still travels the same road.
 */

type Body = Record<string, unknown>;

export type CompletedAnswer =
  | {
      ok: true;
      /** What is observed and judged. */
      raw: string;
      /**
       * What identifies the attempt: the answer as sent with its drafts
       * expanded, WITHOUT the fields the CLI filled. A captured proof changes
       * with every write, so hashing it would hide a resend.
       */
      identity: string;
    }
  | { ok: false; failure: CapabilityFailure };

interface CompletionInput {
  raw: string;
  session: string;
  git?: GitPort;
}

function refuse(code: string, message: string, action: string): CompletedAnswer {
  return { ok: false, failure: { code, message, action } };
}

export async function completeAnswer(
  fs: FileSystemPort,
  paths: PathsService,
  input: CompletionInput,
): Promise<CompletedAnswer> {
  const unchanged: CompletedAnswer = { ok: true, raw: input.raw, identity: input.raw };
  let body: Body;
  try {
    const parsed: unknown = JSON.parse(input.raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return unchanged;
    body = parsed as Body;
  } catch {
    // The parser owns the malformed-payload refusal and its wording.
    return unchanged;
  }
  const run = await readRun(fs, locateRun(paths, input.session));
  if (!run.ok) return unchanged;
  const resolved = resolveBoundary(run.state, journeyForRun(run.state));
  const stopped = resolved.stopped;
  if (stopped === null) return unchanged;

  const expanded = await expandDrafts(fs, paths, input.session, body);
  if (!expanded.ok) return expanded.failure;

  const filled: Body = { ...expanded.body };
  const stale = fillDigest(filled, stopped.id, resolved.seal);
  if (stale !== null) return stale;
  if (proposalContractOf(stopped) !== null) {
    const closed = sealStatuses(stopped, filled);
    if (closed !== null) return closed;
  }
  let checkouts: string[] = [];
  if (resolved.kind === "execution" && resolved.action !== null) {
    const executed = await completeExecution(fs, paths, input, run.state, stopped, {
      action: resolved.action,
      body: filled,
    });
    if (!executed.ok) return executed;
    checkouts = executed.checkouts;
  }
  // The checkouts a captured proof measured stay in the identity: an unchanged
  // tree resends its twin, a changed one is a new attempt — as when the agent
  // brought a new proof itself.
  const identity =
    checkouts.length === 0
      ? JSON.stringify(expanded.body)
      : JSON.stringify({ answer: expanded.body, checkouts });
  return { ok: true, raw: JSON.stringify(filled), identity };
}

/**
 * Without the digest, the transition is what keeps a resend from landing on the
 * boundary that follows the one it answered. With neither, the parser refuses
 * it as always.
 */
function fillDigest(body: Body, inForce: string, seal: string): CompletedAnswer | null {
  if (body.input_digest !== undefined || body.transition === undefined) return null;
  if (body.transition !== inForce) {
    return refuse(
      "FLOW_ANSWER_STALE",
      `la respuesta es para '${String(body.transition)}' y la frontera vigente es '${inForce}'`,
      `respondé la frontera vigente con 'transition': '${inForce}'`,
    );
  }
  body.input_digest = seal;
  return null;
}

/** Every artifact sent as `{path, draft}` read from the session folder, confined to it. */
async function expandDrafts(
  fs: FileSystemPort,
  paths: PathsService,
  session: string,
  body: Body,
): Promise<{ ok: true; body: Body } | { ok: false; failure: CompletedAnswer }> {
  if (!Array.isArray(body.artifacts)) return { ok: true, body };
  const folder = join(paths.cwdSessionsDir(), session);
  const artifacts: unknown[] = [];
  for (const artifact of body.artifacts as unknown[]) {
    const draft = (artifact as { draft?: unknown } | null)?.draft;
    if (typeof draft !== "string" || (artifact as { content?: unknown }).content !== undefined) {
      artifacts.push(artifact);
      continue;
    }
    const safe = checkSafeRelativePath(draft);
    if (!safe.ok) {
      return {
        ok: false,
        failure: refuse(
          "FLOW_ARTIFACT_DRAFT_OUTSIDE",
          `el borrador '${draft}' ${safe.why}: tiene que ser una ruta relativa dentro de la carpeta de la sesión`,
          `escribí el borrador dentro de ${folder} y nombralo relativo a esa carpeta`,
        ),
      };
    }
    const path = join(folder, safe.path);
    if (!(await fs.exists(path))) {
      return {
        ok: false,
        failure: refuse(
          "FLOW_ARTIFACT_DRAFT_MISSING",
          `el borrador '${safe.path}' no existe en la carpeta de la sesión`,
          `escribí el documento en ${path} y volvé a enviar la respuesta`,
        ),
      };
    }
    const { draft: _draft, ...rest } = artifact as Body;
    artifacts.push({ ...rest, content: await fs.readText(path) });
  }
  return { ok: true, body: { ...body, artifacts } };
}

/**
 * The status the publication promises, written by the CLI into the proposed
 * bytes: a refined spec is `ready-for-plan` and a proposed plan is `open`. Bytes
 * that already say so are left exactly as they are, so an inline answer and one
 * sent by path seal the same digest.
 */
function sealStatuses(stopped: FlowDecision, body: Body): CompletedAnswer | null {
  if (!Array.isArray(body.artifacts)) return null;
  const spec = stopped.id.startsWith("spec-refine.");
  // Sealing `open` over a plan that says `done` would reopen it in silence: that
  // is a separate decision, never a side effect of proposing its bytes.
  const done = (body.artifacts as unknown[]).find((artifact) => {
    const content = (artifact as { content?: unknown } | null)?.content;
    return !spec && typeof content === "string" && parsePlanStatus(content).declared === "done";
  });
  if (done !== undefined) {
    return refuse(
      "FLOW_PROPOSAL_PLAN_DONE",
      `'${String((done as { path?: unknown }).path)}' declara '> Estado: done': una propuesta de plan nace o sigue abierta`,
      "quitá la línea '> Estado: done' de los bytes propuestos; reabrir un plan cerrado es 'aw flow annul'",
    );
  }
  body.artifacts = (body.artifacts as unknown[]).map((artifact) => {
    const content = (artifact as { content?: unknown } | null)?.content;
    if (typeof content !== "string") return artifact;
    return {
      ...(artifact as Body),
      content: spec ? sealSpecStatus(content) : sealPlanOpen(content),
    };
  });
  return null;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

export function sealSpecStatus(content: string): string {
  const match = FRONTMATTER.exec(content);
  if (match === null) return `---\nstatus: ready-for-plan\n---\n\n${content}`;
  const lines = (match[1] ?? "").split(/\r?\n/);
  const at = lines.findIndex((line) => /^status\s*:/.test(line));
  if (at >= 0 && lines[at]?.replace(/\s+/g, "") === "status:ready-for-plan") return content;
  if (at >= 0) lines[at] = "status: ready-for-plan";
  else lines.push("status: ready-for-plan");
  return `---\n${lines.join("\n")}\n---${match[2] ?? "\n"}${content.slice(match[0].length)}`;
}

/** A plan whose preamble declares no status already reads `open`: only a different one is rewritten. */
export function sealPlanOpen(content: string): string {
  const status = parsePlanStatus(content);
  if (status.declared === "open" || status.declared === "absent") return content;
  const scanned = scanMarkdown(canonicalEol(content));
  const [title, ...rest] = scanned.headings;
  const end = (title?.level === 1 ? rest[0] : title)?.line ?? scanned.lines.length;
  const lines = [...scanned.lines];
  const at = lines.findIndex(
    (line, index) => index < end && !scanned.fenced[index] && /^>\s*Estado\s*:/.test(line),
  );
  if (at >= 0) lines[at] = "> Estado: open";
  return lines.join("\n");
}

/** Invocation, effects, a single evidence and the checkout proofs of an execution answer. */
async function completeExecution(
  fs: FileSystemPort,
  paths: PathsService,
  input: CompletionInput,
  state: FlowRunState,
  stopped: FlowDecision,
  { action, body }: { action: DelegatedAction; body: Body },
): Promise<{ ok: true; checkouts: string[] } | { ok: false; failure: CapabilityFailure }> {
  if (body.invocation === undefined) body.invocation = action.invocation;
  const completed = body.outcome === "completed";
  if (body.effects === undefined) {
    const declared = [...effectsOfTransition(state, stopped)];
    body.effects = { planned: declared, approved: [], applied: completed ? declared : [] };
  }
  const detail = typeof body.detail === "string" ? body.detail : undefined;
  const validations = Array.isArray(body.validations) ? [...(body.validations as Body[])] : [];
  const judged = action.evidence.filter((id) => id !== SOURCE_BOUNDED_EVIDENCE);
  if (!Array.isArray(body.validations) && judged.length === 1 && detail !== undefined) {
    validations.push({ id: judged[0], passed: completed, detail });
  }
  const bounded = action.evidence.includes(SOURCE_BOUNDED_EVIDENCE);
  // Without a git reader nothing can be measured, so nothing is captured and the
  // verdict judges the answer as it came.
  if (
    bounded &&
    input.git !== undefined &&
    !validations.some((item) => item?.id === SOURCE_BOUNDED_EVIDENCE)
  ) {
    const captured = await captureProofs(fs, paths, { ...input, git: input.git }, state, stopped, {
      action,
      body,
    });
    if (!captured.ok) return captured;
    body.validations = [...validations, ...captured.validations];
    return { ok: true, checkouts: captured.checkouts };
  }
  if (validations.length > 0 || Array.isArray(body.validations)) body.validations = validations;
  return { ok: true, checkouts: [] };
}

/** One captured proof per source the boundary demands, with the checkouts they measured. */
async function captureProofs(
  fs: FileSystemPort,
  paths: PathsService,
  input: CompletionInput & { git: GitPort },
  state: FlowRunState,
  stopped: FlowDecision,
  { action, body }: { action: DelegatedAction; body: Body },
): Promise<
  { ok: true; validations: Body[]; checkouts: string[] } | { ok: false; failure: CapabilityFailure }
> {
  const detail = typeof body.detail === "string" ? body.detail : undefined;
  const validations: Body[] = [];
  const checkouts: string[] = [];
  for (const source of proofSources(state, stopped)) {
    const captured = await captureCheckoutProof(fs, paths, input.git, input.session, action, {
      source,
      ...(typeof body.artifact === "string" ? { artifact: body.artifact } : {}),
    });
    // When git itself threw, the observation refuses with git's words; any other
    // capture failure is the CLI's, refused as `prove` refuses it and costing the
    // agent no attempt.
    if (!captured.ok) {
      if (captured.gitFailed === true) return { ok: true, validations: [], checkouts: [] };
      return { ok: false, failure: captured.failure };
    }
    checkouts.push(`${source}:${captured.proof.checkout_digest}`);
    validations.push({
      id: SOURCE_BOUNDED_EVIDENCE,
      passed: body.outcome === "completed",
      detail: detail ?? `prueba del checkout de '${source}' capturada por el CLI`,
      proof: captured.proof,
    });
  }
  return { ok: true, validations, checkouts };
}

/** One proof per scope source at the phase validation of a batch; the documentary one elsewhere. */
function proofSources(state: FlowRunState, stopped: FlowDecision): string[] {
  if (stopped.id === "plan-exec.validation-execution") return [...(state.scope?.sources ?? [])];
  return ["hub"];
}
