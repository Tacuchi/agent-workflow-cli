/**
 * Where a document comes from, and where it stands.
 *
 * Four questions, one derivation. Given a plan: what spec it is born of, which
 * plans are its siblings in the same cut, and which pass each of them points at.
 * Given a spec: which plans it became, and in what order somebody meant to run
 * them. And for either: whether it is in production, still waiting for a pass, or
 * predates the record entirely.
 *
 * One derivation on purpose. The provenance graph already proved descent, the cut
 * intent already carries the grouping and the order, and the pass ledger already
 * knows what arrived — three readings that, computed separately by each surface,
 * would be three chances to disagree about the same document.
 *
 * The third production answer is the one that needed the most care. `no-record`
 * is not `pending-pass`: a plan closed before this book existed was never going to
 * be named by it, and calling it "waiting for a pass" invents a backlog out of
 * history — while calling it released would claim something nobody recorded.
 */

import type { CutIntentReading, CutPosition } from "../domain/cut-intent.js";
import { type WorklineNodeId, formatNodeId } from "../domain/workline-node.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import {
  type CutIntentEvent,
  type CutIntentRead,
  currentIntentOf,
  readCutIntents,
  readingForPlan,
} from "./cut-intent-ledger.js";
import type { PathsService } from "./paths-service.js";
import {
  type DerivedPass,
  type ProductionStanding,
  derivePasses,
  foldProduction,
  productionStandingOf,
  readReleasePasses,
} from "./release-pass-ledger.js";
import { type WorklineGraph, buildWorklineGraph } from "./workline-graph.js";

export interface LineageDeps {
  fs: FileSystemPort;
  env: EnvPort;
  paths: PathsService;
  git?: GitPort;
}

/** Everything the two readings share, read once. */
export interface LineageContext {
  graph: WorklineGraph;
  intents: CutIntentRead;
  passes: DerivedPass[];
}

export async function readLineageContext(deps: LineageDeps): Promise<LineageContext> {
  const { graph } = await buildWorklineGraph({
    fs: deps.fs,
    env: deps.env,
    paths: deps.paths,
    ...(deps.git !== undefined ? { git: deps.git } : {}),
  });
  const intents = await readCutIntents(deps.fs, deps.paths);
  const passes = derivePasses((await readReleasePasses(deps.fs, deps.paths)).events);
  return { graph, intents, passes };
}

export interface SiblingStanding {
  plan: string;
  /** Its declared place in the cut, or `unmentioned` when the cut omits it. */
  placement: CutPosition["placement"];
  /** Only for a sibling in the pass in progress: its 0-based position. */
  index?: number;
  production: ProductionStanding;
}

export interface PlanLineage {
  plan: string;
  /** The spec it declares it descends from, with the evidence that proves it. */
  spec: { id: string; path: string | null; evidence: string } | null;
  /** Its declared place in the cut — explicit, never an empty list. */
  cut: CutIntentReading;
  /** Its siblings in the same cut, in declared order then the deferred. */
  siblings: SiblingStanding[];
  production: ProductionStanding;
}

/**
 * The plan's answer: origin, siblings, and where each one stands.
 *
 * The parent comes from the graph and not from the intent, because descent is
 * provable and grouping is declared: a cut that named the wrong spec would not
 * change which spec a plan was derived from.
 */
export function lineageOfPlan(context: LineageContext, plan: WorklineNodeId): PlanLineage {
  const parents = context.graph.parentsOf(plan).filter((edge) => edge.to.kind === "spec");
  const parent = parents[0];
  const spec =
    parent === undefined
      ? null
      : {
          id: formatNodeId(parent.to),
          path: context.graph.get(parent.to)?.path ?? null,
          evidence: parent.evidence,
        };
  const cut = readingForPlan(context.intents, plan);
  return {
    plan: formatNodeId(plan),
    spec,
    cut,
    siblings: siblingsOf(context, plan),
    production: productionStandingOf(context.passes, plan),
  };
}

function siblingsOf(context: LineageContext, plan: WorklineNodeId): SiblingStanding[] {
  const reading = readingForPlan(context.intents, plan);
  if (!reading.declared) return [];
  const key = formatNodeId(plan);
  const standings: SiblingStanding[] = [];
  reading.intent.order.forEach((node, index) => {
    if (formatNodeId(node) === key) return;
    standings.push({
      plan: formatNodeId(node),
      placement: "in-pass",
      index,
      production: productionStandingOf(context.passes, node),
    });
  });
  for (const node of reading.intent.deferred) {
    if (formatNodeId(node) === key) continue;
    standings.push({
      plan: formatNodeId(node),
      placement: "deferred",
      production: productionStandingOf(context.passes, node),
    });
  }
  return standings;
}

export interface SpecLineage {
  spec: string;
  /** Every plan the graph proves descends from it, whatever the cut says. */
  plans: Array<{ plan: string; path: string | null; production: ProductionStanding }>;
  /** The declared order and the deferred, or `null` when nobody declared a cut. */
  declared: { at: string; order: string[]; deferred: string[] } | null;
  production: ProductionStanding;
}

/**
 * The spec's answer: what it became, and in what order somebody meant to run it.
 *
 * `plans` comes from the graph — every proven child — while `declared` comes from
 * the intent. Keeping them apart is what lets a reader see a plan that descends
 * from this spec and that the cut does not mention, which is a real and
 * legitimate state and not a contradiction.
 */
export function lineageOfSpec(context: LineageContext, spec: WorklineNodeId): SpecLineage {
  const children = context.graph
    .childrenOf(spec)
    .filter((edge) => edge.from.kind === "plan")
    .map((edge) => ({
      plan: formatNodeId(edge.from),
      path: context.graph.get(edge.from)?.path ?? null,
      production: productionStandingOf(context.passes, edge.from),
    }));
  const current: CutIntentEvent | null = currentIntentOf(context.intents.events, spec);
  return {
    spec: formatNodeId(spec),
    plans: children,
    declared:
      current === null
        ? null
        : {
            at: current.at,
            order: current.intent.order.map(formatNodeId),
            deferred: current.intent.deferred.map(formatNodeId),
          },
    production: foldProduction(children.map((child) => child.production)),
  };
}
