/**
 * The provenance and ownership graph a retirement reads before it deletes
 * anything.
 *
 * Three readings feed it and each one carries its own strength, which is the
 * whole point of building a graph rather than a list: a plan's `Derived from`
 * line and a session's sealed custody are PROVABLE, while a session's free-text
 * `## Origin` is a hint. A closure computed over hints would delete work whose
 * ownership nobody can demonstrate, so the hint is recorded as such and it is what
 * makes the operation refuse instead of guessing.
 *
 * Nothing here decides anything. It answers "who descends from whom, and how do
 * we know" — the resolver is what turns that into a closure, and the two are kept
 * apart so the evidence can be inspected on its own.
 */

import { join, relative } from "node:path";
import { type CoreDocsCanon, DEFAULT_CORE_DOCS_CANON } from "../../domain/docs-canon.js";
import type { SessionCustody } from "../../domain/session/custody.js";
import { CUSTODY_FILE, custodyCompleteness } from "../../domain/session/custody.js";
import {
  type EdgeEvidence,
  type WorklineEdge,
  type WorklineKind,
  type WorklineNodeId,
  formatNodeId,
  isProvable,
  nodeFromDocPath,
} from "../../domain/workline-node.js";
import type { EnvPort } from "../../ports/env.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import { locateRun, readRun } from "../flow/run-state-service.js";
import type { PathsService } from "../paths-service.js";
import { type CustodyRead, readCustody } from "../session-custody-service.js";
import {
  type IndexedPlan,
  type IndexedSession,
  type IndexedSpec,
  type WorklineIndex,
  buildWorklineIndex,
} from "../workline-index-service.js";

/** How far a session got, said only from evidence. */
export type SessionCompletion =
  /** Its journey has nothing pending, or its artifact reached its terminal state. */
  | "converged"
  /** It is standing on a boundary, or its artifact is still open. */
  | "incomplete"
  /** Neither custody nor run state: a legacy session nobody can vouch for. */
  | "unknown";

export interface SessionNodeFacts {
  folder: string;
  state: "active" | "closed";
  type: string | null;
  completion: SessionCompletion;
  /** Present only when the session carries a v1 custody that reads back. */
  custody: SessionCustody | null;
  /** Why the custody is not usable, when it is not. */
  custody_gap: string | null;
  units: Array<{ alias: string; path: string; branch: string }>;
}

export interface GraphNode {
  id: WorklineNodeId;
  kind: WorklineKind;
  /** Workspace-relative path of the document or the session folder. */
  path: string;
  absolute_path: string;
  /** Sessions only. */
  session: SessionNodeFacts | null;
}

export class RetirementGraph {
  private readonly nodes = new Map<string, GraphNode>();
  readonly edges: WorklineEdge[] = [];

  add(node: GraphNode): void {
    this.nodes.set(formatNodeId(node.id), node);
  }

  addEdge(from: WorklineNodeId, to: WorklineNodeId, evidence: EdgeEvidence): void {
    this.edges.push({ from, to, evidence });
  }

  get(id: WorklineNodeId): GraphNode | undefined {
    return this.nodes.get(formatNodeId(id));
  }

  all(): GraphNode[] {
    return [...this.nodes.values()];
  }

  /** Nodes that declare `id` as a parent, whatever the evidence. */
  childrenOf(id: WorklineNodeId): WorklineEdge[] {
    const key = formatNodeId(id);
    return this.edges.filter((e) => formatNodeId(e.to) === key);
  }

  /** What `id` declares it descends from. */
  parentsOf(id: WorklineNodeId): WorklineEdge[] {
    const key = formatNodeId(id);
    return this.edges.filter((e) => formatNodeId(e.from) === key);
  }

  /** Every session whose custody or origin points at this node. */
  sessionsOf(id: WorklineNodeId): GraphNode[] {
    return this.childrenOf(id)
      .map((e) => this.get(e.from))
      .filter((n): n is GraphNode => n !== undefined && n.kind === "session");
  }

  /** Edges nobody can prove — the ones a destructive closure must refuse. */
  unprovableInto(id: WorklineNodeId): WorklineEdge[] {
    return this.childrenOf(id).filter((e) => !isProvable(e.evidence));
  }
}

export interface GraphDeps {
  fs: FileSystemPort;
  env: EnvPort;
  paths: PathsService;
  git?: GitPort;
}

export interface BuiltGraph {
  graph: RetirementGraph;
  index: WorklineIndex;
}

export async function buildRetirementGraph(
  deps: GraphDeps,
  canon: CoreDocsCanon = DEFAULT_CORE_DOCS_CANON,
): Promise<BuiltGraph> {
  const index = await buildWorklineIndex(deps.fs, deps.env, deps.paths, {
    ...(deps.git !== undefined ? { git: deps.git } : {}),
  });
  const graph = new RetirementGraph();
  const root = deps.paths.workspaceDir();

  for (const spec of index.specs) addDoc(graph, root, "spec", spec);
  for (const plan of index.plans) addDoc(graph, root, "plan", plan);
  for (const plan of index.plans) {
    // The plan's own `Derived from` line, resolved against the real inventory.
    // `ambiguous` and `unknown` contribute NO edge: an unproven provenance must
    // not become a deletion path.
    if (plan.spec.status !== "resolved") continue;
    graph.addEdge(
      { kind: "plan", key: plan.number },
      { kind: "spec", key: plan.spec.number },
      "derived-from",
    );
  }

  for (const session of index.sessions) {
    const node = await sessionNode(deps, root, session, canon);
    graph.add(node);
    linkSession(graph, node, session, canon);
  }
  return { graph, index };
}

function addDoc(
  graph: RetirementGraph,
  root: string,
  kind: "spec" | "plan",
  doc: IndexedSpec | IndexedPlan,
): void {
  graph.add({
    id: { kind, key: doc.number },
    kind,
    path: doc.file,
    absolute_path: join(root, doc.file),
    session: null,
  });
}

/**
 * A session's edges: its custody first, and the prose only when custody has
 * nothing to say.
 *
 * The order matters and the fallback is deliberately weaker. A session sealed
 * with typed parents states its provenance; one that only mentions a document in
 * `## Origin` merely mentions it, and recording that as `origin-prose` is what
 * lets the closure stop rather than treat the two as equivalent.
 */
function linkSession(
  graph: RetirementGraph,
  node: GraphNode,
  session: IndexedSession,
  canon: CoreDocsCanon,
): void {
  const custody = node.session?.custody ?? null;
  if (custody !== null && custody.parents.length > 0) {
    for (const parent of custody.parents) graph.addEdge(node.id, parent, "custody");
    return;
  }
  if (session.linked_doc === null) return;
  const linked = nodeFromDocPath(session.linked_doc, canon);
  if (linked !== null) graph.addEdge(node.id, linked, "origin-prose");
}

async function sessionNode(
  deps: GraphDeps,
  root: string,
  session: IndexedSession,
  canon: CoreDocsCanon,
): Promise<GraphNode> {
  const read = await readCustody(deps.fs, session.path);
  const facts: SessionNodeFacts = {
    folder: session.folder,
    state: session.state,
    type: session.type,
    completion: await completionOf(deps, session, read, canon),
    custody: read.status === "present" ? read.custody : null,
    custody_gap: custodyGap(read),
    units: session.units,
  };
  return {
    id: { kind: "session", key: session.folder },
    kind: "session",
    path: relative(root, session.path).split("\\").join("/"),
    absolute_path: session.path,
    session: facts,
  };
}

/**
 * Why the record cannot be trusted, said only from what was actually checked.
 *
 * The absent case used to read "nació antes de que existiera el registro", which
 * is a BIRTH DATE inferred from a missing file — and a folder created by hand
 * today gets the same sentence. What the reading proves is narrower and enough:
 * the file is not in the folder. Whether it was never written, was deleted or was
 * never going to exist is not knowable from here, and stating one of them as fact
 * sends the reader to look for a cause that may not be theirs.
 */
function custodyGap(read: CustodyRead): string | null {
  if (read.status === "absent") {
    return `no hay registro de custodia en la carpeta de la sesión (falta '${CUSTODY_FILE}')`;
  }
  if (read.status === "unreadable") return read.reason;
  const verdict = custodyCompleteness(read.custody);
  if (verdict.complete) return null;
  return verdict.gaps.map((g) => `${g.what}: ${g.why}`).join("; ");
}

/**
 * Whether a session converged, from the only two things that can say so.
 *
 * The run state is the direct answer: a journey with no boundary pending has
 * nothing left to do. The artifact is the indirect one, and it is needed because a
 * session may have run without a flow: a plan that reads `done` was carried to its
 * end by SOMETHING, and treating the session that did it as resettable would undo
 * delivered work. `.closed` is deliberately NOT consulted — a session closed with
 * work pending is exactly the case reset exists for.
 */
async function completionOf(
  deps: GraphDeps,
  session: IndexedSession,
  read: CustodyRead,
  canon: CoreDocsCanon,
): Promise<SessionCompletion> {
  const run = await readRun(deps.fs, locateRun(deps.paths, session.folder));
  if (run.ok) return run.state.boundary === null ? "converged" : "incomplete";
  if (read.status !== "present") return "unknown";
  return (await artifactConverged(deps, read.custody, canon)) ? "converged" : "incomplete";
}

/**
 * Whether the document this session was working on already reached its end.
 *
 * Read from the document itself rather than from the board's summary, because
 * this is the guard that decides a destructive question and it should not depend
 * on a projection that may have been built for another purpose.
 */
async function artifactConverged(
  deps: GraphDeps,
  custody: SessionCustody,
  canon: CoreDocsCanon = DEFAULT_CORE_DOCS_CANON,
): Promise<boolean> {
  for (const parent of custody.parents) {
    const path = docPathOf(deps, custody, parent, canon);
    if (path === null) continue;
    let text: string;
    try {
      text = await deps.fs.readText(path);
    } catch {
      continue;
    }
    if (parent.kind === "plan" && /^>\s*Estado:\s*done\s*$/m.test(text)) return true;
    if (parent.kind === "spec" && /^status:\s*ready-for-plan\s*$/m.test(text)) return true;
  }
  return false;
}

/** The absolute path of a parent document, as the custody itself recorded it. */
function docPathOf(
  deps: GraphDeps,
  custody: SessionCustody,
  parent: WorklineNodeId,
  canon: CoreDocsCanon = DEFAULT_CORE_DOCS_CANON,
): string | null {
  const artifact = custody.artifacts.find((a) => {
    const node = nodeFromDocPath(a.path, canon);
    return node !== null && node.kind === parent.kind && node.key === parent.key;
  });
  return artifact === undefined ? null : join(deps.paths.workspaceDir(), artifact.path);
}
