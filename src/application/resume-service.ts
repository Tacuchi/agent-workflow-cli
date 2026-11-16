import { coreDocumentLocations } from "../domain/docs-canon.js";
import type { FlowRunScope } from "../domain/flow/run-state.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import {
  type AgentWorkflowIndex,
  type IndexedPlan,
  type IndexedSpec,
  type PipelineAction,
  type PipelineItem,
  type PipelineItemDetail,
  type SessionUnit,
  type UnreadableSource,
  buildAgentWorkflowIndex,
  pipelineTie,
  planIsPending,
  planPresentation,
  specDetail,
} from "./agent-workflow-index-service.js";
import { readHubBlock } from "./parsers/hub-block.js";
import type { PathsService } from "./paths-service.js";

/**
 * `resume` — what to pick up, and the exact command that continues it.
 *
 * It decides from the same agent-workflow index `status` projects, so the two can
 * never disagree about what is pending. Two hard rules:
 *
 * - **It never executes the route it proposes.** The command comes back as a
 *   string for the human to run.
 * - **It never writes.** Session targets resolve with `bind: false`, so reading
 *   what to resume does not silently claim the conversation for that session.
 */

export interface ResumeInput {
  /** A doc path (`docs/plans/009-…md`) or a bare document number. */
  target?: string;
  now?: Date;
  /** Read isolation units too, so two concurrent flows are told apart. */
  git?: GitPort;
}

export interface ResumeProposal {
  kind: PipelineItem["kind"] | "session";
  /** hub-relative doc path, or the session folder */
  file: string;
  number: string | null;
  objective: string;
  progress: string;
  /** the next pending step, or what the work is waiting on */
  next: string;
  /** The same typed route the status pipeline exposes. */
  action: PipelineAction;
  /** Compatibility projection of `action`; `null` when the item is blocked. */
  command: string | null;
  /** A non-blocking compatibility caveat, shown only with `--detail`. */
  warning?: { code: string; message: string };
  /**
   * Why a declared cut put this after something that has not landed.
   *
   * Carried separately from `warning` because the two can collide: `warning` is
   * one field, and when the document has a defect of its own — an unsealed
   * baseline, an unverified closure — the order advisory yields it. Without this
   * key the reason would then reach `status` and vanish on `resume`, so the same
   * plan would be explained on one surface and silently demoted on the other.
   */
  postponed?: { reason: string; waiting_on: string[] };
  /**
   * Isolation units this flow edits in. Present only when it took some — which
   * is what tells two concurrent flows apart: without it `resume` proposes the
   * same next step to both and neither learns which tree is its own.
   */
  units?: SessionUnit[];
  /**
   * The plan this run executes and the sources it may edit, when it fixed them.
   *
   * The other half of telling two runs apart, and the half that survives a
   * released unit: the units say which trees are held right now, the scope says
   * which plan the session belongs to at all. Both come from the same reading
   * `status` projects — never a second derivation.
   */
  scope?: FlowRunScope;
  /**
   * Uncommitted changes in each source the plan declares, read from git when
   * the plan is `in-progress` (spec 066, AC-03): what a crash mid-batch left
   * behind is in the working trees, not in any record of the run.
   */
  uncommitted?: SourceChanges[];
}

/** The working-tree state of one source of a plan being executed. */
export interface SourceChanges {
  alias: string;
  path: string | null;
  /** `git status` paths, as git spells them; empty when the tree is clean. */
  changes: string[];
  /** Why the source could not be inspected, when it could not. */
  error?: string;
}

export type ResumeOutcome = (
  | {
      status: "proposal";
      via: "explicit" | "pipeline";
      proposal: ResumeProposal;
      /**
       * Every pending item, in the order the CLI decided — present only on the
       * pipeline route, where there is a pipeline to offer. `proposal` stays the
       * recommendation, so a caller that only ever read it keeps reading it.
       */
      candidates?: ResumeProposal[];
    }
  | { status: "candidates"; candidates: ResumeProposal[]; action: string }
  | { status: "idle"; action: string }
  | { status: "invalid_target"; target: string; action: string }
) & {
  unreadable_sources?: UnreadableSource[];
  isolation_error?: string;
  ready_to_close?: Array<{ session: string; command: string }>;
  paused_sessions?: string[];
  abandoned_sessions?: string[];
};

export async function runResume(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: ResumeInput = {},
): Promise<ResumeOutcome> {
  const index = await buildAgentWorkflowIndex(fs, env, paths, {
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.git !== undefined ? { git: input.git } : {}),
  });

  if (index.docs_canon_error !== undefined) {
    return {
      status: "invalid_target",
      target: input.target ?? "",
      action: `el canon documental no es válido: ${index.docs_canon_error}. Corregilo antes de reanudar trabajo`,
    };
  }

  const outcome =
    input.target !== undefined ? resumeTarget(index, input.target) : resumePipeline(index);

  const withChanges = await attachUncommitted(fs, paths, index, outcome, input.git);
  return {
    ...withChanges,
    ...(index.unreadable_sources !== undefined
      ? { unreadable_sources: index.unreadable_sources }
      : {}),
    ...(index.isolation_error !== undefined ? { isolation_error: index.isolation_error } : {}),
  };
}

// ── explicit target ──────────────────────────────────────────────────────────

/**
 * An explicit target wins over the pipeline, and matches by exact path or by
 * document number — **never by slug**, which is how the old survey attached a
 * session to the wrong plan. A number that names both a spec and a plan is a
 * genuine tie, so it comes back as candidates, the same answer the pipeline
 * gives for any other tie.
 */
function resumeTarget(index: AgentWorkflowIndex, target: string): ResumeOutcome {
  const specs = index.specs.filter(
    (s) => s.status !== "superseded" && (s.file === target || s.number === target),
  );
  const allPlans = index.plans.filter((p) => p.file === target || p.number === target);
  // La misma regla de pertenencia que usa el pipeline, y por eso importada: un
  // plan cerrado con traspaso vigente es trabajo pendiente en las dos
  // superficies o en ninguna, nunca en una sola.
  const plans = allPlans.filter(planIsPending);

  const matches: ResumeProposal[] = [
    ...specs.map((s) => specProposal(s, index)),
    ...plans.map((plan) => planProposal(plan)),
  ];

  const [first] = matches;
  if (first === undefined) {
    const replaced = index.specs.find(
      (s) => s.status === "superseded" && (s.file === target || s.number === target),
    );
    if (replaced !== undefined) {
      return { status: "invalid_target", target, action: specDetail(replaced, index.plans).next };
    }
    const [historical] = allPlans;
    if (historical !== undefined) {
      return {
        status: "invalid_target",
        target,
        action:
          historical.assurance !== null && historical.assurance !== "verified"
            ? `el plan '${historical.file}' está complete · ${historical.assurance}: no es trabajo pendiente, pero su evidencia omitida o sustituta no se presenta como aprobada; consultá el riesgo aceptado`
            : `el plan '${historical.file}' ya está cerrado: es histórico y no genera deuda de baseline; elegí un documento pendiente o consultá su evidencia`,
      };
    }
    return {
      status: "invalid_target",
      target,
      action: `ningún documento coincide con '${target}': pasá una ruta bajo ${coreDocumentLocations()} o el número, o usá --code para una sesión`,
    };
  }
  if (matches.length > 1) {
    return {
      status: "candidates",
      candidates: matches,
      action: `'${target}' identifica ${matches.length} documentos: repetí con la ruta completa`,
    };
  }
  return { status: "proposal", via: "explicit", proposal: first };
}

// ── no target: the documental pipeline ───────────────────────────────────────

/**
 * The whole pipeline comes back as candidates, in the order the CLI decided.
 *
 * It used to offer only the head and its ties, so the open plans below them were
 * pending work `status` listed and `resume` never named — and choosing what to
 * pick up meant reading one surface and typing from the other. Priority and the
 * tie-break are untouched: what a tie still changes is whether one item can be
 * called the recommendation at all.
 */
export function resumePipeline(index: AgentWorkflowIndex): ResumeOutcome {
  const [head] = index.pipeline;
  if (head === undefined) {
    return { status: "idle", action: "no hay trabajo pendiente: el pipeline está vacío" };
  }
  const candidates = index.pipeline.map((item) => pipelineProposal(item));

  // A tie is the CLI's rule, read and not re-derived. Two items that reach here
  // are equally next, and picking one for the user is what this replaces — but
  // two that a declared cut already separated are not tied at all, and spelling
  // the rule a second time here is how this surface would come to disagree with
  // the board it projects.
  const tied = index.pipeline.filter((item) => pipelineTie(item, head));
  if (tied.length > 1) {
    return {
      status: "candidates",
      candidates,
      action: `${tied.length} candidatos empatados en cabeza sobre ${candidates.length} pendientes: elegí uno y volvé a invocar con su ruta`,
    };
  }
  return {
    status: "proposal",
    via: "pipeline",
    proposal: pipelineProposal(head),
    candidates,
  };
}

/**
 * A pipeline item, projected — never looked up and re-derived.
 *
 * The item already carries what it owes, computed once where the pipeline is
 * built, so this cannot describe the same item differently from the board that
 * lists it. It used to re-find the spec or plan behind the row and run the
 * derivation again, which is exactly the seam the two surfaces drifted through.
 */
function pipelineProposal(item: PipelineItem): ResumeProposal {
  return {
    kind: item.kind,
    file: item.file,
    number: item.number,
    ...told(item.detail),
    action: item.action,
    command: item.command,
  };
}

// ── proposals ────────────────────────────────────────────────────────────────

function specProposal(spec: IndexedSpec, index: AgentWorkflowIndex): ResumeProposal {
  const refine = spec.status !== "ready-for-plan";
  return {
    kind: refine ? "spec-unrefined" : "spec-unplanned",
    file: spec.file,
    number: spec.number,
    ...told(specDetail(spec, index.plans)),
    action: {
      kind: "continue",
      command: refine ? `/w:spec-refine ${spec.file}` : `/w:plan-new ${spec.file}`,
      mode: "normal",
    },
    command: refine ? `/w:spec-refine ${spec.file}` : `/w:plan-new ${spec.file}`,
  };
}

function planProposal(plan: IndexedPlan): ResumeProposal {
  const presentation = planPresentation(plan);
  return {
    // Del mismo lugar que sale el titular: un plan cerrado con traspaso vigente
    // se nombra como lo que es en las dos superficies, o `resume <plan>` diría
    // «plan abierto» sobre uno cerrado y el tablero diría otra cosa.
    kind: presentation.kind,
    file: plan.file,
    number: plan.number,
    ...told(presentation.detail),
    action: presentation.action,
    command: presentation.action.command,
  };
}

/** The fields a proposal takes verbatim from the shared derivation. */
function told(
  detail: PipelineItemDetail,
): Pick<ResumeProposal, "objective" | "progress" | "next" | "warning" | "postponed"> {
  return {
    objective: detail.objective,
    progress: detail.progress,
    next: detail.next,
    ...(detail.warning === undefined ? {} : { warning: detail.warning }),
    ...(detail.postponed === undefined ? {} : { postponed: detail.postponed }),
  };
}

/**
 * Adds, to every proposal that is an `in-progress` plan, the uncommitted
 * changes of the sources it declares. Without git the proposal is returned as
 * it was: the board never invents a clean tree it did not look at.
 */
async function attachUncommitted(
  fs: FileSystemPort,
  paths: PathsService,
  index: AgentWorkflowIndex,
  outcome: ResumeOutcome,
  git: GitPort | undefined,
): Promise<ResumeOutcome> {
  if (git === undefined) return outcome;
  const running = new Map(
    index.plans.filter((plan) => plan.declared_state === "in-progress").map((p) => [p.file, p]),
  );
  if (running.size === 0) return outcome;
  const block = await readHubBlock(fs, paths.hubDir(), paths.blockMarkers());
  const pathOf = (alias: string): string | null =>
    alias === "hub"
      ? paths.hubDir()
      : (block?.fuentes.find((source) => source.alias === alias)?.path ?? null);
  const enrich = async (proposal: ResumeProposal): Promise<ResumeProposal> => {
    const plan = running.get(proposal.file);
    if (plan === undefined) return proposal;
    const uncommitted: SourceChanges[] = [];
    for (const alias of plan.pass_sources ?? []) {
      const path = pathOf(alias);
      if (path === null) {
        uncommitted.push({ alias, path, changes: [], error: "la fuente no resuelve a una ruta" });
        continue;
      }
      try {
        const changes = (await git.localChanges(path)).map((change) => change.path);
        uncommitted.push({ alias, path, changes });
      } catch (error) {
        uncommitted.push({
          alias,
          path,
          changes: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { ...proposal, uncommitted };
  };
  if (outcome.status === "proposal") {
    return {
      ...outcome,
      proposal: await enrich(outcome.proposal),
      ...(outcome.candidates !== undefined
        ? { candidates: await Promise.all(outcome.candidates.map(enrich)) }
        : {}),
    };
  }
  if (outcome.status === "candidates") {
    return { ...outcome, candidates: await Promise.all(outcome.candidates.map(enrich)) };
  }
  return outcome;
}
