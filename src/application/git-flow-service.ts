import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import {
  type SourceBranchRoles,
  isPlainBranchName,
  isWorkingBranch,
  resolveSourceBranches,
} from "./branch-resolver.js";
import {
  type ProjectFuente,
  SourcePathMissingError,
  readWorkspaceBlock,
  requireSourcePath,
} from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { type ProdConsent, spendProdConsent } from "./prod-consent.js";
import { semanticDigest } from "./semantic-operation/protocol.js";

/** The per-source git-flow actions (see docs/design/git-flow-per-source.md). */
export type GitFlowAction = "sync" | "to-dev" | "to-qa" | "to-prod";

export interface GitFlowInput {
  action: GitFlowAction;
  /** Single source alias to run against. Mutually informative with `all`. */
  source?: string;
  /** Several named sources (a repeated `--source`), run in the order given. */
  sources?: readonly string[];
  /**
   * Run against every declared source. Continue-on-failure: every source is
   * attempted and reported; the batch status is the worst outcome seen.
   */
  all?: boolean;
  /** Override the action's destination branch (work for sync, dev/qa/prod for promote). */
  target?: string;
  /** Preview the ordered step list without touching git. */
  dryRun?: boolean;
  /**
   * The person's consent to publish in PROD. Only `grantProdConsent` builds
   * one — no flag, no caller-made object — and it covers exactly the sources it
   * lists, for one call.
   */
  consent?: ProdConsent;
}

export type StepStatus = "ok" | "conflict" | "skipped";

/** A single ordered operation in an action's sequence. */
export interface GitFlowStep {
  /** Stable label for display (e.g. "merge prod→work"). */
  step: string;
  status: StepStatus;
  detail?: string;
  /** The step with the real branch names (`merge certificacion→feature/x`), in previews. */
  preview?: string;
}

/** Per-source outcome of running an action. */
export interface GitFlowSourceResult {
  source: string;
  status: "ok" | "conflict" | "error";
  steps: GitFlowStep[];
  /** Branch a half-done merge sits on: this run's conflict, or one found before starting. */
  paused_at?: string;
  /** The branch that brought that merge; `null` when git cannot name it. */
  merge_origin?: string | null;
  conflicted_files?: string[];
  error?: string;
  error_code?: "SOURCE_PATH_MISSING";
}

export interface GitFlowResult {
  action: GitFlowAction;
  dry_run: boolean;
  status: "ok" | "conflict" | "error";
  /** Per-source results (length 1 for `--source`, N for `--all`). */
  results: GitFlowSourceResult[];
  error?: string;
  /**
   * Set when the plan publishes in PROD and the call carried no consent for
   * exactly these sources: nothing ran, and `results` is the preview.
   */
  consent_required?: { sources: string[]; plan: string };
}

export const PROD_CONSENT_REQUIRED = "publicar en PROD exige la confirmación de la persona";
export const ALL_REJECTED_FOR_PROD =
  "--all no vale para publicar en PROD: nombrá cada fuente con --source, repetido";

/**
 * A planned operation. `merge` ops carry `onto` (the branch the merge lands on)
 * for the paused-at report. Resume is stateless: after a conflict the user
 * resolves + commits, then re-runs the same action — the plan replays from the
 * start and already-applied steps are git no-ops (merge = "Already up to date",
 * refresh/checkout/push idempotent), so completed merges (incl. the resolved one)
 * are skipped automatically with no persisted position.
 *
 * A branch is never updated with `git pull`: that merges whatever the branch
 * tracks, which is how PROD got an octopus merge and a working branch tracking
 * development got development. `refresh` brings only the branch's homonym in
 * `origin`; `refresh-prod` only fast-forwards PROD to its own remote.
 */
type PlannedOp =
  | { kind: "refresh"; branch: string; checkout: boolean; label: string }
  | { kind: "refresh-prod"; branch: string; work: string; checkout: boolean; label: string }
  | { kind: "checkout"; branch: string; label: string }
  | { kind: "merge"; from: string; onto: string; fastForward: boolean; label: string }
  | { kind: "push"; branch: string; label: string };

/** What one op did: a refusal stops the source without having moved the branch. */
type OpOutcome =
  | { kind: "ok"; detail?: string }
  | { kind: "skipped"; detail: string }
  | { kind: "conflict"; onto: string; from: string; files: string[] }
  | { kind: "refused"; reason: string };

/** How many foreign commits a refusal names before summarizing the rest. */
const FOREIGN_COMMITS_SHOWN = 5;

const VALID_ACTIONS: ReadonlySet<string> = new Set(["sync", "to-dev", "to-qa", "to-prod"]);

export async function runGitFlow(
  fs: FileSystemPort,
  git: GitPort,
  paths: PathsService,
  input: GitFlowInput,
): Promise<GitFlowResult> {
  const invalid = invalidInput(input);
  if (invalid !== null) return errorResult(input.action, invalid);

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
  const entries = await planSelectedSources(fs, selected.sources, block, input);

  const gated = dryRun ? null : prodPublicationGate(input, entries);
  if (gated !== null) return gated;

  const results: GitFlowSourceResult[] = [];
  let overall: GitFlowResult["status"] = "ok";

  for (const entry of entries) {
    if (entry.ops === null || dryRun) {
      const result = entry.ops === null ? entry.result : dryResult(entry.source.alias, entry.ops);
      results.push(result);
      overall = worst(overall, result.status);
      continue;
    }

    // Any throw belongs to THIS source, never to the batch: the precondition
    // probes (isMerging/isDirty) reject when the path is not a usable repo, and
    // an uncaught one would strand every remaining source.
    const sourceResult = await executePlan(git, entry.source, entry.ops).catch((err) =>
      sourceError(entry.source.alias, err instanceof Error ? err.message : String(err)),
    );
    results.push(sourceResult);
    // Continue-on-failure: one source failing must not strand the rest. Each
    // source is independent (its own repo), so the batch reports every one and
    // the overall status is the WORST case seen.
    overall = worst(overall, sourceResult.status);
  }

  return { action: input.action, dry_run: dryRun, status: overall, results };
}

function invalidInput(input: GitFlowInput): string | null {
  if (!VALID_ACTIONS.has(input.action)) return `Unknown action: ${input.action}`;
  if (input.all === true && input.target !== undefined) {
    return "Use --target with a single --source, not --all";
  }
  if (new Set(input.sources ?? []).size > 1 && input.target !== undefined) {
    return "Use --target with a single --source";
  }
  if (input.target !== undefined && !isPlainBranchName(input.target)) {
    return `--target ${input.target} no es un nombre de rama simple: nombrá la rama tal cual, sin refs/, heads/ ni @{…}`;
  }
  return null;
}

/**
 * A plan that pushes to a source's PROD branch runs only with the person's
 * consent for exactly those sources. Enforced here, in the service, so no caller
 * — the CLI, the TUI or one written later — publishes without it.
 */
function prodPublicationGate(input: GitFlowInput, entries: PlannedSource[]): GitFlowResult | null {
  const prodSources = entries.filter((e) => e.publishesProd).map((e) => e.source.alias);
  if (prodSources.length === 0) return null;
  if (input.all === true) return errorResult(input.action, ALL_REJECTED_FOR_PROD);
  const plan = planDigest(entries);
  if (spendProdConsent(input.consent, prodSources, plan)) return null;
  return consentPreview(input.action, entries, prodSources, plan);
}

/** What the person is shown and what runs are the same thing only if this matches. */
function planDigest(entries: PlannedSource[]): string {
  return semanticDigest(
    entries.map((e) => ({
      source: e.source.alias,
      path: e.source.path,
      ops: e.ops,
      result: e.ops === null ? e.result : undefined,
    })),
  );
}

/** One selected source, planned: either its ops, or the result that replaces running them. */
type PlannedSource =
  | { source: ProjectFuente & { path: string }; ops: PlannedOp[]; publishesProd: boolean }
  | { source: ProjectFuente; ops: null; result: GitFlowSourceResult; publishesProd: false };

/**
 * Plan every source before touching any: whether the call publishes in PROD is
 * a fact about the whole plan, and consent is asked for it before the first step.
 */
function planSource(
  source: ProjectFuente & { path: string },
  branches: SourceBranchRoles,
  input: GitFlowInput,
): PlannedSource {
  if (branches.work === null && !(input.action === "sync" && input.target !== undefined)) {
    return {
      source,
      ops: null,
      result: sourceError(
        source.alias,
        `rama de trabajo no declarada para ${source.alias}; usá 'aw set-working-branch ${source.alias} <rama>'`,
      ),
      publishesProd: false,
    };
  }
  // Promoting work→dev when they are the same branch would merge a branch onto
  // itself: report it as done instead of running redundant merges.
  const noop = noopReason(input.action, branches, input.target);
  if (noop !== null) {
    const steps: GitFlowStep[] = [{ step: input.action, status: "skipped", detail: noop }];
    return {
      source,
      ops: null,
      result: { source: source.alias, status: "ok", steps },
      publishesProd: false,
    };
  }
  const lookalike = prodLookalike(input.target, branches.prod);
  if (lookalike !== null) {
    return {
      source,
      ops: null,
      result: sourceError(source.alias, lookalike),
      publishesProd: false,
    };
  }
  const ops = buildPlan(input.action, branches, input.target);
  const forbidden = devIntoWorkingBranch(ops, branches);
  if (forbidden !== null) {
    return {
      source,
      ops: null,
      result: sourceError(source.alias, forbidden),
      publishesProd: false,
    };
  }
  const publishesProd = ops.some((op) => op.kind === "push" && op.branch === branches.prod);
  return { source, ops, publishesProd };
}

/**
 * A `--target` that differs from PROD only in case: on a case-insensitive
 * filesystem it is PROD's own ref file, while the publication check compares
 * names exactly. Refused rather than guessed either way.
 */
function prodLookalike(target: string | undefined, prod: string): string | null {
  if (target === undefined || target === prod) return null;
  return target.toLowerCase() === prod.toLowerCase()
    ? `--target ${target} difiere de la rama de PROD ${prod} sólo en mayúsculas: nombrala tal cual`
    : null;
}

/** What would run, per source, with the real branches — and nothing ran. */
function consentPreview(
  action: GitFlowAction,
  entries: PlannedSource[],
  prodSources: string[],
  plan: string,
): GitFlowResult {
  const results = entries.map((entry) =>
    entry.ops === null
      ? entry.result
      : {
          source: entry.source.alias,
          status: "ok" as const,
          steps: entry.ops.map((op) => previewStep(op, "vista previa")),
        },
  );
  return {
    action,
    dry_run: false,
    status: "error",
    results,
    error: PROD_CONSENT_REQUIRED,
    consent_required: { sources: prodSources, plan },
  };
}

/** Severity order of the batch status: a later ok never masks an earlier failure. */
const STATUS_SEVERITY: Record<GitFlowResult["status"], number> = { ok: 0, conflict: 1, error: 2 };

function worst(a: GitFlowResult["status"], b: GitFlowResult["status"]): GitFlowResult["status"] {
  return STATUS_SEVERITY[b] > STATUS_SEVERITY[a] ? b : a;
}

// --- source selection ---------------------------------------------------------

function selectSources(
  sources: ProjectFuente[],
  input: GitFlowInput,
): { sources: ProjectFuente[] } | { error: string } {
  if (input.all === true) {
    return { sources };
  }
  const named = [...new Set(input.sources ?? (input.source ? [input.source] : []))];
  if (named.length === 0) {
    return { error: "Specify --source <alias> or --all" };
  }
  const selected: ProjectFuente[] = [];
  for (const alias of named) {
    const match = sources.find((s) => s.alias === alias);
    if (!match) return { error: `Unknown source: ${alias}` };
    selected.push(match);
  }
  return { sources: selected };
}

/**
 * Why this action has nothing to do for this source, or null when it does.
 * Only `to-dev` can degenerate: work and dev share the `desarrollo` default, so
 * a source that declares no working branch resolves both roles to it.
 */
function noopReason(
  action: GitFlowAction,
  branches: SourceBranchRoles,
  target: string | undefined,
): string | null {
  if (action !== "to-dev") return null;
  const dest = target ?? branches.dev;
  return dest === branches.work ? `nada que enviar: work ya es ${dest}` : null;
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
    if (target !== undefined) return syncPlan(prod, target);
    if (work === null) throw new Error("rama de trabajo no declarada");
    return syncPlan(prod, work);
  }
  if (work === null) throw new Error("rama de trabajo no declarada");
  if (action === "to-prod") {
    const dest = target ?? prod;
    // syncPlan already checked out + pulled prod; promoting just goes back to
    // prod and merges work (no re-pull: nothing changed it in between). Never qa→prod.
    return [
      ...syncPlan(prod, work),
      { kind: "checkout", branch: dest, label: `checkout ${dest}` },
      landOp(work, dest, prod, `merge work→${dest === prod ? "prod" : dest}`),
      { kind: "push", branch: dest, label: `push ${dest}` },
    ];
  }
  if (action === "to-dev") {
    return promotePlan(prod, work, target ?? branches.dev, "dev", branches.dev);
  }
  // to-qa
  return promotePlan(prod, work, target ?? branches.qa, "qa", branches.qa);
}

/**
 * PR-04: development never flows into a working branch. Checked on the plan,
 * before git is touched, so no subcommand and no `--target` can build that merge
 * — the case that reaches it is a source whose working branch fell back to the
 * development default, promoted onto a feature or `aw/*` branch.
 */
function devIntoWorkingBranch(ops: PlannedOp[], branches: SourceBranchRoles): string | null {
  const dev = new Set([branches.dev, `origin/${branches.dev}`]);
  for (const op of ops) {
    // A workspace whose development default IS the PROD branch still syncs PROD
    // into its working branches: that merge is PROD's, whatever the name says.
    if (op.kind !== "merge" || op.from === branches.prod) continue;
    if (dev.has(op.from) && isWorkingBranch(op.onto, branches)) {
      return `PR-04: el plan mezclaría la rama de desarrollo ${op.from} en la rama de trabajo ${op.onto}; git-flow no trae desarrollo a una rama de trabajo`;
    }
  }
  return null;
}

/** Update a branch from origin: PROD only by fast-forward, the rest by its homonym. */
function refreshOp(branch: string, prod: string, work: string, checkout: boolean): PlannedOp {
  return branch === prod
    ? { kind: "refresh-prod", branch, work, checkout, label: `pull ${branch}` }
    : { kind: "refresh", branch, checkout, label: `pull ${branch}` };
}

/**
 * Land `from` on `onto`. Onto PROD it is a fast-forward: after `merge prod→work`
 * the working branch already contains PROD, and a merge commit there would be
 * a commit of no working branch — one `merge.ff=false` in the person's config
 * and a failed push could never be resumed.
 */
function landOp(from: string, onto: string, prod: string, label: string): PlannedOp {
  return { kind: "merge", from, onto, fastForward: onto === prod, label };
}

/**
 * sync, then land prod and work onto a promotion branch and push it. Shared by
 * to-dev and to-qa — they differ only in which role names the destination.
 * `roleName` keeps the step labels role-shaped ("merge work→qa") while a
 * `--target` override shows the literal branch instead.
 */
function promotePlan(
  prod: string,
  work: string,
  dest: string,
  roleName: string,
  roleBranch: string,
): PlannedOp[] {
  const label = dest === roleBranch ? roleName : dest;
  return [
    ...syncPlan(prod, work),
    { kind: "checkout", branch: dest, label: `checkout ${dest}` },
    refreshOp(dest, prod, work, false),
    landOp(prod, dest, prod, `merge prod→${label}`),
    landOp(work, dest, prod, `merge work→${label}`),
    { kind: "push", branch: dest, label: `push ${dest}` },
  ];
}

/** sync sequence onto a work-role branch (overridable by `--target`). */
function syncPlan(prod: string, workDest: string): PlannedOp[] {
  return [
    refreshOp(workDest, prod, workDest, true),
    { kind: "checkout", branch: prod, label: `checkout ${prod}` },
    refreshOp(prod, prod, workDest, false),
    { kind: "checkout", branch: workDest, label: `checkout ${workDest}` },
    landOp(prod, workDest, prod, "merge prod→work"),
  ];
}

// --- execution ----------------------------------------------------------------

async function executePlan(
  git: GitPort,
  source: ProjectFuente & { path: string },
  ops: PlannedOp[],
): Promise<GitFlowSourceResult> {
  const repo = source.path;

  // Preconditions. An in-progress merge means a prior conflict is unresolved —
  // refuse to run over it (re-running after resolve+commit is the resume path,
  // by which point MERGE_HEAD is cleared). A dirty tree would break `checkout`.
  if (await git.isMerging(repo)) {
    return pendingMerge(git, source.alias, repo);
  }
  if (await git.isDirty(repo)) {
    return sourceError(
      source.alias,
      "Working tree has uncommitted changes — commit or stash before running git-flow.",
    );
  }

  const steps: GitFlowStep[] = [];
  for (const op of ops) {
    let outcome: OpOutcome;
    try {
      outcome = await runOp(git, repo, op);
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
    const stopped = recordOutcome(source.alias, steps, op, outcome);
    if (stopped !== null) return stopped;
  }

  return { source: source.alias, status: "ok", steps };
}

/** Append the op's step; a conflict or a refusal ends the source and is returned. */
function recordOutcome(
  alias: string,
  steps: GitFlowStep[],
  op: PlannedOp,
  outcome: OpOutcome,
): GitFlowSourceResult | null {
  switch (outcome.kind) {
    case "conflict":
      steps.push({ step: op.label, status: "conflict", detail: `paused on ${outcome.onto}` });
      return {
        source: alias,
        status: "conflict",
        steps,
        paused_at: outcome.onto,
        merge_origin: outcome.from,
        conflicted_files: outcome.files,
      };
    case "refused":
      steps.push({ step: op.label, status: "skipped", detail: outcome.reason });
      return { source: alias, status: "error", steps, error: `${op.label}: ${outcome.reason}` };
    case "skipped":
      steps.push({ step: op.label, status: "skipped", detail: outcome.detail });
      return null;
    case "ok":
      steps.push({
        step: op.label,
        status: "ok",
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      });
      return null;
  }
}

/** A merge left half-done by an earlier run, reported with where it sits and what brought it. */
async function pendingMerge(
  git: GitPort,
  alias: string,
  repo: string,
): Promise<GitFlowSourceResult> {
  // `rev-parse --abbrev-ref` answers the literal "HEAD" when detached.
  const branch = await git.currentBranch(repo);
  const onto = branch === undefined || branch === "HEAD" ? "HEAD" : branch;
  const from = (await git.mergeOrigin(repo)) ?? null;
  const where = onto === "HEAD" ? "un HEAD desacoplado, sin rama que git sepa nombrar" : onto;
  const brought = from ?? "una rama que git no sabe nombrar";
  return {
    source: alias,
    status: "error",
    steps: [],
    paused_at: onto,
    merge_origin: from,
    error: `hay un merge a medias sobre ${where}, traído por ${brought}: resolvelo y commitealo, y volvé a correr`,
  };
}

function sourceError(alias: string, message: string): GitFlowSourceResult {
  return { source: alias, status: "error", steps: [], error: message };
}

/** Run one op. A git failure throws; a refusal or a conflict is an outcome. */
async function runOp(git: GitPort, repo: string, op: PlannedOp): Promise<OpOutcome> {
  switch (op.kind) {
    case "refresh":
      return refreshBranch(git, repo, op.branch, op.checkout);
    case "refresh-prod":
      if (op.checkout) await git.checkout(repo, op.branch);
      return refreshProd(git, repo, op.branch, op.work);
    case "checkout":
      await git.checkout(repo, op.branch);
      return { kind: "ok" };
    case "push":
      await git.push(repo, op.branch);
      return { kind: "ok" };
    case "merge":
      if (!op.fastForward) return mergeOnto(git, repo, op.from, op.onto);
      await git.fastForward(repo, `refs/heads/${op.from}`);
      return { kind: "ok" };
  }
}

async function mergeOnto(
  git: GitPort,
  repo: string,
  from: string,
  onto: string,
): Promise<OpOutcome> {
  const result = await git.merge(repo, from);
  if (result.ok) return { kind: "ok" };
  const files = result.conflicted.length > 0 ? result.conflicted : await git.conflictedFiles(repo);
  return { kind: "conflict", onto, from, files };
}

/** Bring only `origin/<branch>`; a branch origin does not have is skipped, not failed. */
async function refreshBranch(
  git: GitPort,
  repo: string,
  branch: string,
  checkout: boolean,
): Promise<OpOutcome> {
  if (checkout) await git.checkout(repo, branch);
  if (!(await git.remoteHasBranch(repo, branch))) {
    return { kind: "skipped", detail: `origin no tiene ${branch}: no hay homónima que traer` };
  }
  await git.fetchBranch(repo, branch);
  return mergeOnto(git, repo, `origin/${branch}`, branch);
}

/**
 * Move the checked-out PROD branch only to its own remote, and only forward.
 *
 * Ahead is the one case that needs judging. A push that never reached origin
 * leaves PROD ahead with commits of the working branch, and repeating the
 * action must be able to finish it; anything else ahead — the octopus merge of
 * GIT-01, a stray commit — is not ours to publish, so the source stops.
 */
async function refreshProd(
  git: GitPort,
  repo: string,
  prod: string,
  work: string,
): Promise<OpOutcome> {
  const remote = `origin/${prod}`;
  if (!(await git.remoteHasBranch(repo, prod))) {
    return {
      kind: "refused",
      reason: `origin no tiene ${prod}: la rama de PROD no se toca sin su remoto`,
    };
  }
  await git.fetchBranch(repo, prod);
  // Full ref names: a tag called like PROD would otherwise answer for the branch.
  const local = `refs/heads/${prod}`;
  const remoteRef = `refs/remotes/${remote}`;
  const { ahead, behind } = await git.aheadBehind(repo, local, remoteRef);
  if (ahead === 0) {
    await git.fastForward(repo, remoteRef);
    return { kind: "ok" };
  }
  if (behind > 0) {
    return {
      kind: "refused",
      reason: `${prod} divergió de ${remote} (${ahead} commits propios y ${behind} del remoto): no se mueve`,
    };
  }
  const foreign = await git.revList(repo, local, [remoteRef, `refs/heads/${work}`]);
  if (foreign.length > 0) {
    return {
      kind: "refused",
      reason: `${prod} está adelantada con commits que no son de ${work}: ${summarizeCommits(foreign)}`,
    };
  }
  return {
    kind: "ok",
    detail: `${prod} va por delante de ${remote} sólo con commits de ${work} (${ahead}): se conservan`,
  };
}

function summarizeCommits(shas: string[]): string {
  const shown = shas.slice(0, FOREIGN_COMMITS_SHOWN).map((sha) => sha.slice(0, 7));
  const rest = shas.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} y ${rest} más` : shown.join(", ");
}

// --- helpers ------------------------------------------------------------------

function dryResult(alias: string, ops: PlannedOp[]): GitFlowSourceResult {
  return { source: alias, status: "ok", steps: ops.map((op) => previewStep(op, "dry-run")) };
}

function previewStep(op: PlannedOp, detail: string): GitFlowStep {
  return { step: op.label, status: "skipped", detail, preview: previewOf(op) };
}

/** No git is read to preview, so bringing a homonym is shown as conditional on it existing. */
function previewOf(op: PlannedOp): string {
  switch (op.kind) {
    case "refresh":
      return `pull ${op.branch} (desde origin/${op.branch}, si existe)`;
    case "refresh-prod":
      return `pull ${op.branch} (sólo fast-forward hasta origin/${op.branch})`;
    case "checkout":
      return `checkout ${op.branch}`;
    case "merge":
      return `merge ${op.from}→${op.onto}`;
    case "push":
      return `push ${op.branch}`;
  }
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

async function planSelectedSources(
  fs: FileSystemPort,
  sources: ProjectFuente[],
  block: Awaited<ReturnType<typeof readWorkspaceBlock>>,
  input: GitFlowInput,
): Promise<PlannedSource[]> {
  const entries: PlannedSource[] = [];
  for (const source of sources) {
    try {
      const path = await requireSourcePath(fs, source);
      entries.push(planSource({ ...source, path }, resolveSourceBranches(source, block), input));
    } catch (err) {
      entries.push({
        source,
        ops: null,
        result: {
          ...sourceError(source.alias, (err as Error).message),
          ...(err instanceof SourcePathMissingError ? { error_code: err.code } : {}),
        },
        publishesProd: false,
      });
    }
  }

  return entries;
}
