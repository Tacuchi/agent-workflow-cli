import { CORRELATIVE_SOURCE } from "./correlative.js";
import {
  type CoreDocsCanon,
  DEFAULT_CORE_DOCS_CANON,
  coreDocumentKindForPath,
} from "./docs-canon.js";

/**
 * The identity of a Workline node, said the same way by everybody who points at
 * one.
 *
 * Provenance is a graph over four kinds of thing — a spec, a plan, a quick and a
 * session — and until now each reader spelled them its own way: the index keys
 * plans by `number`, sessions by folder, and a session's `## Origin` names its
 * parent in prose. Prose is exactly what cannot carry an edge: two readings of
 * "derived from the plan 024" can disagree about which document that is, and a
 * retirement that guessed wrong would delete somebody else's work.
 *
 * So a node has ONE canonical id, `<kind>:<key>`, and every edge is a pair of
 * those. The path is carried beside the id rather than inside it because a
 * document can move: identity is `plan:024`, the path is where it lives today,
 * and a stale path is a warning while a wrong id is a defect.
 */

export const WORKLINE_KINDS = ["spec", "plan", "quick", "session"] as const;

export type WorklineKind = (typeof WORKLINE_KINDS)[number];

export interface WorklineNodeId {
  kind: WorklineKind;
  /**
   * `025` for a spec, `024` for a plan, the session folder for a session or a
   * quick — whatever identifies that kind uniquely inside the workspace.
   */
  key: string;
}

const KIND_SET: ReadonlySet<string> = new Set(WORKLINE_KINDS);

export function isWorklineKind(value: unknown): value is WorklineKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/** `plan:024` — the one spelling of a node, in output and in a seal alike. */
export function formatNodeId(id: WorklineNodeId): string {
  return `${id.kind}:${id.key}`;
}

/**
 * The node a document path IS — `docs/plans/024-plan-x.md` is `plan:024`.
 *
 * This is not inferring provenance from a name: the workspace's own layout fixes
 * that a spec lives at `docs/specs/NNN-spec-*.md`, and the board already reads
 * every spec and plan by exactly this shape. Identity is what the path declares;
 * what the document is DERIVED from is a different question, answered by the
 * document's own `Derived from` line or by a session's sealed custody.
 */
export function nodeFromDocPath(
  path: string,
  canon: Pick<CoreDocsCanon, "spec" | "plan"> = DEFAULT_CORE_DOCS_CANON,
): WorklineNodeId | null {
  const normalized = path.split("\\").join("/");
  const kind = coreDocumentKindForPath(normalized, canon);
  if (kind === null) return null;
  const directory = canon[kind].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:^|/)${directory}/(${CORRELATIVE_SOURCE})-${kind}(?:-[^/]*)?\\.md$`,
    "i",
  );
  const match = re.exec(normalized);
  if (match?.[1] === undefined) return null;
  return { kind, key: match[1] };
}

/**
 * A typed edge: `from` exists BECAUSE of `to`.
 *
 * The direction is fixed as child→parent because that is the direction evidence
 * runs in: a session records what it was derived from at the moment it is
 * created, while a parent cannot know who will descend from it later. Reversing
 * the reading is a traversal; reversing the record would be a guess.
 */
export interface WorklineEdge {
  from: WorklineNodeId;
  to: WorklineNodeId;
  /** How the edge was established — what makes it evidence rather than a hint. */
  evidence: EdgeEvidence;
}

/**
 * Why an edge is believed.
 *
 * `custody` and `derived-from` are provable: one was sealed by the CLI when the
 * node was born, the other is the plan's own machine-readable `Derived from`
 * line. `origin-prose` is the legacy reading of a free-text `## Origin`, and it
 * is kept SEPARATE precisely so a retirement can refuse to act on it — an edge
 * nobody can prove is the one case where deleting is not recoverable.
 */
export const EDGE_EVIDENCE = ["custody", "derived-from", "origin-prose"] as const;

export type EdgeEvidence = (typeof EDGE_EVIDENCE)[number];

/** Whether an edge is strong enough for a destructive closure to include it. */
export function isProvable(evidence: EdgeEvidence): boolean {
  return evidence === "custody" || evidence === "derived-from";
}
