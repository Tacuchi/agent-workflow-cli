import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { DesignGraph } from "./design/design-graph-service.js";
import type { PathsService } from "./paths-service.js";
import {
  type IndexedDiscarded,
  type IndexedPlan,
  type IndexedSpec,
  type IndexedWorkspace,
  type PipelineItem,
  buildWorklineIndex,
} from "./workline-index-service.js";

/**
 * `status` projected out of the Workline index.
 *
 * The reading itself lives in `workline-index-service` — this module only
 * shapes it for one command, so `status` and `resume` can never answer the
 * same question differently. Everything here is derivation; nothing re-reads
 * the filesystem and nothing writes to it.
 */

export type { PipelineItem } from "./workline-index-service.js";

export interface StatusSession {
  code: string | null;
  folder: string;
  type: string | null;
  summary: string;
  date: string;
  relative: string;
}

export interface StatusOutput {
  workspace: IndexedWorkspace;
  specs: IndexedSpec[];
  plans: IndexedPlan[];
  sessions: {
    active: StatusSession[];
    closed: StatusSession[];
  };
  discarded: IndexedDiscarded[];
  /** what is left to do, in priority order — the same list `resume` routes from */
  pipeline: PipelineItem[];
  /** the design traceability graph, so a broken reference is visible without opening files */
  designs: DesignGraph;
  counts: {
    specs: number;
    specs_refined: number;
    plans: number;
    sessions_active: number;
    sessions_closed: number;
    discarded: number;
    pending: number;
  };
}

export interface StatusInput {
  now?: Date;
}

/**
 * Read-only whole-workspace status aggregator. Never throws on a reachable cwd:
 * an uninitialized workspace returns `initialized:false` with empty collections;
 * a single unreadable file is skipped rather than tanking the command.
 */
export async function runStatusCommand(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: StatusInput = {},
): Promise<StatusOutput> {
  const index = await buildWorklineIndex(fs, env, paths, input);

  const active: StatusSession[] = [];
  const closed: StatusSession[] = [];
  for (const session of index.sessions) {
    (session.state === "closed" ? closed : active).push({
      code: session.code,
      folder: session.folder,
      type: session.type,
      summary: session.summary,
      date: session.date,
      relative: session.relative,
    });
  }

  return {
    workspace: index.workspace,
    specs: index.specs,
    plans: index.plans,
    sessions: { active, closed },
    discarded: index.discarded,
    pipeline: index.pipeline,
    designs: index.designs,
    counts: {
      specs: index.specs.length,
      specs_refined: index.specs.filter((s) => s.refined).length,
      plans: index.plans.length,
      sessions_active: active.length,
      sessions_closed: closed.length,
      discarded: index.discarded.length,
      pending: index.pipeline.length,
    },
  };
}
