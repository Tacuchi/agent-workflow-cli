/**
 * What a session RECEIVED, what it CREATED and what it CHANGED — sealed, and
 * written before the session can produce a single effect.
 *
 * `SESSION.md`'s `## Origin` was the only record of where a run came from, and it
 * is prose: it can say "derived from the plan 024" and still not answer the two
 * questions a retirement has to answer before deleting anything. Which artifacts
 * existed BEFORE this run, byte for byte? And which of the things that exist now
 * are this run's, as opposed to somebody else's work that happens to sit in the
 * same tree? Neither is derivable from names, dates or tags, and guessing either
 * one wrong destroys work nobody can reconstruct.
 *
 * So custody is the authority and `## Origin` becomes its human projection:
 *
 * - **Born with the session, in the same operation.** A session that exists
 *   without custody could already have mutated something by the time anybody
 *   thinks to record a baseline, and a baseline taken afterwards is a fiction.
 * - **A baseline is bytes or an explicit absence.** "The file was not there" is a
 *   fact a restore needs as much as its previous content; leaving it implicit is
 *   what turns a reset into a delete.
 * - **Effects are receipts, never inferences.** A commit's SHAs come back from
 *   the commit that made them. Reading ownership off a commit MESSAGE would make
 *   the advisor's convention load-bearing, and a message is not evidence.
 * - **Incomplete is a refusal, not a partial answer.** A custody that cannot say
 *   what it received blocks the mutation that would promise retirement later,
 *   because the alternative is promising a retirement that cannot be delivered.
 *
 * Custody lives INSIDE its session folder and dies with it. A durable record
 * outside would outlive the thing it describes — a parallel history of deleted
 * work, which is precisely the surface `S025/AC-04` says must not exist.
 */

import { semanticDigest } from "../../application/semantic-operation/protocol.js";
import type { WorklineNodeId } from "../workline-node.js";

/** Bumped only when a reader can no longer trust the older shape. */
export const CUSTODY_VERSION = 1;

/** Session-local file the record lives in. Dot-prefixed: it is not an artifact. */
export const CUSTODY_FILE = ".custody.json";

/**
 * The exact previous state of one path: its bytes, or the fact it was absent.
 *
 * `content` is kept for Workline's own text artifacts — a spec, a plan, a
 * checkpoint — because nothing else can reconstruct them. Source code carries no
 * content here on purpose: git already stores every version of it, and copying
 * the same bytes into a session folder would make the baseline grow with the
 * repository while being the less trustworthy of the two copies.
 */
export interface CustodyBaseline {
  /** `false` = the path did not exist; a restore DELETES it back to absence. */
  existed: boolean;
  /** Digest of the previous bytes, always via {@link baselineDigest}. */
  digest: string | null;
  bytes: number | null;
  /** The previous text when it is preserved here; `null` when git owns it. */
  content: string | null;
}

export type ArtifactRole =
  /** Pre-existed the session and may have been modified by it: RESTORED on reset. */
  | "input"
  /** Born inside the session: REMOVED on reset and on discard alike. */
  | "output";

export interface CustodyArtifact {
  /** Workspace-relative path — the same spelling every Workline surface uses. */
  path: string;
  role: ArtifactRole;
  before: CustodyBaseline;
}

/**
 * A source repository as it stood when this session first touched it.
 *
 * The `unit_*` pair is what makes attribution exclusive rather than
 * probabilistic: a session editing in its own worktree on its own branch owns
 * every commit in `baseline_head..unit_head` by construction, and no reading of
 * any commit message is involved. A session editing a SHARED checkout has no
 * unit, and then only paths whose baseline is unambiguous can be attributed to
 * it — which is the difference `S025/AC-09` turns into a block.
 */
export interface CustodySource {
  alias: string;
  /** Absolute path of the source repository itself (never the unit). */
  path: string;
  /** Branch the source's own checkout was on at baseline. */
  branch: string;
  /** HEAD of that branch at baseline; `null` on a repo with no commit yet. */
  baseline_head: string | null;
  /** The session's isolation unit, when it took one. */
  unit_branch: string | null;
  unit_path: string | null;
  /**
   * Digest of the source's uncommitted state at baseline.
   *
   * What it answers is "was this already dirty before we arrived?", and that is
   * the only honest way to refuse to discard a change we did not make: a hunk
   * present at baseline is somebody else's by definition.
   */
  dirty_digest: string;
  /** Paths already dirty at baseline, so a diff can name what is not ours. */
  dirty_paths: string[];
}

/**
 * What really happened, as reported by whatever performed it.
 *
 * Six kinds, and each one carries the identifiers its own undo needs. A receipt
 * is never derived from a later reading of the repository: that reading is the
 * thing the receipt exists to make checkable.
 */
export type CustodyEffectKind =
  | "unit_taken"
  | "unit_integrated"
  | "commit"
  | "artifact_published"
  | "flow_adopted"
  | "history_row";

export interface CustodyEffect {
  kind: CustodyEffectKind;
  /** Source alias when the effect belongs to a repository; `null` otherwise. */
  alias: string | null;
  /** Commit SHA before the effect — the ref's previous value. */
  before: string | null;
  /** Commit SHA the effect produced. */
  after: string | null;
  /** Parents of `after`, so a revert knows which side of a merge it undoes. */
  parents: string[];
  /** Ref the effect moved (`refs/heads/aw/119-…`), when it moved one. */
  ref: string | null;
  /** Workspace-relative paths the effect wrote, when it wrote any. */
  paths: string[];
  /** Local date the effect was recorded, for a human reading the trail. */
  at: string;
}

export interface SessionCustody {
  version: number;
  /** The session this custody belongs to. */
  subject: WorklineNodeId;
  /** Absolute path of the session folder — where the custody itself lives. */
  subject_path: string;
  /** Typed provenance: what this session was derived FROM. */
  parents: WorklineNodeId[];
  /** Local date the session (and this record) were created. */
  created: string;
  artifacts: CustodyArtifact[];
  sources: CustodySource[];
  effects: CustodyEffect[];
  /** The seal over everything above. */
  digest: string;
}

/** The one way to digest a baseline's bytes, shared with the proposal's bases. */
export function baselineDigest(text: string): string {
  return semanticDigest(text);
}

/** A baseline for a path that was not there. Explicit, never an absent field. */
export const ABSENT_BASELINE: CustodyBaseline = {
  existed: false,
  digest: null,
  bytes: null,
  content: null,
};

/** A baseline that preserves the previous text, for what only we can restore. */
export function preservedBaseline(content: string): CustodyBaseline {
  return {
    existed: true,
    digest: baselineDigest(content),
    bytes: Buffer.byteLength(content, "utf8"),
    content,
  };
}

export interface SealCustodyInput {
  subject: WorklineNodeId;
  subjectPath: string;
  parents?: readonly WorklineNodeId[];
  created: string;
  artifacts?: readonly CustodyArtifact[];
  sources?: readonly CustodySource[];
  effects?: readonly CustodyEffect[];
}

export function sealCustody(input: SealCustodyInput): SessionCustody {
  const body = {
    version: CUSTODY_VERSION,
    subject: input.subject,
    subject_path: input.subjectPath,
    parents: [...(input.parents ?? [])],
    created: input.created,
    artifacts: [...(input.artifacts ?? [])],
    sources: [...(input.sources ?? [])],
    effects: [...(input.effects ?? [])],
  };
  return { ...body, digest: custodyDigest(body) };
}

/**
 * The seal, over the SET rather than the order things were appended in.
 *
 * Two custodies that recorded the same facts in a different order are the same
 * custody, and a digest that disagreed would report tampering on a detail nobody
 * can see. Content travels as its own digest so the seal stays a fixed size
 * whatever the preserved bytes weigh.
 */
export function custodyDigest(body: Omit<SessionCustody, "digest">): string {
  return semanticDigest({
    version: body.version,
    subject: body.subject,
    subject_path: body.subject_path,
    parents: [...body.parents].sort(nodeOrder),
    created: body.created,
    artifacts: [...body.artifacts]
      .map((a) => ({
        path: a.path,
        role: a.role,
        before: {
          existed: a.before.existed,
          digest: a.before.digest,
          bytes: a.before.bytes,
          content_digest: a.before.content === null ? null : baselineDigest(a.before.content),
        },
      }))
      .sort((a, b) => order(a.path, b.path)),
    sources: [...body.sources].sort((a, b) => order(a.alias, b.alias)),
    effects: [...body.effects],
  });
}

function nodeOrder(a: WorklineNodeId, b: WorklineNodeId): number {
  return order(`${a.kind}:${a.key}`, `${b.kind}:${b.key}`);
}

/** Code-unit ordering, the same reason `canonicalJson` avoids `localeCompare`. */
function order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Why a custody cannot be trusted as a baseline — one reason per missing fact. */
export interface CustodyGap {
  what: string;
  why: string;
}

export interface CustodyCompleteness {
  complete: boolean;
  gaps: CustodyGap[];
}

/**
 * Whether this record can still answer "what did the session receive".
 *
 * Called at two very different moments and that is deliberate: before a mutation
 * that promises retirement, and again before a retirement is prepared. The first
 * refuses to make the promise; the second refuses to pretend it was kept. Both
 * read the same rule, so a session that was allowed to mutate is never one whose
 * retirement turns out to be unprovable.
 */
export function custodyCompleteness(custody: SessionCustody): CustodyCompleteness {
  const gaps: CustodyGap[] = [];
  if (custody.version !== CUSTODY_VERSION) {
    gaps.push({
      what: `versión de custodia ${custody.version}`,
      why: `este CLI sella y lee la versión ${CUSTODY_VERSION}`,
    });
  }
  if (custody.digest !== custodyDigest(stripDigest(custody))) {
    gaps.push({
      what: "sello de la custodia",
      why: "el registro no coincide con su digest: fue editado fuera del CLI",
    });
  }
  for (const artifact of custody.artifacts) {
    if (artifact.role !== "input") continue;
    if (artifact.before.existed && artifact.before.digest === null) {
      gaps.push({
        what: `baseline de '${artifact.path}'`,
        why: "la entrada existía y no se conservó su estado previo",
      });
    }
  }
  for (const source of custody.sources) {
    if (source.baseline_head === null && source.unit_branch !== null) {
      gaps.push({
        what: `baseline git de '${source.alias}'`,
        why: "la sesión tomó una unidad sobre una fuente cuyo HEAD no se registró",
      });
    }
  }
  return { complete: gaps.length === 0, gaps };
}

function stripDigest(custody: SessionCustody): Omit<SessionCustody, "digest"> {
  const { digest: _digest, ...body } = custody;
  return body;
}

/**
 * Every commit this session can prove is its own, per source.
 *
 * Two independent readings, and both are receipts rather than heuristics: the
 * commits a typed commit reported making, and — for a session with its own unit
 * — the range its branch advanced over its recorded baseline. The second is what
 * covers commits the agent made with plain git inside its unit: the branch is
 * the session's by convention and the baseline is sealed, so the range is
 * exclusive by construction and needs nobody's commit message.
 */
export function attributableCommits(custody: SessionCustody, alias: string): string[] {
  const seen = new Set<string>();
  for (const effect of custody.effects) {
    if (effect.kind !== "commit" && effect.kind !== "unit_integrated") continue;
    if (effect.alias !== alias || effect.after === null) continue;
    seen.add(effect.after);
  }
  return [...seen];
}
