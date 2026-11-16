/**
 * Execution-resource policy owned by the CLI.
 *
 * A host may provide richer machinery (subagents, orchestration, token
 * accounting), but it never decides when agent-workflow spends it. The caller brings
 * facts about the work; this module returns the one bounded strategy that is
 * admissible. Keeping that rule here prevents every loop and host wrapper from
 * growing its own "small task" heuristic.
 */

export const MAX_SUBAGENTS = 3;

export type ResourceBoundary =
  | "deterministic"
  | "semantic"
  | "human"
  | "authorization"
  | "execution"
  | "blocked"
  | "final";

export interface HostExecutionCapability {
  /** Whether this host can dispatch isolated model workers. */
  subagents: "none" | "parallel";
  /** Maximum workers the host can safely run, excluding the coordinator. */
  max_subagents: number;
  /** Concrete host primitive, or null when the universal inline floor applies. */
  mechanism: string | null;
}

/** A semantic partition the host proposes to delegate. */
export interface ResourcePartition {
  id: string;
  /** Durable paths the worker may write. Empty means read-only research/review. */
  writes: readonly string[];
  /** Other partition ids that must finish first. */
  depends_on: readonly string[];
}

export interface ResourcePlan {
  boundary: ResourceBoundary;
  strategy: "none" | "inline" | "parallel";
  model_workers: number;
  max_subagents: number;
  max_external_processes: number;
  reason: string;
}

export interface ResourceDecisionInput {
  boundary: ResourceBoundary;
  host: HostExecutionCapability;
  partitions?: readonly ResourcePartition[];
}

/**
 * Computes the cheapest safe strategy. Deterministic work has no model worker;
 * a semantic boundary gets one main worker unless three independent partitions
 * and a capable host justify the coordination overhead.
 */
export function decideResources(input: ResourceDecisionInput): ResourcePlan {
  if (input.boundary === "deterministic") {
    return {
      boundary: input.boundary,
      strategy: "none",
      model_workers: 0,
      max_subagents: 0,
      max_external_processes: 0,
      reason: "el CLI resuelve este tramo internamente",
    };
  }
  if (input.boundary === "execution") {
    return {
      boundary: input.boundary,
      strategy: "none",
      model_workers: 0,
      max_subagents: 0,
      max_external_processes: 1,
      reason: "la acción delegada se ejecuta una vez y devuelve evidencia",
    };
  }
  if (input.boundary !== "semantic") {
    return {
      boundary: input.boundary,
      strategy: "none",
      model_workers: 0,
      max_subagents: 0,
      max_external_processes: 0,
      reason: "esta frontera espera una decisión, autorización o resolución",
    };
  }

  const partitions = input.partitions ?? [];
  const workerLimit = Math.min(MAX_SUBAGENTS, Math.max(0, input.host.max_subagents));
  if (input.host.subagents === "parallel" && workerLimit > 0 && independentlyParallel(partitions)) {
    const workers = Math.min(workerLimit, partitions.length);
    return {
      boundary: input.boundary,
      strategy: "parallel",
      model_workers: 1 + workers,
      max_subagents: workers,
      max_external_processes: 0,
      reason: `${partitions.length} particiones semánticas independientes justifican coordinación`,
    };
  }
  return {
    boundary: input.boundary,
    strategy: "inline",
    model_workers: 1,
    max_subagents: 0,
    max_external_processes: 0,
    reason: "la frontera semántica no alcanza el umbral seguro de paralelismo",
  };
}

function independentlyParallel(partitions: readonly ResourcePartition[]): boolean {
  if (partitions.length < 3) return false;
  const ids = new Set<string>();
  const writes = new Set<string>();
  for (const partition of partitions) {
    if (
      partition.id.trim().length === 0 ||
      ids.has(partition.id) ||
      partition.depends_on.length > 0
    )
      return false;
    ids.add(partition.id);
    for (const path of partition.writes) {
      if (writes.has(path)) return false;
      writes.add(path);
    }
  }
  return true;
}
