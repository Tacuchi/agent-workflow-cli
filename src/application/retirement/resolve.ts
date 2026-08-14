/**
 * From "what did they name" to "exactly which nodes come out", or a refusal.
 *
 * Everything here is read-only and every refusal is actionable: a destructive
 * command that answers "no" without saying which candidates it saw, or which edge
 * it could not prove, forces the person to guess — and guessing is what the whole
 * design exists to prevent. So each rejection carries its code, the candidates and
 * the one next move.
 *
 * The two modes ask genuinely different questions and share only the graph:
 *
 * - **discard** asks "what does this node OWN, transitively and exclusively?"
 *   Anything reachable through a provable edge comes out with it; a node that also
 *   belongs to something outside the closure stops the whole operation.
 * - **reset** asks "which single INCOMPLETE session is this, and what did it
 *   receive?" It never cascades: work that descends from what the session produced
 *   would be orphaned, so its presence is a refusal rather than a wider closure.
 */

import type { ClosureEntry, RetirementMode } from "../../domain/retirement/proposal.js";
import { type TargetSelector, selectorText } from "../../domain/retirement/selector.js";
import {
  type WorklineEdge,
  type WorklineNodeId,
  formatNodeId,
} from "../../domain/workline-node.js";
import type { GraphNode, RetirementGraph } from "./graph.js";

export type RejectionCode =
  | "TARGET_NOT_FOUND"
  | "TARGET_AMBIGUOUS"
  | "EVIDENCE_MISSING"
  | "SHARED_CONSUMER"
  | "CYCLIC_PROVENANCE"
  | "RESET_NO_INCOMPLETE_SESSION"
  | "RESET_AMBIGUOUS_SESSION"
  | "RESET_SESSION_CONVERGED";

export interface RetirementRejection {
  code: RejectionCode;
  message: string;
  /** What the person can choose between, when the refusal is a choice. */
  candidates: string[];
  action: string;
}

export type TargetResolution =
  | { ok: true; node: GraphNode }
  | { ok: false; rejection: RetirementRejection };

/**
 * The node a selector names, or the candidates that make it ambiguous.
 *
 * A bare number is the only form that can be ambiguous by construction, and it is
 * accepted at all because typing `plan:` in front of the number every time is
 * ceremony when only one node answers. The moment two do, the ambiguity is the
 * answer.
 */
export function resolveTarget(graph: RetirementGraph, selector: TargetSelector): TargetResolution {
  const matches = candidatesFor(graph, selector);
  if (matches.length === 1 && matches[0] !== undefined) return { ok: true, node: matches[0] };
  if (matches.length === 0) {
    return {
      ok: false,
      rejection: {
        code: "TARGET_NOT_FOUND",
        message: `no existe ningún nodo que coincida con '${selectorText(selector)}'`,
        candidates: [],
        action: "revisá `aw status` y reintentá con una identidad existente",
      },
    };
  }
  return {
    ok: false,
    rejection: {
      code: "TARGET_AMBIGUOUS",
      message: `'${selectorText(selector)}' coincide con ${matches.length} nodos`,
      candidates: matches.map((n) => formatNodeId(n.id)),
      action:
        "reintentá con la forma explícita: spec:<NNN>, plan:<PPP>, quick:<NNN> o session:<carpeta>",
    },
  };
}

function candidatesFor(graph: RetirementGraph, selector: TargetSelector): GraphNode[] {
  switch (selector.form) {
    case "path":
      return graph.all().filter((n) => n.path === selector.path);
    case "folder":
      return graph
        .all()
        .filter((n) => n.kind === "session" && n.session?.folder === selector.folder);
    case "qualified":
      return selector.kind === "quick"
        ? quickCandidates(graph, selector.key)
        : graph.all().filter((n) => n.kind === selector.kind && matchesKey(n, selector.key));
    case "bare":
      return graph.all().filter((n) => matchesKey(n, selector.key));
  }
}

/**
 * `quick:<NNN>` addresses a SESSION whose flow was the quick one.
 *
 * A quick has no document of its own, so it is not a node kind — it is a session
 * with a type. Keeping it out of the graph's vocabulary and in the selector's is
 * what stops the graph from having a fourth kind that owns nothing.
 */
function quickCandidates(graph: RetirementGraph, key: string): GraphNode[] {
  return graph
    .all()
    .filter((n) => n.kind === "session" && n.session?.type === "quick" && matchesKey(n, key));
}

/** A session answers to its number as well as to its folder; a doc only to its number. */
function matchesKey(node: GraphNode, key: string): boolean {
  if (node.kind !== "session") return node.id.key === key;
  const folder = node.session?.folder ?? node.id.key;
  return folder === key || folder.startsWith(`${key}-`) || folder.startsWith(`session${key}-`);
}

export interface ResolvedClosure {
  mode: RetirementMode;
  target: GraphNode;
  /** In removal order: descendants first, so nothing is left pointing at a hole. */
  entries: Array<{ node: GraphNode; reason: ClosureEntry["reason"] }>;
}

export type ClosureResolution =
  | { ok: true; closure: ResolvedClosure }
  | { ok: false; rejection: RetirementRejection };

/**
 * Everything a discard takes with it, or the reason it takes nothing.
 *
 * The walk only ever follows PROVABLE edges, and it checks two things about each
 * node it reaches: that its own custody can still say what it owns, and that
 * nothing outside the closure descends from it. The second check is what makes
 * "exclusive ownership" a computed fact — a session that belongs to two plans is
 * not a descendant of either, it is shared work, and the operation stops.
 */
export function resolveDiscardClosure(
  graph: RetirementGraph,
  target: GraphNode,
): ClosureResolution {
  const walked = walkDescendants(graph, target);
  if ("rejection" in walked) return { ok: false, rejection: walked.rejection };

  const shared = sharedConsumer(graph, walked.collected);
  if (shared !== null) return { ok: false, rejection: shared };
  const missing = missingEvidence([...walked.collected.values()].map((e) => e.node));
  if (missing !== null) return { ok: false, rejection: missing };

  return {
    ok: true,
    closure: { mode: "discard", target, entries: removalOrder([...walked.collected.values()]) },
  };
}

type Collected = Map<string, { node: GraphNode; reason: ClosureEntry["reason"] }>;

/**
 * The breadth-first walk down the provable edges, or the first edge that stops it.
 *
 * Separated from the checks that follow it because the two ask different
 * questions: this one is "what hangs off the target", and the ones after it are
 * "may we take all of that". Reading them together is what made a single function
 * hard to hold in the head.
 */
function walkDescendants(
  graph: RetirementGraph,
  target: GraphNode,
): { collected: Collected } | { rejection: RetirementRejection } {
  const collected: Collected = new Map();
  collected.set(formatNodeId(target.id), { node: target, reason: "target" });

  const pending: WorklineNodeId[] = [target.id];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift() as WorklineNodeId;
    const key = formatNodeId(current);
    if (seen.has(key)) continue;
    seen.add(key);

    // An edge nobody can prove cannot be followed AND cannot be ignored: the node
    // on its other end may or may not belong here, and both answers are guesses.
    const unprovable = graph.unprovableInto(current);
    if (unprovable.length > 0) return { rejection: unprovableEdges(key, unprovable) };

    const rejection = collectChildren(graph, current, collected, pending);
    if (rejection !== null) return { rejection };
  }
  return { collected };
}

/** One node's children into the closure, or the cycle that has no removal order. */
function collectChildren(
  graph: RetirementGraph,
  parent: WorklineNodeId,
  collected: Collected,
  pending: WorklineNodeId[],
): RetirementRejection | null {
  const parentKey = formatNodeId(parent);
  for (const edge of graph.childrenOf(parent)) {
    const child = graph.get(edge.from);
    if (child === undefined) continue;
    const childKey = formatNodeId(child.id);
    if (childKey === parentKey) return cyclic(childKey);
    if (!collected.has(childKey)) {
      collected.set(childKey, {
        node: child,
        reason: child.kind === "session" ? "internal-session" : "descendant",
      });
    }
    pending.push(child.id);
  }
  return null;
}

function unprovableEdges(key: string, edges: readonly WorklineEdge[]): RetirementRejection {
  return {
    code: "EVIDENCE_MISSING",
    message: `'${key}' tiene descendientes cuya procedencia no se puede probar`,
    candidates: edges.map((e) => `${formatNodeId(e.from)} (${e.evidence})`),
    action:
      "esas sesiones nacieron sin custodia: retirálas individualmente por su carpeta, o dejá el objetivo como está",
  };
}

/**
 * A node inside the closure that something OUTSIDE also descends from.
 *
 * Counted over the closure's own members rather than over the target alone,
 * because the sharing that matters can be two levels down: a session that hangs
 * off both the plan being discarded and another one is not the target's to delete,
 * even though the target never mentions it.
 */
function sharedConsumer(
  graph: RetirementGraph,
  collected: Map<string, { node: GraphNode; reason: ClosureEntry["reason"] }>,
): RetirementRejection | null {
  for (const { node } of collected.values()) {
    for (const edge of graph.parentsOf(node.id)) {
      if (collected.has(formatNodeId(edge.to))) continue;
      // A parent outside the closure is normal for the TARGET itself — that is
      // what it hangs from. It is only sharing when the node came in as a
      // descendant, because then two things own it.
      const entry = collected.get(formatNodeId(node.id));
      if (entry?.reason === "target") continue;
      return {
        code: "SHARED_CONSUMER",
        message: `'${formatNodeId(node.id)}' también pertenece a '${formatNodeId(edge.to)}', fuera del alcance`,
        candidates: [formatNodeId(node.id), formatNodeId(edge.to)],
        action:
          "el alcance no es de propiedad exclusiva: retirá primero el consumidor compartido o elegí un objetivo más chico",
      };
    }
  }
  return null;
}

/** A session in the closure whose custody cannot say what it owns. */
function missingEvidence(nodes: readonly GraphNode[]): RetirementRejection | null {
  for (const node of nodes) {
    const gap = node.session?.custody_gap ?? null;
    if (gap === null) continue;
    return {
      code: "EVIDENCE_MISSING",
      message: `'${formatNodeId(node.id)}' no tiene una custodia reconstruible: ${gap}`,
      candidates: [formatNodeId(node.id)],
      action:
        "sin baseline no se puede probar qué le pertenece: cerrá o retirá esa sesión a mano antes de retirar el objetivo",
    };
  }
  return null;
}

function cyclic(key: string): RetirementRejection {
  return {
    code: "CYCLIC_PROVENANCE",
    message: `la procedencia de '${key}' se cierra sobre sí misma`,
    candidates: [key],
    action: "corregí la procedencia declarada antes de retirar: un ciclo no tiene orden de retiro",
  };
}

/**
 * Sessions first, then documents, deepest first.
 *
 * Removal order is material — it is in the seal — because a document removed
 * before the sessions that point at it leaves, for as long as the operation runs,
 * a session whose provenance resolves to nothing.
 */
function removalOrder(
  entries: Array<{ node: GraphNode; reason: ClosureEntry["reason"] }>,
): Array<{ node: GraphNode; reason: ClosureEntry["reason"] }> {
  const rank = (entry: { node: GraphNode; reason: ClosureEntry["reason"] }): number => {
    if (entry.node.kind === "session") return 0;
    if (entry.reason === "target") return 2;
    return 1;
  };
  return [...entries].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return formatNodeId(a.node.id) < formatNodeId(b.node.id) ? -1 : 1;
  });
}

/**
 * The single incomplete session a reset target names.
 *
 * A session can be named directly; a document names one only when exactly one of
 * its sessions is incomplete. Both roads end in the same requirement, and the
 * assumption behind it is explicit in the spec: a FINISHED session does not become
 * resettable by being selected.
 */
export function resolveResetSession(graph: RetirementGraph, target: GraphNode): TargetResolution {
  if (target.kind === "session") {
    const facts = target.session;
    if (facts === null) return { ok: false, rejection: noIncomplete(formatNodeId(target.id)) };
    if (facts.completion === "converged") {
      return {
        ok: false,
        rejection: {
          code: "RESET_SESSION_CONVERGED",
          message: `la sesión '${facts.folder}' ya convergió: no es una sesión incompleta`,
          candidates: [facts.folder],
          action:
            "para retirarla junto con lo que produjo usá `aw discard`; `reset` sólo vuelve atrás lo inconcluso",
        },
      };
    }
    if (facts.completion === "unknown") {
      return {
        ok: false,
        rejection: {
          code: "EVIDENCE_MISSING",
          message: `no se puede probar hasta dónde llegó '${facts.folder}': ${facts.custody_gap ?? "sin evidencia"}`,
          candidates: [facts.folder],
          action: "es una sesión legacy: no hay baseline que restaurar, y reset no lo inventa",
        },
      };
    }
    return { ok: true, node: target };
  }

  const sessions = graph.sessionsOf(target.id);
  const incomplete = sessions.filter((s) => s.session?.completion === "incomplete");
  if (incomplete.length === 1 && incomplete[0] !== undefined) {
    return resolveResetSession(graph, incomplete[0]);
  }
  if (incomplete.length === 0) {
    return { ok: false, rejection: noIncomplete(formatNodeId(target.id), sessions) };
  }
  return {
    ok: false,
    rejection: {
      code: "RESET_AMBIGUOUS_SESSION",
      message: `'${formatNodeId(target.id)}' tiene ${incomplete.length} sesiones incompletas`,
      candidates: incomplete.map((s) => s.session?.folder ?? formatNodeId(s.id)),
      action: "nombrá la sesión exacta con session:<carpeta>",
    },
  };
}

function noIncomplete(target: string, seen: readonly GraphNode[] = []): RetirementRejection {
  return {
    code: "RESET_NO_INCOMPLETE_SESSION",
    message: `'${target}' no resuelve a ninguna sesión incompleta`,
    candidates: seen.map(
      (s) => `${s.session?.folder ?? formatNodeId(s.id)} (${s.session?.completion ?? "?"})`,
    ),
    action: "reset necesita una sesión que no haya convergido; revisá `aw status --detail`",
  };
}

/**
 * What a reset takes out: the session, plus the documents it BORN.
 *
 * It stops at one level on purpose. A document this session created that already
 * has work of its own is not something a reset may remove — that work would be
 * orphaned — so its presence is a refusal, which is the same rule discard applies
 * to shared ownership, read from the other direction.
 */
export function resolveResetClosure(graph: RetirementGraph, session: GraphNode): ClosureResolution {
  const entries: Array<{ node: GraphNode; reason: ClosureEntry["reason"] }> = [
    { node: session, reason: "target" },
  ];
  const custody = session.session?.custody ?? null;
  if (custody === null) {
    return {
      ok: false,
      rejection: {
        code: "EVIDENCE_MISSING",
        message: `'${formatNodeId(session.id)}' no tiene custodia: no hay salidas ni entradas que probar`,
        candidates: [formatNodeId(session.id)],
        action: "es una sesión legacy: retirala a mano o usá discard sobre su carpeta",
      },
    };
  }

  for (const artifact of custody.artifacts) {
    if (artifact.role !== "output") continue;
    const node = graph.all().find((n) => n.path === artifact.path);
    if (node === undefined) continue;
    const others = graph
      .childrenOf(node.id)
      .filter((e) => formatNodeId(e.from) !== formatNodeId(session.id));
    if (others.length > 0) {
      return {
        ok: false,
        rejection: {
          code: "SHARED_CONSUMER",
          message: `'${artifact.path}' ya tiene trabajo que depende de él`,
          candidates: others.map((e) => formatNodeId(e.from)),
          action:
            "retirá primero ese trabajo, o usá discard sobre el documento si querés llevártelo todo",
        },
      };
    }
    entries.push({ node, reason: "descendant" });
  }

  return { ok: true, closure: { mode: "reset", target: session, entries: removalOrder(entries) } };
}
