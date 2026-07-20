import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { type SourceBranchRoles, resolveSourceBranches } from "./branch-resolver.js";
import { type ProjectFuente, readWorkspaceBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";

/** The three per-source git-flow actions (see docs/design/git-flow-per-source.md). */
export type GitFlowAction = "sync" | "to-qa" | "to-prod";

export interface GitFlowInput {
  action: GitFlowAction;
  /** Single source alias to run against. Mutually informative with `all`. */
  source?: string;
  /** Run against every declared source (fail-stop on the first conflict). */
  all?: boolean;
  /** Override the action's destination branch (work for sync, qa/prod for promote). */
  target?: string;
  /** Preview the ordered step list without touching git. */
  dryRun?: boolean;
}

export type StepStatus = "ok" | "conflict" | "skipped";

/** A single ordered operation in an action's sequence. */
export interface GitFlowStep {
  /** Stable label for display (e.g. "merge prod→work"). */
  step: string;
  status: StepStatus;
  detail?: string;
}

/** Per-source outcome of running an action. */
export interface GitFlowSourceResult {
  source: string;
  status: "ok" | "conflict" | "error";
  steps: GitFlowStep[];
  /** Branch the merge paused on, when `status === "conflict"`. */
  paused_at?: string;
  conflicted_files?: string[];
  error?: string;
}

export interface GitFlowResult {
  action: GitFlowAction;
  dry_run: boolean;
  status: "ok" | "conflict" | "error";
  /** Per-source results (length 1 for `--source`, N for `--all`). */
  results: GitFlowSourceResult[];
  error?: string;
}

/**
 * A planned operation. `merge` ops carry `onto` (the branch the merge lands on)
 * for the paused-at report. Resume is stateless: after a conflict the user
 * resolves + commits, then re-runs the same action — the plan replays from the
 * start and already-applied steps are git no-ops (merge = "Already up to date",
 * pull/checkout/push idempotent), so completed merges (incl. the resolved one)
 * are skipped automatically with no persisted position.
 */
type PlannedOp =
  | { kind: "pull-branch"; branch: string; label: string }
  | { kind: "checkout"; branch: string; label: string }
  | { kind: "pull"; label: string }
  | { kind: "merge"; from: string; onto: string; label: string }
  | { kind: "push"; branch: string; label: string };

const VALID_ACTIONS: ReadonlySet<string> = new Set(["sync", "to-qa", "to-prod"]);

export async function runGitFlow(
  fs: FileSystemPort,
  git: GitPort,
  paths: PathsService,
  input: GitFlowInput,
): Promise<GitFlowResult> {
  if (!VALID_ACTIONS.has(input.action)) {
    return errorResult(input.action, `Unknown action: ${input.action}`);
  }
  if (input.all === true && input.target !== undefined) {
    return errorResult(input.action, "Use --target with a single --source, not --all");
  }

  const block = await readWorkspaceBlock(fs, paths.workspaceDir(), paths.blockMarkers());
  const sources = block?.fuentes ?? [];
  if (sources.length === 0) {
    return errorResult(input.action, "no_sources_declared");
  }

  const selected = selectSources(sources, input);
  if ("error" in selected) {
    return errorResult(input.action, selected.error);
  }

  const dryRun = input.dryRun === true;
  const results: GitFlowSourceResult[] = [];
  let overall: GitFlowResult["status"] = "ok";

  for (const source of selected.sources) {
    const branches = resolveSourceBranches(source, block);
    const ops = buildPlan(input.action, branches, input.target);
    if (dryRun) {
      results.push({ source: source.alias, status: "ok", steps: ops.map(toDryStep) });
      continue;
    }

    const sourceResult = await executePlan(git, source, ops);
    results.push(sourceResult);
    if (sourceResult.status !== "ok") {
      overall = sourceResult.status;
      break; // fail-stop on conflict/error: leave remaining sources untouched.
    }
  }

  return { action: input.action, dry_run: dryRun, status: overall, results };
}

// --- source selection ---------------------------------------------------------

function selectSources(
  sources: ProjectFuente[],
  input: GitFlowInput,
): { sources: ProjectFuente[] } | { error: string } {
  if (input.all === true) {
    return { sources };
  }
  if (!input.source) {
    return { error: "Specify --source <alias> or --all" };
  }
  const match = sources.find((s) => s.alias === input.source);
  if (!match) {
    return { error: `Unknown source: ${input.source}` };
  }
  return { sources: [match] };
}

// --- plan construction --------------------------------------------------------

/**
 * Build the ordered op list for an action. Every role is already resolved
 * (per-source value → workspace default → fallback), so no branch can be
 * missing here — that is why no validation step precedes this.
 */
function buildPlan(
  action: GitFlowAction,
  branches: SourceBranchRoles,
  target: string | undefined,
): PlannedOp[] {
  const prod = branches.prod;
  const work = branches.work;

  if (action === "sync") {
    return syncPlan(prod, target ?? work);
  }
  if (action === "to-prod") {
    const dest = target ?? prod;
    // syncPlan already checked out + pulled prod; promoting just goes back to
    // prod and merges work (no re-pull: nothing changed it in between). Never qa→prod.
    return [
      ...syncPlan(prod, work),
      { kind: "checkout", branch: dest, label: `checkout ${dest}` },
      {
        kind: "merge",
        from: work,
        onto: dest,
        label: `merge work→${dest === prod ? "prod" : dest}`,
      },
      { kind: "push", branch: dest, label: `push ${dest}` },
    ];
  }
  // to-qa
  const qa = target ?? branches.qa;
  return [
    ...syncPlan(prod, work),
    { kind: "checkout", branch: qa, label: `checkout ${qa}` },
    { kind: "pull", label: `pull ${qa}` },
    { kind: "merge", from: prod, onto: qa, label: `merge prod→${qaLabel(qa, branches.qa)}` },
    { kind: "merge", from: work, onto: qa, label: `merge work→${qaLabel(qa, branches.qa)}` },
    { kind: "push", branch: qa, label: `push ${qa}` },
  ];
}

/** sync sequence onto a work-role branch (overridable by `--target`). */
function syncPlan(prod: string, workDest: string): PlannedOp[] {
  return [
    { kind: "pull-branch", branch: workDest, label: `pull ${workDest}` },
    { kind: "checkout", branch: prod, label: `checkout ${prod}` },
    { kind: "pull", label: `pull ${prod}` },
    { kind: "checkout", branch: workDest, label: `checkout ${workDest}` },
    { kind: "merge", from: prod, onto: workDest, label: "merge prod→work" },
  ];
}

function qaLabel(resolved: string, declared: string): string {
  return resolved === declared ? "qa" : resolved;
}

// --- execution ----------------------------------------------------------------

async function executePlan(
  git: GitPort,
  source: ProjectFuente,
  ops: PlannedOp[],
): Promise<GitFlowSourceResult> {
  const repo = source.path;

  // Preconditions. An in-progress merge means a prior conflict is unresolved —
  // refuse to run over it (re-running after resolve+commit is the resume path,
  // by which point MERGE_HEAD is cleared). A dirty tree would break `checkout`.
  if (await git.isMerging(repo)) {
    return sourceError(
      source.alias,
      "Repository has an in-progress merge — resolve and commit it, then re-run.",
    );
  }
  if (await git.isDirty(repo)) {
    return sourceError(
      source.alias,
      "Working tree has uncommitted changes — commit or stash before running git-flow.",
    );
  }

  const steps: GitFlowStep[] = [];
  for (const op of ops) {
    let conflict: { onto: string; files: string[] } | null;
    try {
      conflict = await runOp(git, repo, op);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ step: op.label, status: "skipped", detail: `failed: ${message}` });
      return {
        source: source.alias,
        status: "error",
        steps,
        error: `${op.label} failed: ${message}`,
      };
    }
    if (conflict) {
      steps.push({ step: op.label, status: "conflict", detail: `paused on ${conflict.onto}` });
      return {
        source: source.alias,
        status: "conflict",
        steps,
        paused_at: conflict.onto,
        conflicted_files: conflict.files,
      };
    }
    steps.push({ step: op.label, status: "ok" });
  }

  return { source: source.alias, status: "ok", steps };
}

function sourceError(alias: string, message: string): GitFlowSourceResult {
  return { source: alias, status: "error", steps: [], error: message };
}

/** Run one op. Returns conflict info when a merge conflicts, else null. */
async function runOp(
  git: GitPort,
  repo: string,
  op: PlannedOp,
): Promise<{ onto: string; files: string[] } | null> {
  switch (op.kind) {
    case "pull-branch":
      await git.checkout(repo, op.branch);
      await git.pull(repo);
      return null;
    case "checkout":
      await git.checkout(repo, op.branch);
      return null;
    case "pull":
      await git.pull(repo);
      return null;
    case "push":
      await git.push(repo, op.branch);
      return null;
    case "merge": {
      const result = await git.merge(repo, op.from);
      if (!result.ok) {
        const files =
          result.conflicted.length > 0 ? result.conflicted : await git.conflictedFiles(repo);
        return { onto: op.onto, files };
      }
      return null;
    }
  }
}

// --- helpers ------------------------------------------------------------------

function toDryStep(op: PlannedOp): GitFlowStep {
  return { step: op.label, status: "skipped", detail: "dry-run" };
}

function errorResult(action: string, message: string): GitFlowResult {
  return {
    action: action as GitFlowAction,
    dry_run: false,
    status: "error",
    results: [],
    error: message,
  };
}
