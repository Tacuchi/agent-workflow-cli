import { basename, join, relative } from "node:path";
import { CORRELATIVE_SOURCE, compareCorrelatives, isCorrelative } from "../domain/correlative.js";
import type { DecisionNote } from "../domain/decision-note.js";
import { type EffectiveContract, composeEffectiveContract } from "../domain/effective-contract.js";
import type { AssuranceStatus } from "../domain/flow/route.js";
import {
  type BaselineAlignment,
  type PlanBaselineSeal,
  type SpecCurrentDigests,
  alignSpecBaseline,
  specBaselineDigest,
} from "../domain/lineage.js";
import { type PlanReconciliation, reconciliationOf } from "../domain/reconciliation.js";
import type { SessionPhase } from "../domain/session/narrative.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { type SlotState, sanctionedActionFor, scanSlots } from "./claims-recovery.js";
import { localDateIso } from "./dates.js";
import { noteIndexPath, readNoteIndex } from "./decision-note-service.js";
import { type DesignGraph, buildDesignGraph } from "./design/design-graph-service.js";
import {
  type CoreDocsCanon,
  DEFAULT_DOCS_CANON,
  resolveCoreDocsCanon,
} from "./docs-canon-service.js";
import { humanizeRelativeEs } from "./humanize-es.js";
import { firstNonEmptyLine, parseMdSection, parseMdSectionBilingual } from "./markdown.js";
import { type ParsedPhases, parsePhases } from "./parsers/phases.js";
import { type ParsedPlanStatus, parsePlanStatus } from "./parsers/plan-status.js";
import { parseProjectBlock } from "./parsers/project-block.js";
import { functionalSpecDigest, unclosedSpecFence } from "./parsers/spec-functional.js";
import {
  type SpecEvidence,
  parsePlanBaselineSeal,
  parseSpecCriteria,
  parseSpecRelation,
} from "./parsers/spec-relation.js";
import { type ParsedTasks, parseTasks } from "./parsers/tasks.js";
import type { PathsService } from "./paths-service.js";
import { listPendingJournals } from "./retirement/journal.js";
import { findArtifact } from "./session-artifacts.js";
import { readSessionPhase } from "./session-narrative.js";
import { SessionsService } from "./sessions-service.js";
import { type OrphanUnit, runWorktree } from "./worktree-service.js";

/**
 * The one reading of the workspace's Workline documents.
 *
 * `status` and `resume` used to answer the same questions from two places —
 * one in the CLI, one re-derived by an agent reading JSON — and drifted. This
 * module owns specs, plans, sessions, the spec→plan relation and the pending
 * pipeline; both commands project it and neither decides anything on its own.
 *
 * Read-only by construction: nothing here opens a file for writing.
 */

const SPEC_STATUSES = ["draft", "refining", "ready-for-plan"] as const;

/** Spec maturity: how ready the spec is for `plan-new` to design against it. */
export type SpecStatus = (typeof SPEC_STATUSES)[number];

/**
 * Whole-plan closure, derived — never declared alone and never inferred from
 * the counters. `open` = there is still something to do or to validate;
 * `done` = the plan declares it AND the counters back the declaration;
 * `inconsistent` = the document contradicts itself and a human must repair it.
 */
export type PlanState = "open" | "done" | "inconsistent";

/**
 * The spec a plan derives from, resolved against the real spec inventory.
 *
 * `unknown` and `ambiguous` are first-class answers, not failures to hide: a
 * plan whose provenance cannot be proven stays visible as unproven rather than
 * being attached to whichever spec looks similar.
 *
 * `standalone` is the fourth, and the only one that is not a gap: the plan says
 * it has no spec because it was born in the conversation. It is deliberately NOT
 * `unknown` — a plan nobody can trace and a plan that declares its own origin
 * owe different things, and calling the second one unproven is what made the
 * board nag forever about a document that is not broken.
 */
export type SpecRelation =
  | { status: "resolved"; number: string; file: string; evidence: SpecEvidence }
  | { status: "standalone" }
  | { status: "unknown"; reason: "no-evidence" | "spec-not-found" }
  | { status: "ambiguous"; numbers: string[]; evidence: SpecEvidence };

export interface IndexedWorkspace {
  name: string;
  /** Resolved WorklineDirectory root; kept alongside `path` during the transition. */
  root: string;
  path: string;
  /**
   * `implicit` has no marker/config, `materialized` has the canonical sessions
   * marker, and `configured` additionally has a WORKSPACE block.
   */
  mode: "implicit" | "materialized" | "configured";
  /** @deprecated Use `mode`; retained for one release of JSON consumers. */
  initialized: boolean;
}

export interface IndexedSpec {
  file: string;
  number: string;
  slug: string;
  /** frontmatter `status:` when declared, else inferred from the legacy trace sections */
  status: SpecStatus;
  /** derived alias of `status === "ready-for-plan"`; kept for existing consumers */
  refined: boolean;
  open_questions: number;
  date: string;
  relative: string;
}

export interface IndexedBlockedPhase {
  number: number;
  name: string;
  /** the phase's `> Bloqueo:` reason; `null` on a legacy block that declares none */
  blocker: string | null;
}

export interface IndexedPlan {
  file: string;
  number: string;
  slug: string;
  tasks_total: number;
  tasks_done: number;
  /** checkbox-derived work progress; the phase counts below never feed it */
  progress_pct: number;
  /** `### Fn` blocks inside `## Tasks`; `0` on a plan with none stated (pre-contract) */
  phases_total: number;
  /** phases whose exact mark is `> Estado: validada` — never inferred from the checkboxes */
  phases_validated: number;
  /** the plan's third axis: closure, derived from the declaration AND the two counters */
  plan_state: PlanState;
  /** Closure assurance, kept independent from the plan's done/open state. */
  assurance: AssuranceStatus | null;
  /** phases whose exact mark is `> Estado: bloqueada` */
  phases_blocked: number;
  /** the blocked phases with what each one waits on */
  blocked_phases: IndexedBlockedPhase[];
  /** every task done and every phase validated, but the final validation never ran */
  final_validation_pending: boolean;
  /** which spec this plan proves it came from */
  spec: SpecRelation;
  /**
   * WHICH VERSION of that spec it was derived from, checked against the spec as
   * it reads now. `spec` answers the number; this answers the contract, and a
   * plan can have the first without the second.
   */
  baseline: BaselineAlignment;
  /**
   * What a decision left this plan owing, or `null` when it has no sealed,
   * aligned baseline to compose a contract against.
   *
   * Pending compensatory work is NEW work of the effective contract, never a
   * correction of the plan document: the phases and checkboxes it invalidated
   * keep their historical state, because they record what really happened.
   */
  reconciliation: PlanReconciliation | null;
  /**
   * The contract this plan is really committed to — baseline plus the notes in
   * force — or `null` when there is none to compose.
   *
   * `null` covers two different situations and {@link reconciliation} is what
   * tells them apart: a plan with no aligned seal has nothing to compose (and
   * its reconciliation is `null` too), while a chain that BLOCKS has a
   * reconciliation full of the composition's refusals. Neither ever reads as an
   * empty contract, because "committed to nothing" is a claim, not an absence.
   */
  contract: EffectiveContract | null;
  date: string;
  relative: string;
}

/**
 * Where a consumer of a baseline stands, once its notes are applied.
 *
 * Four values, and the fourth is the one that keeps the other three honest. An
 * open plan is `aligned` only when it can be PROVEN aligned: sealed, on the
 * current baseline, and owing nothing. A plan whose seal is absent, malformed or
 * divergent cannot be shown as aligned and has no compensation either — calling
 * it one or the other would answer a question its documents never answered.
 */
export type ConsumerStanding =
  /** Sealed on the current baseline and owing nothing. */
  | "aligned"
  /** Open, with compensatory work a decision left owing. */
  | "pending-reconciliation"
  /** Closed: its contract is history, and history is not reconciled forward. */
  | "historical"
  /** No sealed baseline, or one that no longer matches. Says so, claims nothing. */
  | "unproven";

/** A plan that consumes a given spec, with how its seal stands against it. */
export interface SpecConsumer {
  /** Workspace-relative path of the plan. */
  file: string;
  number: string;
  slug: string;
  /** `open` / `done` / `inconsistent` — whether this consumer is still live. */
  plan_state: PlanState;
  alignment: BaselineAlignment;
  /** The reading AC-09 asks for, derived from the two fields above plus the chain. */
  standing: ConsumerStanding;
}

export interface IndexedSession {
  code: string | null;
  folder: string;
  path: string;
  type: string | null;
  summary: string;
  state: "active" | "closed";
  /**
   * The session's own reading of itself — `abierta`, `reanudada` or `cerrada`.
   *
   * `state` answers whether the folder is closed; this answers whether anybody
   * has come back to it, which is the difference between a session waiting to
   * start and one somebody left mid-way. Derived by the same rule the narrative
   * uses, from the same reader, so the board and the session's own entry point
   * cannot describe it differently.
   */
  phase: SessionPhase;
  has_checkpoint: boolean;
  /** the spec/plan its `## Origin` points at, when it points at one */
  linked_doc: string | null;
  date: string;
  relative: string;
  /**
   * Isolation units this session is editing in, one per source it took.
   * Empty when the session is not isolated — which is every session in a
   * workspace that never asked for a unit, so the reading stays honest for
   * the single-flow case instead of implying an isolation that is not there.
   */
  units: SessionUnit[];
}

/** One flow's isolation unit, as the index reports it. */
export interface SessionUnit {
  alias: string;
  path: string;
  branch: string;
}

export type DiscardedKind = "deferred" | "excluded";

export interface IndexedDiscarded {
  source: string;
  source_path: string;
  kind: DiscardedKind;
  text: string;
  date: string;
  relative: string;
}

/**
 * What is left to do, in the order the spec fixes: an unrefined spec outranks a
 * spec with no plan, which outranks an incomplete plan, which outranks a loose
 * checkpoint. Inside plans a partially executed one outranks an untouched one.
 *
 * Nothing here is sorted by date or age — two items that tie stay tied, and the
 * caller asks. That is the whole point: recency is not priority.
 */
export type PipelineKind = "spec-unrefined" | "spec-unplanned" | "plan-open" | "checkpoint-orphan";

/**
 * The executable consequence of a pending item.
 *
 * `next` is prose for a person; this value is the machine-owned answer to
 * "what may actually be invoked?".  Keeping the two together is what prevents
 * a board from saying that a plan is blocked while still advertising
 * `/w:plan-exec` underneath it.
 */
export type PipelineAction =
  | {
      kind: "continue";
      command: string;
      /**
       * A legacy plan may execute, but its unsealed baseline is shown in detail.
       *
       * `standalone` is the mode of a plan that declares it has no spec: it runs
       * like `normal` and, unlike `compatible`, carries no warning — there is no
       * baseline missing, because there is no spec to have sealed one from. The
       * mode is still its own so a consumer can tell "no contract to prove" from
       * "a contract nobody proved".
       */
      mode?: "normal" | "compatible" | "reconcile" | "standalone";
    }
  | {
      kind: "handoff";
      command: string;
      destination: "plan-refine" | "spec-refine" | "spec-new";
      code: string;
    }
  | {
      kind: "blocked";
      command: null;
      code: string;
      action: string;
    };

/**
 * What an item still owes, derived HERE and nowhere else.
 *
 * `status` lists it and `resume` offers it as a choice, so a second derivation is
 * the one way the two surfaces could describe the same item differently — and
 * they did: `resume` computed this for the head of the pipeline and its ties,
 * while `status`, which lists them all, never computed it at all. That is why a
 * plan with every task done and every phase validated read as `100%, fases 6/6`
 * and said nothing about the final validation it was still waiting on.
 */
export interface PipelineItemDetail {
  /** The item named as its own work: `plan 034 — estado-y-reanudacion-guiada`. */
  objective: string;
  /** How far it got: `2/4 tareas (50%)·fases 1/3` · `status draft, 2 pregunta(s)`. */
  progress: string;
  /** The next pending step, or the obligation the work is waiting on. */
  next: string;
  /**
   * `next` is an obligation that leaves the item neither runnable nor closable:
   * an unresolvable design reference, a pending reconciliation, a baseline
   * nobody can prove. The board owes those BEFORE the percentage, because a
   * plan reading `100%` with its obligation further down is the misleading view
   * this projection exists to prevent.
   */
  obligation: boolean;
  /**
   * A truthful, non-blocking warning.  In particular a legacy unsealed plan is
   * runnable in compatibility mode; it is not silently called aligned and it is
   * not made unexecutable only because publication predates baseline seals.
   */
  warning?: { code: string; message: string };
}

export interface PipelineItem {
  kind: PipelineKind;
  priority: 1 | 2 | 3 | 4;
  /** workspace-relative path of the doc, or of the session folder */
  file: string;
  number: string | null;
  slug: string;
  summary: string;
  /** Typed route used by status and resume. */
  action: PipelineAction;
  /**
   * Compatibility projection of {@link action}. New consumers must use `action`;
   * a blocked item deliberately serializes this as `null`.
   */
  command: string | null;
  /** what it still owes — the single derivation both surfaces read */
  detail: PipelineItemDetail;
  /** plans only: work already started outranks an untouched plan */
  started?: boolean;
}

export interface WorklineIndex {
  workspace: IndexedWorkspace;
  specs: IndexedSpec[];
  plans: IndexedPlan[];
  sessions: IndexedSession[];
  discarded: IndexedDiscarded[];
  pipeline: PipelineItem[];
  /**
   * Active sessions holding work with no document of their own, by folder.
   *
   * Reported as a NOTICE and deliberately out of `pipeline`: the session
   * mechanics are the central workline's, so a loose checkpoint competing for
   * attention with an open plan asked a person to do the runtime's bookkeeping.
   * Making it vanish would be worse — the work inside it is recorded nowhere
   * else — so it is named, counted, and left where it is.
   */
  loose_sessions: string[];
  /** `spec → package → flow/screen → plan/task`, with its four reference states. */
  designs: DesignGraph;
  /**
   * Units that outlived the session that took them: reported, never cleaned up
   * on their own. A unit nobody claims is disk and a held branch, and the only
   * thing worse than leaving one behind is deleting it while its work is still
   * uncommitted.
   */
  orphan_units: OrphanUnit[];
  /**
   * Retirements left IN FLIGHT — neither applied nor undone.
   *
   * Reported, and reported prominently, because while one exists this board is not
   * a description anybody can act on: a session may be gone from disk while its row
   * is unwritten, or a ref may have moved while the filesystem has not caught up.
   * The projection must not present that as a finished state — and a READ must not
   * finish it either, since recovering is a mutation. What a read owes is the
   * visible fact plus the command that converges it.
   */
  pending_retirements: PendingRetirement[];
  /**
   * Correlatives held by a reservation or a legacy placeholder — never documents.
   *
   * Their own collection, deliberately OUT of `specs` and `plans`: a numbered file
   * that only holds a reservation marker used to be counted as a plan and offered
   * with `/w:plan-exec`, so the board invited somebody to execute a document that
   * did not exist yet. It is not a pipeline row either — nothing here is work the
   * user should weigh against an open plan — it is a held number, with the one
   * action that resolves it.
   */
  reservations: IndexedReservation[];
  /** Non-fatal, never silent: an unreadable `docs/` is not an empty one. */
  reservations_error?: string;
  /** Present when `[docs]` is invalid; readers deliberately did not guess paths. */
  docs_canon_error?: string;
}

export interface IndexedReservation {
  file: string;
  kind: SlotState["kind"];
  correlative: string;
  /** `null` only for a legacy placeholder: it names nobody by construction. */
  owner: string | null;
  /** The owner is still an active session — `null` when there is no owner. */
  ownerActive: boolean | null;
  /** Its bytes are still exactly its owner's marker. */
  intact: boolean;
  /** Already fenced by an irrevocable revocation; its release is a completion. */
  revoked: boolean;
  /** The single action that resolves it — resume, close, or recover. */
  next: string;
}

export interface PendingRetirement {
  /** The approval digest — the argument that finishes this exact operation. */
  digest: string;
  command: string;
  target: string;
  /** How far the process that died believed it got. Never the deciding fact. */
  phase: string;
  opened: string;
  /** The exact command that converges it. */
  next: string;
}

export interface WorklineIndexInput {
  now?: Date;
  /**
   * Read isolation units too. Optional on purpose: without it the index answers
   * exactly what it answered before units existed, so every caller that does not
   * care about them keeps its output byte for byte.
   */
  git?: GitPort;
}

/**
 * Never throws on a reachable cwd: an uninitialized workspace returns
 * `initialized:false` with empty collections, and a single unreadable file is
 * skipped rather than tanking the whole read.
 */
export async function buildWorklineIndex(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: WorklineIndexInput = {},
): Promise<WorklineIndex> {
  const now = input.now ?? new Date();
  const cwd = paths.workspaceDir();

  const workspace = await readWorkspace(fs, paths, cwd);
  const canon = await resolveCoreDocsCanon(fs, paths);
  const docs = canon.ok ? canon.canon : null;
  // Scanned BEFORE the documents, because it is what tells them apart: a
  // reservation and a legacy placeholder both look like a numbered document to a
  // filename regex, and only the ledger plus the bytes together can say which is
  // which. Their paths are then excluded from the corpus rather than filtered out
  // of it afterwards, so nothing downstream — pipeline, resume, the TUI — can see
  // a held number as executable work.
  const slotScan = await scanSlots(fs, paths);
  const heldPaths = new Set(slotScan.slots.map((slot) => slot.path));
  const specs = docs === null ? [] : await readSpecs(fs, cwd, docs.spec, now, heldPaths);
  const plans = docs === null ? [] : await readPlans(fs, cwd, specs, docs, now, heldPaths);
  const sessions = await readSessions(fs, env, paths, now, docs);
  const isolation = await readIsolation(fs, env, paths, input.git);
  for (const session of sessions) {
    session.units = isolation.bySession.get(session.folder) ?? [];
  }
  const discarded = await readDiscarded(fs, sessions, cwd, now);
  const designs = await buildDesignGraph(fs, cwd, [
    ...specs.map((s) => ({ file: s.file, kind: "spec" as const })),
    ...plans.map((p) => ({ file: p.file, kind: "plan" as const })),
  ]);

  return {
    workspace,
    specs,
    plans,
    sessions,
    discarded,
    pipeline: derivePipeline(specs, plans, designs),
    loose_sessions: looseSessions(sessions),
    designs,
    orphan_units: isolation.orphans,
    pending_retirements: await readPendingRetirements(fs, paths),
    reservations: slotScan.slots.map((slot) => ({
      file: slot.path,
      kind: slot.kind,
      correlative: slot.correlative,
      owner: slot.owner,
      ownerActive: slot.ownerActive,
      intact: slot.intact,
      revoked: slot.revoked,
      next: sanctionedActionFor(slot),
    })),
    ...(slotScan.error !== undefined ? { reservations_error: slotScan.error } : {}),
    ...(canon.ok ? {} : { docs_canon_error: canon.error }),
  };
}

/**
 * The retirements in flight, as the board has to show them.
 *
 * A journal that cannot be parsed is reported as pending too, with its reason: an
 * unreadable journal is the one case where we know least and must say most, since
 * the operation it describes may have passed its commit point.
 */
async function readPendingRetirements(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<PendingRetirement[]> {
  const pending = await listPendingJournals(fs, paths);
  const out: PendingRetirement[] = pending.journals.map((journal) => ({
    digest: journal.digest,
    command: journal.proposal.event.command,
    target: journal.proposal.event.key,
    phase: journal.phase,
    opened: journal.opened,
    next: `aw ${journal.proposal.event.command} apply ${journal.proposal.event.key} --approval ${journal.digest}`,
  }));
  for (const broken of pending.unreadable) {
    out.push({
      digest: "ilegible",
      command: "retiro",
      target: broken.path,
      phase: "ilegible",
      opened: "",
      next: `inspeccioná ${broken.path}: ${broken.reason}`,
    });
  }
  return out;
}

/**
 * Isolation units of this workspace, grouped by the session that owns each one.
 *
 * `aw worktree list` is the single reading — the same one the command surface
 * answers with — so `status`, `resume` and `worktree list` can never disagree
 * about which flow is editing where.
 */
async function readIsolation(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  git: GitPort | undefined,
): Promise<{ bySession: Map<string, SessionUnit[]>; orphans: OrphanUnit[] }> {
  const empty = { bySession: new Map<string, SessionUnit[]>(), orphans: [] };
  if (git === undefined) return empty;
  let listed: Awaited<ReturnType<typeof runWorktree>>;
  try {
    listed = await runWorktree({ fs, env, git, paths }, { action: "list" });
  } catch {
    return empty;
  }
  if (!("units" in listed)) return empty;
  const bySession = new Map<string, SessionUnit[]>();
  for (const unit of listed.units) {
    const current = bySession.get(unit.session) ?? [];
    current.push({ alias: unit.alias, path: unit.path, branch: unit.branch });
    bySession.set(unit.session, current);
  }
  return { bySession, orphans: listed.orphans };
}

// ── pipeline ─────────────────────────────────────────────────────────────────

function derivePipeline(
  specs: IndexedSpec[],
  plans: IndexedPlan[],
  designs: DesignGraph,
): PipelineItem[] {
  const items: PipelineItem[] = [];
  for (const spec of specs) {
    const detail = specDetail(spec, plans);
    if (spec.status !== "ready-for-plan") {
      items.push(specItem(spec, 1, "spec-unrefined", "/w:spec-refine", detail));
    } else if (!specIsPlanned(spec, plans)) {
      items.push(specItem(spec, 2, "spec-unplanned", "/w:plan-new", detail));
    }
  }
  for (const plan of plans) {
    if (plan.plan_state === "done") continue;
    const presentation = planPresentation(plan, designs);
    items.push({
      kind: "plan-open",
      priority: 3,
      file: plan.file,
      number: plan.number,
      slug: plan.slug,
      summary: planSummary(plan),
      action: presentation.action,
      command: presentation.action.command,
      detail: presentation.detail,
      started: plan.tasks_done > 0 || plan.phases_validated > 0,
    });
  }
  return items.sort(comparePipeline);
}

/** Active sessions carrying work that no document accounts for, by folder. */
function looseSessions(sessions: readonly IndexedSession[]): string[] {
  return sessions
    .filter((s) => s.state === "active" && s.has_checkpoint && s.linked_doc === null)
    .map((s) => s.folder);
}

function specItem(
  spec: IndexedSpec,
  priority: 1 | 2,
  kind: PipelineKind,
  command: string,
  detail: PipelineItemDetail,
): PipelineItem {
  return {
    kind,
    priority,
    file: spec.file,
    number: spec.number,
    slug: spec.slug,
    summary: `spec ${spec.number} — ${spec.status} · ${openQuestions(spec)}`,
    action: { kind: "continue", command: `${command} ${spec.file}`, mode: "normal" },
    command: `${command} ${spec.file}`,
    detail,
  };
}

function planSummary(plan: IndexedPlan): string {
  if (plan.plan_state === "done" && plan.assurance !== null && plan.assurance !== "verified") {
    return `plan ${plan.number} — done · no verificado (${plan.assurance})`;
  }
  const phases =
    plan.phases_total > 0 ? `, fases ${plan.phases_validated}/${plan.phases_total}` : "";
  const blocked = plan.phases_blocked > 0 ? `, ${plan.phases_blocked} bloqueada(s)` : "";
  return `plan ${plan.number} — ${plan.progress_pct}%${phases}${blocked}`;
}

// ── per-item detail: the single derivation both surfaces read ─────────────────

function openQuestions(spec: IndexedSpec): string {
  return `${spec.open_questions} pregunta(s) abierta(s)`;
}

/** Whether a plan already derives from this spec, by proven lineage. */
function specIsPlanned(spec: IndexedSpec, plans: readonly IndexedPlan[]): boolean {
  return plans.some((p) => p.spec.status === "resolved" && p.spec.number === spec.number);
}

/**
 * What a spec owes. Its `status` and its open questions and nothing more: any
 * further reading of a draft would mean running the refine engine from a
 * read-only view, which is exactly what this projection may not do.
 */
export function specDetail(spec: IndexedSpec, plans: readonly IndexedPlan[]): PipelineItemDetail {
  const refine = spec.status !== "ready-for-plan";
  return {
    objective: `spec ${spec.number}${spec.slug ? ` — ${spec.slug}` : ""}`,
    progress: `status ${spec.status}, ${openQuestions(spec)}`,
    next: refine
      ? "refinar hasta ready-for-plan"
      : specIsPlanned(spec, plans)
        ? "ya tiene plan derivado"
        : "generar su plan",
    obligation: false,
  };
}

/** What a plan owes, and whether saying it outranks saying its percentage. */
export function planDetail(plan: IndexedPlan, designs: DesignGraph): PipelineItemDetail {
  return planPresentation(plan, designs).detail;
}

/** The one plan projection shared by the pipeline and direct `resume <plan>`. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one presentation keeps direct resume and status equivalent.
export function planPresentation(
  plan: IndexedPlan,
  designs: DesignGraph,
): { detail: PipelineItemDetail; action: PipelineAction } {
  const phases =
    plan.phases_total > 0 ? ` · fases ${plan.phases_validated}/${plan.phases_total}` : "";
  const base = {
    objective: `plan ${plan.number}${plan.slug ? ` — ${plan.slug}` : ""}`,
    progress: `${plan.tasks_done}/${plan.tasks_total} tareas (${plan.progress_pct}%)${phases}`,
  };
  // A closed plan is documentary history.  In particular, a legacy plan with
  // no baseline seal is not retroactively made owing or executable merely
  // because a direct `resume <plan>` bypassed the pipeline's done filter.
  if (plan.plan_state === "done") {
    const assurance = plan.assurance;
    return {
      detail: {
        ...base,
        next:
          assurance === null || assurance === "verified"
            ? "plan cerrado: es histórico y no genera deuda de baseline"
            : `plan cerrado · no verificado (${assurance}): evidencia omitida o sustituta aceptada, no aprobada`,
        obligation: false,
      },
      action: {
        kind: "blocked",
        command: null,
        code: "WORKLINE_PLAN_HISTORICAL",
        action: "el plan ya está cerrado; consultá su evidencia o elegí trabajo pendiente",
      },
    };
  }
  const missing = describeMissingDesign(designs, plan.file);
  if (missing !== null) {
    return {
      detail: { ...base, next: missing, obligation: true },
      action: {
        kind: "blocked",
        command: null,
        code: "WORKLINE_PLAN_DESIGN_UNRESOLVED",
        action: "resolvé el diseño referido antes de volver a ejecutar el plan",
      },
    };
  }
  const [blocked] = plan.blocked_phases;
  if (blocked !== undefined) {
    return {
      detail: {
        ...base,
        next: `BLOQUEADA F${blocked.number} — ${blocked.blocker ?? "sin motivo declarado"}`,
        obligation: true,
      },
      action: {
        kind: "blocked",
        command: null,
        code: "WORKLINE_PLAN_PHASE_BLOCKED",
        action: "resolvé el bloqueo de la fase o registrá una desviación antes de continuar",
      },
    };
  }
  const owed = describePendingReconciliation(plan);
  if (owed !== null) {
    return {
      detail: { ...base, next: owed, obligation: true },
      action: {
        kind: "blocked",
        command: null,
        code: "WORKLINE_PLAN_RECONCILIATION_PENDING",
        action: "cerrá las obligaciones compensatorias desde su punto de reanudación",
      },
    };
  }
  if (plan.baseline.status === "divergent") {
    return {
      detail: { ...base, next: describeUnprovenBaseline(plan), obligation: true },
      action: {
        kind: "handoff",
        command: `/w:plan-refine ${plan.file}`,
        destination: "plan-refine",
        code: "WORKLINE_BASELINE_DIVERGENT",
      },
    };
  }
  if (plan.baseline.status === "malformed") {
    return {
      detail: { ...base, next: describeUnprovenBaseline(plan), obligation: true },
      action: {
        kind: "blocked",
        command: null,
        code: "WORKLINE_BASELINE_MALFORMED",
        action: plan.baseline.action,
      },
    };
  }
  if (plan.baseline.status === "unresolved") {
    return {
      detail: { ...base, next: describeUnprovenBaseline(plan), obligation: true },
      action: {
        kind: "blocked",
        command: null,
        code: "WORKLINE_BASELINE_SPEC_ABSENT",
        action: `restaurá o declará la spec '${plan.baseline.path}' antes de ejecutar`,
      },
    };
  }
  // A plan born in the conversation, said BEFORE the unsealed branch and with no
  // warning at all — that is the whole point. Its seal is absent and its
  // alignment therefore `unsealed`, so without this row it would fall into the
  // legacy route and be told forever that it "no afirma de qué versión de la spec
  // derivó" about a spec it never had. Nothing else changes: it runs, and it
  // closes, exactly like a normal plan.
  if (plan.spec.status === "standalone") {
    return {
      detail: { ...base, ...normalPlanNext(plan) },
      action: { kind: "continue", command: `/w:plan-exec ${plan.file}`, mode: "standalone" },
    };
  }
  // A legacy open plan stays executable even when its counters require
  // reconciliation. Compatibility is an explicit mode rather than a warning
  // accidentally lost behind the counter repair route.
  if (plan.baseline.status === "unsealed") {
    return {
      detail: {
        ...base,
        ...normalPlanNext(plan),
        warning: {
          code: "WORKLINE_BASELINE_LEGACY_UNSEALED",
          message:
            "SIN SELLO DE BASELINE — ejecución compatible: el plan no afirma de qué versión de la spec derivó",
        },
      },
      action: { kind: "continue", command: `/w:plan-exec ${plan.file}`, mode: "compatible" },
    };
  }
  // The baseline is a precondition of *every* execution mode, including the
  // reconciliation route. An inconsistent counter line must not accidentally
  // turn an unreadable/missing contract into an advertised `plan-exec` command.
  if (plan.plan_state === "inconsistent") {
    return {
      detail: {
        ...base,
        next: "el plan se declara done pero sus contadores no lo respaldan: reconciliar las tareas y fases acreditadas desde plan-exec",
        obligation: false,
      },
      action: { kind: "continue", command: `/w:plan-exec ${plan.file}`, mode: "reconcile" },
    };
  }
  return {
    detail: { ...base, ...normalPlanNext(plan) },
    action: { kind: "continue", command: `/w:plan-exec ${plan.file}`, mode: "normal" },
  };
}

/** The document's design references that are NOT valid, in graph order. */
export function unresolvedDesignRefs(
  designs: DesignGraph,
  file: string,
): DesignGraph["references"] {
  return designs.references.filter((r) => r.from === file && r.state !== "valid");
}

/**
 * The one precedence chain, in the one order — moved here whole, never re-cut.
 *
 * A missing reference outranks the plan's own next step because `plan-exec` fails
 * closed on it, so proposing "implementá F3" would send someone into a wall. A
 * blocked phase comes next: it is the live fact about this checkout. Then the
 * compensation, which outranks the `inconsistent` line too — a plan held open by
 * an obligation has counters that agree perfectly, so "sus contadores no lo
 * respaldan" would send somebody to repair a document that is not broken. The
 * baseline is said before the phase counters, because "continuar por la primera
 * fase no validada" is advice about a contract we cannot prove this plan is on.
 */
function normalPlanNext(plan: IndexedPlan): Pick<PipelineItemDetail, "next" | "obligation"> {
  if (plan.plan_state === "inconsistent") {
    return {
      next: "el plan se declara done pero sus contadores no lo respaldan: reconciliar las tareas y fases acreditadas desde plan-exec",
      obligation: false,
    };
  }
  if (plan.final_validation_pending) {
    return { next: "todo ejecutado: falta la validación final y el cierre", obligation: false };
  }
  return { next: "continuar por la primera fase no validada", obligation: false };
}

function describeMissingDesign(designs: DesignGraph, file: string): string | null {
  const [first] = unresolvedDesignRefs(designs, file).filter((r) => r.state === "missing");
  if (first === undefined) return null;
  return `DISEÑO IRRESOLUBLE ${first.baseline} — ${first.detail ?? "no resuelve"}`;
}

/**
 * What a plan owes, when it owes anything — the one thing that must be said
 * before offering to run or to close it.
 *
 * A plan with an open obligation is neither executable as it stands nor
 * closable, and saying so with the obligation and its resume point is what keeps
 * the refusal actionable instead of a wall.
 */
function describePendingReconciliation(plan: IndexedPlan): string | null {
  const reconciliation = plan.reconciliation;
  if (reconciliation === null || reconciliation.closable) return null;
  const [first] = reconciliation.pending;
  if (first === undefined) {
    return "RECONCILIACIÓN PENDIENTE — el contrato efectivo no se puede componer: ni ejecutable ni cerrable";
  }
  const more = reconciliation.pending.length - 1;
  const rest = more > 0 ? ` (+${more} más)` : "";
  return `RECONCILIACIÓN PENDIENTE por ${first.by} — ${first.text}${rest}: retomá en ${first.resume_point}, ni ejecutable ni cerrable tal cual`;
}

/**
 * A plan whose baseline nobody can prove, said as exactly that.
 *
 * The plans that predate the seal are the common case, and the honest report is
 * "it does not have one" — never "aligned" and never "derived from the current
 * contract". A divergent seal is the louder version of the same problem and gets
 * its own line rather than being folded in.
 *
 * The divergent line also names the CHEAP exit, because "review the plan against
 * the spec" has two possible outcomes and only one of them needs a redesign. When
 * the review concludes the plan still holds — the whole of the case for a legacy
 * byte-exact seal, which any editorial edit turns divergent — `aw reseal` closes
 * it in two commands. The handoff to `/w:plan-refine` stays the recommended
 * action, and this is the alternative to it, never its replacement.
 *
 * When the divergence is a spec with an unclosed FENCE, neither exit applies and
 * the line says so: the contract sections are invisible, so the seal fell back to
 * the exact bytes and the next edit diverges again — re-sealing that would be the
 * loop, not the exit.
 */
function describeUnprovenBaseline(plan: IndexedPlan): string {
  const baseline = plan.baseline;
  if (baseline.status === "divergent") {
    if (baseline.unclosed_fence !== undefined) {
      return `BASELINE DIVERGENTE — la spec tiene un fence sin cerrar en la línea ${baseline.unclosed_fence + 1}: cerralo y volvé a mirar; hasta entonces el sello cae al byte-exacto y cualquier edición vuelve a divergir`;
    }
    return `BASELINE DIVERGENTE — la spec cambió desde que se selló (${baseline.sealed_digest} → ${baseline.current_digest}): revisá el plan contra la spec vigente antes de seguir; si el plan sigue vigente tal cual, cerrá la divergencia con 'aw reseal prepare ${plan.file}'`;
  }
  if (baseline.status === "malformed") {
    return `BASELINE ILEGIBLE — ${baseline.why}: ${baseline.action}`;
  }
  if (baseline.status === "unresolved") {
    return `BASELINE SIN SPEC — ${baseline.path} no está en el workspace: no hay contrato contra el que validar`;
  }
  return "SIN SELLO DE BASELINE — el plan no dice de qué versión de su spec deriva: no se puede afirmar que esté alineado";
}

/**
 * Priority first, then started-before-untouched, then document number. The last
 * key is presentation only — two items that reach it are still a tie for the
 * caller, which is why `resume` compares priority and `started`, never order.
 */
function comparePipeline(a: PipelineItem, b: PipelineItem): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const started = Number(b.started ?? false) - Number(a.started ?? false);
  if (started !== 0) return started;
  const left = a.number ?? "";
  const right = b.number ?? "";
  return compareNumberedStrings(left, right);
}

// ── workspace ────────────────────────────────────────────────────────────────

async function readWorkspace(
  fs: FileSystemPort,
  paths: PathsService,
  cwd: string,
): Promise<IndexedWorkspace> {
  let name = basename(cwd);
  let configured = false;
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    try {
      if (!(await fs.exists(file))) continue;
      const block = parseProjectBlock(await fs.readText(file), paths.blockMarkers());
      if (block !== null) configured = true;
      if (block?.proyecto) {
        name = block.proyecto;
        break;
      }
    } catch {
      // ignore; fall back to basename
    }
  }
  let materialized = false;
  try {
    materialized = (await fs.stat(paths.cwdSessionsDir())).type === "dir";
  } catch {
    // A bare namespace directory is intentionally not a workspace marker.
  }
  const mode = configured ? "configured" : materialized ? "materialized" : "implicit";
  return {
    name,
    root: cwd,
    path: cwd,
    mode,
    initialized: mode !== "implicit",
  };
}

// ── specs ────────────────────────────────────────────────────────────────────

const SPEC_RE = new RegExp(`^(${CORRELATIVE_SOURCE})-spec(?:-(.+))?\\.md$`, "i");

async function readSpecs(
  fs: FileSystemPort,
  cwd: string,
  specDir: string,
  now: Date,
  held: ReadonlySet<string> = new Set(),
): Promise<IndexedSpec[]> {
  const files = dedupeRefined(await listMarkdown(fs, join(cwd, specDir), SPEC_RE));
  const out: IndexedSpec[] = [];
  for (const f of files) {
    if (held.has(relFromCwd(f.path, cwd))) continue;
    try {
      const text = await fs.readText(f.path);
      const status = resolveSpecStatus(text);
      const ts = await resolveTimestamp(fs, f.path, undefined, now);
      out.push({
        file: relFromCwd(f.path, cwd),
        number: f.number,
        slug: f.slug,
        status,
        refined: status === "ready-for-plan",
        open_questions: countOpenQuestions(text),
        date: ts.date,
        relative: ts.relative,
      });
    } catch {
      // skip unreadable spec
    }
  }
  return sortByNumber(out);
}

/**
 * The only two trace sections that marked a spec as worked-through before the
 * frontmatter `status` existed. `## Decisions` is NOT one of them: it belongs
 * to the current spec schema and proves nothing about the refine gate.
 *
 * Exported so the doctrine guard can check this list against the marks the
 * bundle documents — the two drifted apart once, and a spec nobody refined
 * reached PLAN because of it.
 */
export const LEGACY_READY_MARKS = ["Refinement decisions", "Q&A traceability"];

/**
 * Spec maturity. A declared frontmatter governs alone: an empty, unknown or
 * unterminated declaration reads `draft` — never a legacy inference, which
 * would send work to PLAN on a gate `spec-refine` never ran. Legacy
 * compatibility runs only on a spec that carries no frontmatter at all.
 */
function resolveSpecStatus(text: string): SpecStatus {
  const frontmatter = parseSpecFrontmatter(text);
  if (frontmatter.kind === "malformed") return "draft";
  if (frontmatter.kind === "present") {
    const declared = (frontmatter.status ?? "").toLowerCase();
    return isSpecStatus(declared) ? declared : "draft";
  }
  return hasLegacyReadyMark(text) ? "ready-for-plan" : "draft";
}

function hasLegacyReadyMark(text: string): boolean {
  return LEGACY_READY_MARKS.some((h) => parseMdSectionLoose(text, h) !== undefined);
}

function isSpecStatus(value: string): value is SpecStatus {
  return (SPEC_STATUSES as readonly string[]).includes(value);
}

const FRONTMATTER_FENCE = "---";
const FRONTMATTER_ENTRY = /^([A-Za-z0-9_-]+):\s*(.*)$/;

/**
 * `absent` (no block at the top) · `present` (block opened and closed) ·
 * `malformed` (opened, never closed). The three are not interchangeable: a
 * broken declaration is a declaration, and only `absent` may fall back.
 */
type SpecFrontmatter =
  | { kind: "absent" | "malformed" }
  | { kind: "present"; status: string | undefined };

/**
 * Classify the `---` block at the top of the file and read its `status` scalar.
 * Specs only carry flat scalars there, so this stays a few lines instead of
 * pulling a YAML dependency into the CLI.
 */
function parseSpecFrontmatter(text: string): SpecFrontmatter {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== FRONTMATTER_FENCE) return { kind: "absent" };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === FRONTMATTER_FENCE);
  if (end === -1) return { kind: "malformed" };
  return { kind: "present", status: readScalar(lines.slice(1, end), "status") };
}

function readScalar(lines: string[], key: string): string | undefined {
  for (const line of lines) {
    const m = FRONTMATTER_ENTRY.exec(line);
    if (m?.[1] !== key) continue;
    const value = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

// ── plans ────────────────────────────────────────────────────────────────────

const PLAN_RE = new RegExp(`^(${CORRELATIVE_SOURCE})-plan(?:-(.+))?\\.md$`, "i");

async function readPlans(
  fs: FileSystemPort,
  cwd: string,
  specs: IndexedSpec[],
  docs: CoreDocsCanon,
  now: Date,
  held: ReadonlySet<string> = new Set(),
): Promise<IndexedPlan[]> {
  const files = await listMarkdown(fs, join(cwd, docs.plan), PLAN_RE);
  const byNumber = new Map(specs.map((s) => [s.number, s]));
  // Read each spec at most once: every plan derived from the same spec compares
  // against the same bytes, and re-reading them per plan would let two plans in
  // one board be judged against two different reads of one file.
  const specTexts = new Map<string, string | null>();
  const specTextOf = async (number: string): Promise<string | null> => {
    const cached = specTexts.get(number);
    if (cached !== undefined) return cached;
    const spec = byNumber.get(number);
    let text: string | null = null;
    if (spec !== undefined) {
      try {
        text = await fs.readText(join(cwd, spec.file));
      } catch {
        text = null;
      }
    }
    specTexts.set(number, text);
    return text;
  };
  // Digested once per spec too, and for the same reason: the functional payload
  // is what a seal means today, the exact bytes are what a legacy seal meant,
  // and two plans of one spec must be judged against one reading of both.
  const specDigests = new Map<string, SpecCurrentDigests | null>();
  const specDigestsOf = async (number: string): Promise<SpecCurrentDigests | null> => {
    const cached = specDigests.get(number);
    if (cached !== undefined) return cached;
    const text = await specTextOf(number);
    const digests =
      text === null
        ? null
        : {
            functional: functionalSpecDigest(text),
            exact: specBaselineDigest(text),
            unclosed_fence: unclosedSpecFence(text),
          };
    specDigests.set(number, digests);
    return digests;
  };
  // One read of each lineage's chain, for the same reason the specs are read
  // once: two plans of one spec must be judged against one reading of its notes.
  const chains = new Map<string, DecisionNote[]>();
  const chainOf = async (spec: IndexedSpec): Promise<DecisionNote[]> => {
    const cached = chains.get(spec.number);
    if (cached !== undefined) return cached;
    const path = noteIndexPath(DEFAULT_DOCS_CANON.decision, spec.number, spec.slug);
    const read = await readNoteIndex(fs, cwd, path, { path: spec.file, number: spec.number });
    // A chain that does not parse is NOT "no obligations": reporting it as a
    // clean slate would let a plan close over compensation nobody could read.
    const notes = read.ok ? read.read.index.notes : [];
    chains.set(spec.number, notes);
    return notes;
  };

  const out: IndexedPlan[] = [];
  for (const f of files) {
    if (held.has(relFromCwd(f.path, cwd))) continue;
    try {
      const text = await fs.readText(f.path);
      const seal = parsePlanBaselineSeal(text, docs.spec);
      const sealedSpec = seal.status === "sealed" ? await specTextOf(seal.baseline.number) : null;
      const t = parseTasks(text);
      const p = parsePhases(text);
      const sealedDigests =
        seal.status === "sealed" ? await specDigestsOf(seal.baseline.number) : null;
      const alignment = alignSpecBaseline(seal, sealedDigests);
      const lineage = await reconciliationFor(
        alignment,
        seal,
        sealedSpec,
        byNumber,
        chainOf,
        sealedDigests,
      );
      const status = parsePlanStatus(text);
      const planState = derivePlanState(status.declared, t, p, lineage.reconciliation);
      const ts = await resolveTimestamp(fs, f.path, undefined, now);
      out.push({
        file: relFromCwd(f.path, cwd),
        number: f.number,
        slug: f.slug,
        tasks_total: t.total,
        tasks_done: t.closed,
        progress_pct: t.progress_pct,
        phases_total: p.total,
        phases_validated: p.validated,
        plan_state: planState,
        assurance: status.assurance,
        phases_blocked: p.blocked,
        blocked_phases: p.items
          .filter((phase) => phase.state === "bloqueada")
          .map((phase) => ({ number: phase.n, name: phase.name, blocker: phase.blocker })),
        final_validation_pending:
          planState === "open" && p.total > 0 && p.validated === p.total && t.closed === t.total,
        spec: resolveSpecRelation(text, byNumber, docs.spec),
        baseline: alignment,
        reconciliation: lineage.reconciliation,
        contract: lineage.contract,
        date: ts.date,
        relative: ts.relative,
      });
    } catch {
      // skip unreadable plan
    }
  }
  return sortByNumber(out);
}

/**
 * Every plan known to consume a spec, and how each one's seal stands against
 * the spec's current content.
 *
 * Membership is the plan's RESOLVED relation, not its seal: derivation is what
 * makes a plan a consumer, and a plan that names the spec without sealing it is
 * still one — its `unsealed` alignment is precisely the answer that says it
 * cannot be judged further. A plan whose provenance is `unknown` or `ambiguous`
 * is deliberately absent: attaching it here would be the guess `parseSpecRelation`
 * exists to refuse.
 */
export function specConsumers(specNumber: string, plans: readonly IndexedPlan[]): SpecConsumer[] {
  const out: SpecConsumer[] = [];
  for (const plan of plans) {
    if (plan.spec.status !== "resolved" || plan.spec.number !== specNumber) continue;
    out.push({
      file: plan.file,
      number: plan.number,
      slug: plan.slug,
      plan_state: plan.plan_state,
      alignment: plan.baseline,
      standing: standingOf(plan),
    });
  }
  return out;
}

/**
 * Read one consumer's standing, in the order that keeps each answer truthful.
 *
 * Closed first: a `done` plan's contract is history, and asking whether history
 * owes compensation is asking the wrong question — the reconciliation gate is
 * exactly what stops a plan from reaching `done` while it owes anything, so a
 * plan that got there owes nothing by construction.
 *
 * Then the seal, and only then the chain: without a provable alignment there is
 * no contract to owe against, so `unproven` outranks both of the readings that
 * would otherwise be guesses.
 */
function standingOf(plan: IndexedPlan): ConsumerStanding {
  if (plan.plan_state === "done") return "historical";
  if (plan.baseline.status !== "aligned") return "unproven";
  if (plan.reconciliation === null || !plan.reconciliation.closable) {
    return "pending-reconciliation";
  }
  return "aligned";
}

function resolveSpecRelation(
  text: string,
  specs: Map<string, IndexedSpec>,
  specDir: string,
): SpecRelation {
  const parsed = parseSpecRelation(text, specDir);
  if (parsed.status === "absent") return { status: "unknown", reason: "no-evidence" };
  // Carried through as itself. Folding it into `unknown` would be the board
  // deciding that a declared origin is worse than a declared spec, and every
  // surface downstream reads the difference: the pipeline mode, the warning it
  // does NOT emit, and the `status` counter of plans that owe a baseline.
  if (parsed.status === "standalone") return { status: "standalone" };
  if (parsed.status === "ambiguous") {
    return { status: "ambiguous", numbers: parsed.numbers, evidence: parsed.evidence };
  }
  const spec = specs.get(parsed.number);
  // The plan names a spec that is not in the workspace: evidence exists but
  // proves nothing here, and inventing a match by slug is exactly the guess
  // this resolution exists to remove.
  if (spec === undefined) return { status: "unknown", reason: "spec-not-found" };
  return {
    status: "resolved",
    number: parsed.number,
    file: spec.file,
    evidence: parsed.evidence,
  };
}

/**
 * The three axes reconciled into one closure state. The rules, in order:
 *
 * - a plan that declares nothing, or declares `open`, IS open — including the
 *   case where every box is ticked and every phase is validated: that plan is
 *   waiting on its final validation, not finished (`final_validation_pending`);
 * - a plan that declares `done` is `done` only when the counters agree — every
 *   task closed and, under the phase contract, every phase validated;
 * - any other combination is `inconsistent`: the document says one thing and
 *   shows another, and nothing but a human repairs that.
 *
 * A plan with no phase marks predates the contract (`phases_total: 0`) and is
 * judged by its checkboxes alone — it never acquires fictitious phases, and
 * `done` on such a plan stays legitimate when its boxes are all ticked.
 */
function derivePlanState(
  declared: ParsedPlanStatus["declared"],
  tasks: ParsedTasks,
  phases: ParsedPhases,
  reconciliation: PlanReconciliation | null,
): PlanState {
  if (declared === "unknown") return "inconsistent";
  if (declared !== "done") return "open";
  if (tasks.closed !== tasks.total) return "inconsistent";
  // A decision left compensatory work owing, so the counters agreeing is not the
  // same as the contract being satisfied — and this is exactly `inconsistent`'s
  // existing meaning: the document says one thing and shows another. Gating it
  // HERE is what closes the closure path end to end, because the flow's own
  // `plan-exec.plan-done` row seals the plan only once the board reads it closed.
  if (reconciliation !== null && !reconciliation.closable) return "inconsistent";
  // Legacy contract (`legacy-tasks`): no phase marks, so the checkboxes decide.
  if (phases.total === 0) return "done";
  return phases.validated === phases.total ? "done" : "inconsistent";
}

/**
 * What this plan still owes, or `null` when the question does not apply.
 *
 * Only a plan whose seal ALIGNS gets a reconciliation. An unsealed plan has no
 * baseline to compose against, and a divergent one is already being reported as
 * divergent — deriving obligations from a contract the plan is not on would
 * answer a question nobody asked with numbers nobody can act on.
 *
 * A contract that BLOCKS is not a clean slate either: it comes back as pending
 * with the composition's own refusal as the work owed, so a plan whose chain
 * cannot be read never slips through as closable.
 */
async function reconciliationFor(
  alignment: BaselineAlignment,
  seal: PlanBaselineSeal,
  specText: string | null,
  byNumber: ReadonlyMap<string, IndexedSpec>,
  chainOf: (spec: IndexedSpec) => Promise<DecisionNote[]>,
  digests: SpecCurrentDigests | null,
): Promise<PlanContractReading> {
  const none: PlanContractReading = { reconciliation: null, contract: null };
  if (alignment.status !== "aligned" || seal.status !== "sealed" || specText === null) return none;
  const spec = byNumber.get(seal.baseline.number);
  if (spec === undefined) return none;

  // An empty chain composes to a contract with no obligations, so it needs no
  // special case: a plan nobody amended owes nothing and stays closable.
  const chain = await chainOf(spec);
  const composed = composeEffectiveContract(
    {
      path: spec.file,
      number: spec.number,
      digest: alignment.digest,
      // The other reading of the same untouched spec: a note published before
      // the functional payload existed pinned the exact bytes, and the seal's
      // migration is only half a migration if the note's side refuses it.
      legacy_digest: digests?.exact,
      criteria: parseSpecCriteria(specText, spec.number),
    },
    chain,
  );
  if (composed.status === "blocked") {
    return {
      contract: null,
      reconciliation: {
        pending: composed.failures.map((failure) => ({
          text: `${failure.code}: ${failure.message}`,
          by: "composición",
          resume_point: failure.action,
        })),
        resume_point: composed.failures[0]?.action ?? null,
        closable: false,
      },
    };
  }
  return {
    contract: composed.contract,
    reconciliation: reconciliationOf(composed.contract, chain),
  };
}

/** What one plan's lineage says, read once and reported on two fields. */
interface PlanContractReading {
  reconciliation: PlanReconciliation | null;
  contract: EffectiveContract | null;
}

// ── sessions ─────────────────────────────────────────────────────────────────

async function readSessions(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  now: Date,
  docs: CoreDocsCanon | null,
): Promise<IndexedSession[]> {
  let list: Awaited<ReturnType<SessionsService["list"]>>;
  try {
    list = await new SessionsService(fs, env, paths).list({ state: "all", verbose: true });
  } catch {
    return [];
  }

  const out: IndexedSession[] = [];
  for (const s of list.sessions) {
    const primary = (await findArtifact(s.path, "session", fs)) ?? s.path;
    const ts = await resolveTimestamp(fs, primary, s.date, now);
    const checkpoint = await findArtifact(s.path, "checkpoint", fs);
    out.push({
      code: s.code,
      folder: s.folder,
      path: s.path,
      type: s.type ?? null,
      summary: s.summary ?? s.folder,
      state: s.state === "closed" ? "closed" : "active",
      phase: await readSessionPhase(fs, s.path, s.state === "closed"),
      has_checkpoint: checkpoint !== null && checkpoint !== undefined,
      linked_doc: docs === null ? null : await readLinkedDoc(fs, primary, docs),
      date: ts.date,
      relative: ts.relative,
      units: [],
    });
  }
  return out;
}

/** The spec/plan a session's `## Origin` points at — `null` when it points at none. */
async function readLinkedDoc(
  fs: FileSystemPort,
  sessionFile: string,
  docs: Pick<CoreDocsCanon, "spec" | "plan">,
): Promise<string | null> {
  try {
    const origin = parseMdSectionBilingual(await fs.readText(sessionFile), "Origin");
    return origin === undefined ? null : (linkedDocPattern(docs).exec(origin)?.[0] ?? null);
  } catch {
    return null;
  }
}

function linkedDocPattern(docs: Pick<CoreDocsCanon, "spec" | "plan">): RegExp {
  const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alternatives = [
    `${escapePattern(docs.spec)}/${CORRELATIVE_SOURCE}-spec`,
    `${escapePattern(docs.plan)}/${CORRELATIVE_SOURCE}-plan`,
  ].join("|");
  return new RegExp(`(?:${alternatives})[^\\s\`)"']*\\.md`);
}

// ── discarded ────────────────────────────────────────────────────────────────

async function readDiscarded(
  fs: FileSystemPort,
  sessions: IndexedSession[],
  cwd: string,
  now: Date,
): Promise<IndexedDiscarded[]> {
  const out: IndexedDiscarded[] = [];
  for (const s of sessions) {
    await collectDiscarded(fs, s, "backlog", "Deferred", "deferred", cwd, now, out);
    await collectDiscarded(fs, s, "checkpoint", "Excluded", "excluded", cwd, now, out);
  }
  return out;
}

async function collectDiscarded(
  fs: FileSystemPort,
  session: IndexedSession,
  artifact: "backlog" | "checkpoint",
  heading: string,
  kind: DiscardedKind,
  cwd: string,
  now: Date,
  out: IndexedDiscarded[],
): Promise<void> {
  try {
    const path = await findArtifact(session.path, artifact, fs);
    if (!path) return;
    const items = listItems(parseMdSectionLooseBilingual(await fs.readText(path), heading));
    if (items.length === 0) return;
    const ts = await resolveTimestamp(fs, path, undefined, now);
    for (const text of items) {
      out.push({
        source: session.code ?? session.folder,
        source_path: relFromCwd(session.path, cwd),
        kind,
        text,
        date: ts.date,
        relative: ts.relative,
      });
    }
  } catch {
    // skip unreadable artifact
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface DocFile {
  path: string;
  number: string;
  slug: string;
}

async function listMarkdown(fs: FileSystemPort, dir: string, re: RegExp): Promise<DocFile[]> {
  if (!(await safeExists(fs, dir))) return [];
  let entries: Awaited<ReturnType<FileSystemPort["list"]>>;
  try {
    entries = await fs.list(dir);
  } catch {
    return [];
  }
  const out: DocFile[] = [];
  for (const e of entries) {
    if (e.type !== "file") continue;
    const m = re.exec(e.name);
    if (!m?.[1]) continue;
    out.push({ path: e.path, number: m[1], slug: m[2] ?? "" });
  }
  return out;
}

/** Drop legacy `NNN-spec-refined.md` when another file shares its number. */
function dedupeRefined(files: DocFile[]): DocFile[] {
  const byNumber = new Map<string, DocFile[]>();
  for (const f of files) {
    const group = byNumber.get(f.number) ?? [];
    group.push(f);
    byNumber.set(f.number, group);
  }
  const out: DocFile[] = [];
  for (const group of byNumber.values()) {
    const isRefined = (f: DocFile) => /(^|-)refined$/i.test(f.slug);
    const nonRefined = group.filter((f) => !isRefined(f));
    const chosen = nonRefined.length > 0 ? nonRefined : group;
    chosen.sort((a, b) => a.path.localeCompare(b.path));
    const first = chosen[0];
    if (first) out.push(first);
  }
  return out;
}

function sortByNumber<T extends { number: string; file: string }>(items: T[]): T[] {
  return items.sort(
    (a, b) => compareCorrelatives(a.number, b.number) || a.file.localeCompare(b.file),
  );
}

function compareNumberedStrings(left: string, right: string): number {
  if (left.length === 0 || right.length === 0) return left.localeCompare(right);
  if (!isCorrelative(left) || !isCorrelative(right)) return left.localeCompare(right);
  return compareCorrelatives(left, right);
}

interface ResolvedTimestamp {
  date: string;
  relative: string;
}

/**
 * Best-available timestamp for `relative`/`date`: full-precision fs mtime if the
 * path stats, else a date-only fallback projected to local noon, else `now`.
 */
async function resolveTimestamp(
  fs: FileSystemPort,
  path: string,
  fallbackDateOnly: string | undefined,
  now: Date,
): Promise<ResolvedTimestamp> {
  let mtime: Date | null = null;
  try {
    mtime = (await fs.stat(path)).mtime;
  } catch {
    mtime = null;
  }
  const when = mtime ?? dateOnlyToNoon(fallbackDateOnly) ?? now;
  return { date: localDateIso(when), relative: humanizeRelativeEs(when, now) };
}

function dateOnlyToNoon(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}

async function safeExists(fs: FileSystemPort, path: string): Promise<boolean> {
  try {
    return await fs.exists(path);
  } catch {
    return false;
  }
}

function relFromCwd(path: string, cwd: string): string {
  // path.relative handles the win32 case a raw string-prefix strip missed: join()
  // yields backslash paths while the old prefix appended a forward slash, so the
  // strip never matched and status showed absolute paths. Normalize to forward
  // slashes so the displayed path reads the same on every OS.
  return relative(cwd, path).split("\\").join("/");
}

/**
 * Like `parseMdSection` but tolerant of the template heading annotations
 * (`## Excluded (list):`, `## Deferred (text):`) — ignores a trailing
 * `(...)` / `:`; needed for legacy artifacts that still carry the suffix.
 */
const parseMdSectionLoose = (text: string, heading: string): string | undefined =>
  parseMdSection(text, heading, normalizeHeading);

/**
 * Both halves at once: the bilingual aliases AND the loose heading normalization
 * above. The discarded list is the reader that needs both.
 *
 * Kept apart from {@link parseMdSectionLoose} on purpose. Making that one
 * bilingual would also have changed what counts as a legacy ready mark and how
 * open questions are found — two behaviours nobody asked to move, on documents
 * this change has no business reinterpreting.
 */
const parseMdSectionLooseBilingual = (text: string, heading: string): string | undefined =>
  parseMdSectionBilingual(text, heading, normalizeHeading);

function normalizeHeading(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*:?\s*$/, "")
    .replace(/:\s*$/, "")
    .trim();
}

/** List-item lines of a section, dropping the `List of …` template placeholder. */
function listItems(section: string | undefined): string[] {
  if (!section) return [];
  const out: string[] = [];
  for (const raw of section.split("\n")) {
    // Ordered lists count too. A `## Deferred` whose items were written `1.`/`2.`
    // used to be dropped whole, in silence — and it was the two items naming how
    // to unblock a plan that vanished that way.
    const m = /^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/.exec(raw);
    if (!m?.[1]) continue;
    const text = m[1].trim();
    if (text.length === 0) continue;
    if (/^list of\b/i.test(text)) continue; // template placeholder
    out.push(text);
  }
  return out;
}

function countOpenQuestions(text: string): number {
  const sec = parseMdSectionLoose(text, "Open questions");
  if (!sec) return 0;
  const first = (firstNonEmptyLine(sec) ?? "").toLowerCase();
  if (first.length === 0) return 0;
  if (/^[-*]?\s*(none|ninguna|ninguno|n\/a|—|-)\.?$/.test(first)) return 0;
  const bullets = sec.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
  return bullets > 0 ? bullets : 1;
}
