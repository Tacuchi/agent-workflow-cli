/**
 * The Workline operations this CLI runs for itself, and nothing else.
 *
 * Every handler below calls a service that already exists — the same one the
 * public command calls — so there is no second implementation of the board, of a
 * session's artifacts or of a close that could answer differently from `aw status`,
 * `aw session-artifacts` or `aw session-close`. What this module adds is the
 * translation between an operation and the two things the flow contract needs back:
 * the REAL output, so the verdict has something to judge, and whether that output
 * satisfies what the transition demanded, so nothing is credited on a reading that
 * came back empty.
 *
 * Three properties hold by construction and the tests pin all three:
 *
 * - **No process leaves.** Nothing here spawns, runs a command, resolves a binary
 *   or reaches a model. The `ProcessPort` is not a dependency, which is stronger
 *   than a rule about not using it.
 * - **No arbitrary invocation.** The row's `program` and `args` are never read; the
 *   handler is chosen by the declared operation and its parameters travel in the
 *   declaration. A row could name `rm -rf` in its invocation and this file would
 *   still only project a board.
 * - **The verdict is the output's, not the caller's.** `ok` is computed from what
 *   the service returned. A read that resolved nothing is `ok: false` with its
 *   reason, and the boundary stays standing.
 */

import { join } from "node:path";
import type { EffectClass } from "../../domain/capability/effects.js";
import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import type { InternalActionPlan } from "../../domain/flow/authority.js";
import {
  type FlowRunScope,
  type FlowRunState,
  type PlanExecBatch,
  withPlanExecBatch,
  withPlanExecBatchLoop,
} from "../../domain/flow/run-state.js";
import { type LocalProposal, sealProposal } from "../../domain/proposal.js";
import type { EnvPort } from "../../ports/env.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import type { ResolvedRuntime } from "../../runtime/types.js";
import { runArtifactsCommand } from "../artifacts-service.js";
import {
  appendClaimEvent,
  claimKey,
  claimShapedAmong,
  completedClaimsIn,
  ledgerPath,
  openClaimsOf,
  readClaimEvents,
  revokedAmong,
} from "../claims-ledger.js";
import { applyLocalProposal } from "../local-proposal.js";
import { parseMdSectionBilingual } from "../markdown.js";
import { parsePhases } from "../parsers/phases.js";
import { parseTasks } from "../parsers/tasks.js";
import { type PathsService, resolveWorkspaceRoot } from "../paths-service.js";
import {
  type BatchPhaseUpdate,
  inferPlanExecBatch,
  preparePlanExecDoneSeal,
  publishPlanExecBatch,
} from "../plan-exec-batch-service.js";
import { readSessionArtifacts } from "../release-data/artifacts.js";
import { canonicalJson } from "../semantic-operation/protocol.js";
import { runSessionClose } from "../session-close-service.js";
import { recordPublication } from "../session-custody-recorder.js";
import { runStatusCommand } from "../status-service.js";
import { buildWorklineIndex } from "../workline-index-service.js";
import { type IsolationUnit, runWorktree } from "../worktree-service.js";
import { applyUnderLock, locateRun, readRun } from "./run-state-service.js";

/** The run's own coordinates — the only scope an internal operation may touch. */
export interface InternalActionRun {
  session: string;
  code: string;
  /**
   * The plan and the sources the run fixed, when it already has them.
   *
   * It travels with the coordinates for the same reason the proposal does: the
   * acquisition must obtain units for exactly the sources the run declared and
   * had validated, and re-deriving that list from anywhere else would open the
   * window where what was scoped and what gets isolated are two things.
   */
  scope: FlowRunScope | null;
  /**
   * The sealed local change the run is holding, when it has one.
   *
   * It travels with the coordinates rather than being looked up, for the same
   * reason `dump` travels in the declaration: the executor must publish the exact
   * proposal the approval named, and re-reading it from anywhere else would open
   * the window where what was approved and what gets written are two things.
   */
  proposal: LocalProposal | null;
  /** Current run seal, so a stateful internal operation can preserve its CAS. */
  state_digest?: string;
}

export interface InternalActionOutcome {
  /** Whether the operation really produced what its transition demands. */
  ok: boolean;
  /**
   * One line derived from the output itself — the material cause, either way.
   *
   * It carries the diagnosis on the refusal path too, which is why there is no
   * separate failure code: the boundary already speaks the flow contract's own
   * vocabulary, and a second code beside it would be two answers to "why did this
   * not apply?". What only this line can say is WHICH precondition was missing.
   */
  summary: string;
  /** The output, canonical, so it can be sealed and judged rather than believed. */
  output: string;
  /** What the operation ACTUALLY applied — never what the row hoped it would. */
  effects: EffectClass[];
  /**
   * A stateful operation may have advanced a durable sub-ledger before the
   * driver applies its transition. `internal-drive` settles from this seal,
   * never from the state that existed before the operation ran.
   */
  state?: FlowRunState;
}

export type InternalActionExecutor = (
  plan: InternalActionPlan,
  run: InternalActionRun,
) => Promise<InternalActionOutcome>;

export interface InternalActionDeps {
  fs: FileSystemPort;
  env: EnvPort;
  paths: PathsService;
  git: GitPort;
  runtime?: ResolvedRuntime;
}

export function internalActionExecutor(deps: InternalActionDeps): InternalActionExecutor {
  return async (plan, run) => {
    switch (plan.operation) {
      case "workspace.board":
        return board(deps);
      case "session.artifacts":
        return artifacts(deps, run, plan.dump ?? null);
      case "session.close":
        return close(deps, run);
      case "worktree.ensure":
        return ensureUnits(deps, run);
      case "proposal.publish":
        return publish(deps, run);
      case "plan-exec.batch-infer":
        return inferBatch(deps, run);
      case "plan-exec.batch-close":
        return closeBatch(deps, run);
      case "plan-exec.plan-done":
        return sealPlanDone(deps, run);
    }
  };
}

/**
 * Give the run one isolation unit per source it scoped — all of them, or none
 * credited.
 *
 * It goes through the SAME `runWorktree` the public command calls, so where a
 * unit lives, which branch it sits on and what happens when somebody else already
 * holds that branch are one implementation and not two that could disagree about
 * whose tree a flow is entitled to.
 *
 * The first refusal stops it, and that is deliberate: a partial acquisition would
 * leave the run believing it is isolated on the sources it got while the boundary
 * it is about to cross — "implement" — writes to all of them. The units already
 * obtained are NOT undone, because they are idempotent and the retry reuses them.
 */
async function ensureUnits(
  deps: InternalActionDeps,
  run: InternalActionRun,
): Promise<InternalActionOutcome> {
  const scope = run.scope;
  if (scope === null) {
    return refusal(
      "worktree.ensure",
      "la corrida no fijó qué fuentes edita: no hay unidad que adquirir",
      canonicalJson({ scope: null }),
    );
  }
  const acquired: IsolationUnit[] = [];
  for (const alias of scope.sources) {
    // `workspace` is the documentary/control checkout itself. It is a valid
    // source-bounded proof surface, but never a source repository that needs a
    // per-session Git worktree.
    if (alias === "workspace") continue;
    const result = await runWorktree(
      { fs: deps.fs, env: deps.env, git: deps.git, paths: deps.paths },
      { action: "ensure", alias, sessionCode: run.code },
    );
    if ("error" in result) {
      return refusal(
        "worktree.ensure",
        `${alias}: ${result.message}${result.hint === undefined ? "" : ` — ${result.hint}`}`,
        canonicalJson({ alias, failure: result, acquired }),
      );
    }
    // `ensure` answers with the unit; the union's other members belong to verbs
    // this call never asks for. Narrowed rather than cast: the day one of them
    // could come back, this is where the compiler says so.
    if (!("created" in result)) {
      return refusal(
        "worktree.ensure",
        `${alias}: la adquisición no devolvió una unidad`,
        canonicalJson({ alias, result }),
      );
    }
    acquired.push(result);
  }
  return {
    ok: true,
    summary: `unidades de ${run.session}: ${acquired.map((unit) => `${unit.alias} → ${unit.branch}`).join(", ")}`,
    output: canonicalJson({ plan: scope.plan, units: acquired }),
    // The tree IS there, however it got there — the same reading `proposal.publish`
    // makes of a re-entry that finds the bytes already written. Crediting nothing
    // when `created` is false would refuse the resumption this row is idempotent for.
    effects: ["local_additive"],
  };
}

/**
 * Write the run's approved proposal — all of it, or none of it.
 *
 * It goes through the SAME `applyLocalProposal` the capability's `apply` stage
 * uses, so the approval seal, the compare-and-swap and the all-or-nothing
 * publication are one implementation and not two that could disagree about when a
 * write is legitimate. The approval it hands over is the proposal's own seal:
 * reaching this row at all means `authorizeTransition` found a grant given over
 * exactly that seal, and a grant over anything else never gets here.
 */
async function publish(
  deps: InternalActionDeps,
  run: InternalActionRun,
): Promise<InternalActionOutcome> {
  const proposal = run.proposal;
  if (proposal === null) {
    return refusal(
      "proposal.publish",
      "la corrida no tiene ninguna propuesta sellada que publicar",
      canonicalJson({ proposal: null }),
    );
  }
  const root = await resolveWorkspaceRoot(deps.fs, deps.env, deps.paths);
  const applied = await applyLocalProposal(deps.fs, deps.paths, {
    root,
    proposal,
    approval: { digest: proposal.digest, granted: proposal.requires_approval },
    selfAuthorized: proposal.effects.filter(
      (effect) => !proposal.requires_approval.includes(effect),
    ),
    // The run's session owns whatever this publication creates or overwrites, and
    // the baseline is sealed while the previous bytes still exist. A legacy
    // session with no custody records nothing and publishes exactly as before.
    // The fence travels INTO the critical section: a recovery can revoke a claim
    // and free its correlative at any instant, so a check made out here would be
    // a check made before the lock — precisely the window it must close.
    precondition: (destinations) => revokedFence(deps, run.session, destinations),
    recordBaseline: (destinations) =>
      recordPublication({ fs: deps.fs, paths: deps.paths }, run.session, destinations).then(
        () => undefined,
      ),
  });
  if (!applied.ok) {
    return refusal(
      "proposal.publish",
      `${applied.failure.message} — ${applied.failure.action}`,
      canonicalJson({ failure: applied.failure, applied: applied.applied }),
    );
  }
  const result = applied.result;
  const destinations = proposal.artifacts.map((a) => a.path);
  const claims = await recordCompletedClaims(deps, run.session, result, destinations);
  return {
    ok: true,
    summary: result.already_applied
      ? `la propuesta ya estaba aplicada: ${destinations.join(", ")} sin cambios`
      : `publicado: ${result.written.join(", ")}`,
    output: canonicalJson({ ...result, digest: proposal.digest, destinations, claims }),
    // Only what really landed. A re-entry that found the bytes already there
    // credits the same classes — the effect IS applied — and the summary is what
    // distinguishes "now" from "already", which is the honest split.
    effects: [...result.applied],
  };
}

/**
 * The revocation that forbids this publication, or `null` when none does.
 *
 * Fail-closed, and scoped so it cannot become a general outage: a ledger with
 * unreadable lines cannot prove the ABSENCE of a revocation, so a write that
 * COULD be completing a reservation refuses rather than guesses. A destination
 * that is not a numbered document in a category cannot be a reservation, so it is
 * never held up by a ledger it does not depend on — an unreadable ledger must not
 * stop every loop in the system from saving.
 */
async function revokedFence(
  deps: InternalActionDeps,
  owner: string,
  destinations: readonly string[],
): Promise<CapabilityFailure | null> {
  const read = await readClaimEvents(deps.fs, deps.paths);
  const blocked = revokedAmong(read.events, owner, destinations);
  if (blocked.length > 0) {
    return {
      code: "CLAIM_REVOKED",
      message: `la publicación fue revocada: ${blocked.map((c) => claimKey(c)).join(", ")} ya volvió al conjunto elegible y su correlativo puede ser de otro`,
      action:
        "el correlativo ya no es de esta corrida: pedí uno nuevo con 'aw next-number --claim' y volvé a sellar la propuesta",
    };
  }
  if (read.unreadable > 0) {
    // Scoped to claims this owner ACTUALLY holds in the ledger, not to every
    // numbered destination. Otherwise one unparseable line — and this file is a
    // committed append-only JSONL, so a merge conflict produces exactly that —
    // would refuse every SPEC, PLAN and QUICK save in the workspace, which is a
    // workspace-wide outage rather than the narrow fail-closed this needs to be.
    const mine = new Set(openClaimsOf(read.events, owner).map((claim) => claimKey(claim)));
    const atRisk = claimShapedAmong(owner, destinations).filter((claim) =>
      mine.has(claimKey(claim)),
    );
    if (atRisk.length > 0) {
      return {
        code: "CLAIM_LEDGER_UNREADABLE",
        message: `el registro de claims tiene ${read.unreadable} línea(s) ilegible(s), así que no se puede probar que ${atRisk.map((c) => claimKey(c)).join(", ")} no esté revocado`,
        action: `arreglá las líneas ilegibles de ${ledgerPath(deps.paths)} (una por línea, JSON válido) y volvé a publicar`,
      };
    }
  }
  return null;
}

/** What the completion recording managed to do, so none of it has to be silent. */
interface ClaimRecording {
  recorded: string[];
  /** The ledger could not be read or appended to. Reported, never swallowed. */
  ledger_error?: string;
  /** Lines that did not parse: the open set may be incomplete, so say so. */
  ledger_unreadable?: number;
}

/**
 * Record every open claim of this session that the publication just completed.
 *
 * Completing a reservation is a PUBLICATION: the correlative is spent for good
 * and must never come back to the eligible set. Getting this wrong in either
 * direction is durable, so both directions are handled deliberately:
 *
 * - **Under-recording is the dangerous one.** A claim left open about a
 *   correlative that is holding a published document is an invitation for a later
 *   recovery to release a live document. That is why the already-applied re-entry
 *   is covered too: `applyLocalProposal` answers that case with `written: []`, and
 *   returning early on an empty list left the claim open forever, unfixable,
 *   because every retry answers the same way.
 * - **Over-recording is a durable lie.** So a destination only counts when it
 *   closes one of THIS owner's open claims, read from the ledger itself. Any other
 *   write travels through this same publication path and must record nothing.
 *
 * It never fails the publication — the bytes are already on disk and the person's
 * document exists — but it never goes quiet either: what it could not do comes
 * back to the caller and into the operation's output.
 */
async function recordCompletedClaims(
  deps: InternalActionDeps,
  owner: string,
  result: { written: readonly string[]; already_applied: boolean },
  destinations: readonly string[],
): Promise<ClaimRecording> {
  const recorded: string[] = [];
  try {
    const read = await readClaimEvents(deps.fs, deps.paths);
    const completed = completedClaimsIn(read.events, owner, {
      written: result.written,
      already_applied: result.already_applied,
      destinations,
    });
    for (const claim of completed) {
      await appendClaimEvent(deps.fs, deps.paths, {
        at: new Date().toISOString(),
        event: "published",
        claim,
        cause: "la propuesta sellada de su dueño completó la reserva",
      });
      recorded.push(`${claim.category}/${claim.correlative}-${claim.name}`);
    }
    return {
      recorded,
      ...(read.unreadable > 0 ? { ledger_unreadable: read.unreadable } : {}),
    };
  } catch (error) {
    return {
      recorded,
      ledger_error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function board(deps: InternalActionDeps): Promise<InternalActionOutcome> {
  const data = await runStatusCommand(deps.fs, deps.env, deps.paths, { git: deps.git });
  const counts = data.counts;
  return {
    ok: true,
    summary: `tablero: ${counts.specs} specs, ${counts.plans} planes, ${counts.sessions_active} sesiones activas, ${counts.pending} pendientes`,
    output: canonicalJson(data),
    effects: ["read_only"],
  };
}

/**
 * The session's artifacts: the presence report always, plus the content of the
 * kinds the transition needs.
 *
 * Both halves are read even when a dump is requested, because they answer
 * different questions and the transitions demand both: the report says the
 * session exists as an artifact and how many success criteria it carries; the dump
 * says the specific artifacts have content. A dump alone would pass a session
 * whose criteria were never seeded.
 */
async function artifacts(
  deps: InternalActionDeps,
  run: InternalActionRun,
  dump: readonly string[] | null,
): Promise<InternalActionOutcome> {
  // The presence report, without the narrative: this operation checks that the
  // artifacts are THERE, and projecting the session's whole reading to answer
  // that would be work nobody asked for on every advance.
  const report = await runArtifactsCommand(deps.fs, deps.env, deps.paths, {
    code: run.code,
    noNarrative: true,
  });
  if ("sessionError" in report) {
    return refusal(
      "session.artifacts",
      `no se pudo resolver la sesión '${run.code}'`,
      canonicalJson(report),
    );
  }
  if (report.artifacts.session === null) {
    return refusal(
      "session.artifacts",
      `la sesión '${report.session}' no tiene su SESSION.md`,
      canonicalJson(report),
    );
  }

  if (dump === null) {
    return {
      ok: true,
      summary: `sesión ${report.session}: SESSION.md presente, ${report.artifacts.session.criterios_count} criterios, ${report.artifacts.decisiones_count} decisiones`,
      output: canonicalJson(report),
      effects: SEEDED_EFFECTS,
    };
  }

  const dumped = await readSessionArtifacts(deps.fs, deps.paths, run.code, [...dump], deps.runtime);
  const output = canonicalJson({ report, dump: dumped });
  if (dumped.error !== undefined) {
    return refusal("session.artifacts", String(dumped.hint ?? dumped.error), output);
  }
  const empty = dump.filter((kind) => !hasContent(dumped[kind]));
  if (empty.length > 0) {
    return refusal("session.artifacts", `sin contenido: ${empty.join(", ")}`, output);
  }
  // `objetivo` is the artifact that carries the success criteria, so demanding it
  // is demanding them: a SESSION.md with a criteria heading and nothing under it
  // is exactly the seed this row exists to make checkable. The count is not enough
  // — `session-create` seeds an empty `- [ ]`, and a criterion with no text is the
  // template, not a done-condition anybody could falsify.
  if (dump.includes("objetivo") && !hasWrittenCriteria(dumped.objetivo)) {
    return refusal(
      "session.artifacts",
      "el SESSION.md no declara ningún criterio de éxito escrito",
      output,
    );
  }
  return {
    ok: true,
    summary: `sesión ${report.session}: ${dump.join(", ")} con contenido, ${report.artifacts.session.criterios_count} criterios`,
    output,
    effects: SEEDED_EFFECTS,
  };
}

/**
 * What a satisfied artifact reading really attests.
 *
 * `local_additive` travels with the success path and only with it, and that is not
 * the executor crediting itself with a write. The rows this operation serves stand
 * for a SEEDING — the session, its objective, its criteria, its CHECKPOINT, its
 * `SCRIPTS.sql` — and the artifact being there is the effect, materially, however
 * it got there. Observing it is a stronger claim than the external contract ever
 * had, where whoever answered simply asserted the class. On the refusal path the
 * list is empty, so a reading that found nothing credits nothing.
 */
const SEEDED_EFFECTS: EffectClass[] = ["read_only", "local_additive"];

/**
 * Whether a dumped artifact really came back with something in it.
 *
 * `scripts` is a LIST and every other kind is a record with `content`, so the two
 * shapes are checked as what they are. Treating a missing artifact, an unreadable
 * one and an empty one alike is deliberate: all three mean the transition's
 * evidence is not there, and the row's own recovery says what to do about it.
 */
/** A criterion with something written after its box. An empty one is the template. */
const WRITTEN_CRITERION = /^[ \t]*[-*][ \t]+\[[ xX]?\][ \t]*\S/m;

/**
 * Whether the dumped SESSION really declares a done-condition.
 *
 * Scoped to the criteria section through the SAME parser the artifacts report
 * uses, and not to the whole document: a checkbox under `Origin` or inside a code
 * fence is not a success criterion, and a check that counted those would pass the
 * one session it exists to catch.
 */
function hasWrittenCriteria(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const content = (value as { content?: unknown }).content;
  if (typeof content !== "string") return false;
  const section =
    parseMdSectionBilingual(content, "Success criteria") ??
    parseMdSectionBilingual(content, "Criterios de aceptación");
  return section !== undefined && WRITTEN_CRITERION.test(section);
}

function hasContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value === null || typeof value !== "object") return false;
  const content = (value as { content?: unknown }).content;
  return typeof content === "string" && content.trim().length > 0;
}

/**
 * Seal the next batch while the cursor is standing on `batch-inference`.
 *
 * This is intentionally separate from publication.  A batch is a snapshot of
 * work that exists before isolation/implementation/validation, so closing it is
 * never allowed to manufacture that snapshot retroactively from whatever text
 * happens to be left after work.  Re-entering an already inferred batch is a
 * no-op: the original digest remains the authority and a moved plan is caught by
 * the later publication CAS.
 */
async function inferBatch(
  deps: InternalActionDeps,
  run: InternalActionRun,
): Promise<InternalActionOutcome> {
  if (run.scope === null) {
    return refusal(
      "plan-exec.batch-infer",
      "la corrida no fijó el plan cuyo batch debe inferir",
      canonicalJson({ scope: null }),
    );
  }
  const scope = run.scope;
  const root = await resolveWorkspaceRoot(deps.fs, deps.env, deps.paths);
  const location = locateRun(deps.paths, run.session);
  const inferred = await applyUnderLock<{
    batch: PlanExecBatch | null;
    created: boolean;
    no_work: boolean;
  }>(
    deps.fs,
    location,
    async (current) => {
      if (current === null) {
        return {
          ok: false,
          failure: {
            code: "FLOW_RUN_ABSENT",
            message: "la corrida desapareció antes de sellar su batch",
            action: "reanudá la corrida con 'aw flow advance' antes de inferir el batch",
          },
        };
      }
      const active = (current.batches ?? []).find(
        (batch) => batch.published_plan_digest === undefined,
      );
      if (active !== undefined) {
        return {
          ok: true,
          state: current,
          value: { batch: active, created: false, no_work: false },
          persist: false,
        };
      }
      let text: string;
      try {
        text = await deps.fs.readText(join(root, scope.plan));
      } catch {
        return {
          ok: false,
          failure: {
            code: "PLAN_EXEC_BATCH_PLAN_UNREADABLE",
            message: `no se puede leer '${scope.plan}' para inferir el batch`,
            action: "restaurá o fijá el plan del scope antes de continuar la ejecución",
          },
        };
      }
      const next = inferNextBatch(text, current);
      if (!next.ok) {
        if (next.failure.code !== "PLAN_EXEC_BATCH_NONE_OPEN") {
          return { ok: false, failure: next.failure };
        }
        return {
          ok: true,
          state: withPlanExecBatchLoop(current, { pending: false, iteration: null }),
          value: { batch: null, created: false, no_work: true },
        };
      }
      return {
        ok: true,
        state: withPlanExecBatch(current, next.batch),
        value: { batch: next.batch, created: true, no_work: false },
      };
    },
    run.state_digest === undefined ? {} : { expectDigest: run.state_digest },
  );
  if (!inferred.ok) {
    return refusal(
      "plan-exec.batch-infer",
      `${inferred.failure.message} — ${inferred.failure.action}`,
      canonicalJson({ failure: inferred.failure }),
    );
  }
  return {
    ok: true,
    summary: inferred.value.no_work
      ? "el plan ya no tiene tareas abiertas: se omite el batch vacío y se expone la validación final"
      : inferred.value.created
        ? `batch ${inferred.value.batch?.id ?? "nuevo"} inferido y sellado antes de implementar`
        : `batch ${inferred.value.batch?.id ?? "actual"} ya estaba inferido; se conserva su snapshot sellado`,
    output: canonicalJson({ batch: inferred.value.batch, created: inferred.value.created }),
    effects: [],
    state: inferred.state,
  };
}

/**
 * Close the already inferred real batch, not a human-declared list of effects.
 *
 * This executes only after the batch's validation and review rows. It reads the
 * batch snapshot sealed at inference, then lets `publishPlanExecBatch` persist
 * intent → document CAS → v10 trace.
 * A re-entry finds the pending sealed batch and either confirms its after-digest
 * or fails stale; it never credits a second range because an agent said so.
 */
async function closeBatch(
  deps: InternalActionDeps,
  run: InternalActionRun,
): Promise<InternalActionOutcome> {
  if (run.scope === null) {
    return refusal(
      "plan-exec.batch-close",
      "la corrida no fijó el plan cuyo batch debe cerrar",
      canonicalJson({ scope: null }),
    );
  }
  const location = locateRun(deps.paths, run.session);
  const live = await readRun(deps.fs, location);
  if (!live.ok) {
    return refusal(
      "plan-exec.batch-close",
      `${live.failure.message} — ${live.failure.action}`,
      canonicalJson({ failure: live.failure }),
    );
  }
  if (run.state_digest !== undefined && live.state.digest !== run.state_digest) {
    return refusal(
      "plan-exec.batch-close",
      "la corrida cambió mientras se preparaba el cierre del batch",
      canonicalJson({ expected: run.state_digest, actual: live.state.digest }),
    );
  }
  const root = await resolveWorkspaceRoot(deps.fs, deps.env, deps.paths);
  let text: string;
  try {
    text = await deps.fs.readText(join(root, run.scope.plan));
  } catch {
    return refusal(
      "plan-exec.batch-close",
      `no se puede leer '${run.scope.plan}'`,
      canonicalJson({ plan: run.scope.plan }),
    );
  }
  const batch = (live.state.batches ?? []).find(
    (current) => current.published_plan_digest === undefined,
  );
  if (batch === undefined) {
    return refusal(
      "plan-exec.batch-close",
      "no hay un batch inferido para cerrar: la corrida no puede acreditar tareas que no selló antes de implementarlas",
      canonicalJson({ code: "PLAN_EXEC_BATCH_NOT_INFERRED", plan: run.scope.plan }),
    );
  }
  const phaseUpdates = phaseUpdatesForClosedBatch(text, batch);
  if (!phaseUpdates.ok) {
    return refusal(
      "plan-exec.batch-close",
      `${phaseUpdates.failure.message} — ${phaseUpdates.failure.action}`,
      canonicalJson({ failure: phaseUpdates.failure }),
    );
  }
  const published = await publishPlanExecBatch(deps.fs, deps.paths, {
    root,
    location,
    state_digest: live.state.digest,
    plan: run.scope.plan,
    batch,
    completed_tasks: batch.tasks,
    phase_updates: phaseUpdates.updates,
    transition: "plan-exec.batch-close",
  });
  if (!published.ok) {
    return refusal(
      "plan-exec.batch-close",
      `${published.failure.message} — ${published.failure.action}`,
      canonicalJson({ failure: published.failure }),
    );
  }
  return {
    ok: true,
    summary: published.already_applied
      ? `batch ${published.batch.id} ya estaba publicado en ${run.scope.plan}`
      : `batch ${published.batch.id} publicado: ${published.written.join(", ")}`,
    output: canonicalJson({
      batch: published.batch,
      written: published.written,
      already_applied: published.already_applied,
    }),
    effects: ["mutate_overwrite"],
    state: published.state,
  };
}

const PLAN_DONE_REQUIRED_TRANSITIONS = [
  "plan-exec.final-validation",
  "plan-exec.commit-execution",
  "plan-exec.unit-integration",
] as const;

/**
 * Write the final plan seal from the evidence the run already owns.
 *
 * This is intentionally an internal action rather than a request to edit a
 * Markdown line.  The caller cannot assert that the plan is done: every retry
 * rereads the run, rechecks the documentary closure under the workspace lock,
 * and publishes only the deterministic `Estado` / `Cierre` pair.
 */
async function sealPlanDone(
  deps: InternalActionDeps,
  run: InternalActionRun,
): Promise<InternalActionOutcome> {
  if (run.scope === null) {
    return refusal(
      "plan-exec.plan-done",
      "la corrida no fijó el plan que debe sellarse",
      canonicalJson({ scope: null }),
    );
  }
  const location = locateRun(deps.paths, run.session);
  const live = await readRun(deps.fs, location);
  if (!live.ok) {
    return refusal(
      "plan-exec.plan-done",
      `${live.failure.message} — ${live.failure.action}`,
      canonicalJson({ failure: live.failure }),
    );
  }
  if (run.state_digest !== undefined && live.state.digest !== run.state_digest) {
    return refusal(
      "plan-exec.plan-done",
      "la corrida cambió mientras se preparaba el sello final",
      canonicalJson({ expected: run.state_digest, actual: live.state.digest }),
    );
  }
  const missing = PLAN_DONE_REQUIRED_TRANSITIONS.filter(
    (transition) => !live.state.applied.includes(transition),
  );
  if (missing.length > 0) {
    return refusal(
      "plan-exec.plan-done",
      `todavía falta evidencia de ${missing.join(", ")}`,
      canonicalJson({ code: "PLAN_EXEC_DONE_PREREQUISITE", missing }),
    );
  }
  const activeBatch = (live.state.batches ?? []).find(
    (batch) => batch.published_plan_digest === undefined,
  );
  if (activeBatch !== undefined || live.state.batch_loop?.pending !== false) {
    return refusal(
      "plan-exec.plan-done",
      "la corrida aún tiene un batch abierto o no cerró el ciclo de batches",
      canonicalJson({
        code: "PLAN_EXEC_DONE_BATCH_PENDING",
        active_batch: activeBatch?.id ?? null,
        batch_loop: live.state.batch_loop ?? null,
      }),
    );
  }

  const root = await resolveWorkspaceRoot(deps.fs, deps.env, deps.paths);
  let text: string;
  try {
    text = await deps.fs.readText(join(root, run.scope.plan));
  } catch {
    return refusal(
      "plan-exec.plan-done",
      `no se puede leer '${run.scope.plan}'`,
      canonicalJson({ code: "PLAN_EXEC_DONE_PLAN_UNREADABLE", plan: run.scope.plan }),
    );
  }
  const closure = `validación final, commits e integración acreditados por la corrida ${run.session}`;
  const prepared = preparePlanExecDoneSeal(text, { plan: run.scope.plan, closure });
  if (!prepared.ok) {
    return refusal(
      "plan-exec.plan-done",
      `${prepared.failure.message} — ${prepared.failure.action}`,
      canonicalJson({ failure: prepared.failure }),
    );
  }

  const proposal = sealProposal({
    operation: "plan-exec.plan-done",
    artifacts: [{ path: run.scope.plan, content: prepared.prepared.content, overwrite: true }],
    bases: [{ path: run.scope.plan, digest: prepared.prepared.before_digest }],
    effects: ["mutate_overwrite"],
    requiresApproval: [],
  });
  const applied = await applyLocalProposal(deps.fs, deps.paths, {
    root,
    proposal,
    approval: { digest: proposal.digest, granted: [] },
    selfAuthorized: ["mutate_overwrite"],
    // The index is re-read while the document publication holds the workspace
    // lock.  This closes the decision-note race: a new compensatory obligation
    // cannot appear between the run's earlier reading and a `done` write.
    precondition: () => planDonePrecondition(deps, run.scope?.plan ?? ""),
  });
  if (!applied.ok) {
    return refusal(
      "plan-exec.plan-done",
      `${applied.failure.message} — ${applied.failure.action}`,
      canonicalJson({ failure: applied.failure }),
    );
  }
  return {
    ok: true,
    summary: applied.result.already_applied
      ? `${run.scope.plan} ya tenía el sello done de esta corrida`
      : `${run.scope.plan} sellado done con su línea de cierre`,
    output: canonicalJson({
      plan: run.scope.plan,
      closure,
      written: applied.result.written,
      already_applied: applied.result.already_applied,
    }),
    // A recovered no-op still attests that the exact overwrite is already on
    // disk, like batch publication's already-applied path.
    effects: ["mutate_overwrite"],
  };
}

/** The documentary checks that must pass in the same critical section as done. */
async function planDonePrecondition(
  deps: InternalActionDeps,
  path: string,
): Promise<CapabilityFailure | null> {
  const index = await buildWorklineIndex(deps.fs, deps.env, deps.paths, { git: deps.git });
  if (index.docs_canon_error !== undefined) {
    return {
      code: "PLAN_EXEC_DONE_DOCS_CANON_INVALID",
      message: `no se puede comprobar el cierre: ${index.docs_canon_error}`,
      action: "corregí el canon documental antes de volver a sellar el plan",
    };
  }
  const plan = index.plans.find((candidate) => candidate.file === path);
  if (plan === undefined) {
    return {
      code: "PLAN_EXEC_DONE_PLAN_MISSING",
      message: `el plan '${path}' no está en el índice documental`,
      action: "restaurá el plan en el directorio documental configurado y reintentá",
    };
  }
  if (plan.tasks_done !== plan.tasks_total || plan.phases_validated !== plan.phases_total) {
    return {
      code: "PLAN_EXEC_DONE_COUNTERS_OPEN",
      message: `${path} no está acreditado por completo (${plan.tasks_done}/${plan.tasks_total}, fases ${plan.phases_validated}/${plan.phases_total})`,
      action: "cerrá los batches pendientes; el sello final no acredita tareas ni fases",
    };
  }
  if (plan.reconciliation !== null && !plan.reconciliation.closable) {
    return {
      code: "PLAN_EXEC_DONE_RECONCILIATION_PENDING",
      message: `${path} conserva obligaciones de reconciliación`,
      action: `resolvé la compensación desde ${plan.reconciliation.resume_point ?? "su punto de reanudación"} antes de cerrar`,
    };
  }
  if (
    plan.baseline.status === "divergent" ||
    plan.baseline.status === "malformed" ||
    plan.baseline.status === "unresolved"
  ) {
    return {
      code: "PLAN_EXEC_DONE_BASELINE_INVALID",
      message: `${path} no tiene un baseline ejecutable (${plan.baseline.status})`,
      action:
        plan.baseline.status === "divergent"
          ? `volvé a /w:plan-refine ${path} antes de cerrar; si al revisarlo contra la spec vigente el plan sigue valiendo tal cual, cerrá la divergencia con 'aw reseal prepare ${path}'`
          : "restaurá un baseline legible y su spec antes de cerrar",
    };
  }
  return null;
}

/**
 * The close transition may validate a phase, but it may never erase a blocker to
 * make that true.  A blocked phase remains a typed refusal until its actual
 * blocker has been resolved through the normal plan/deviation route.
 */
function phaseUpdatesForClosedBatch(
  text: string,
  batch: PlanExecBatch,
): { ok: true; updates: BatchPhaseUpdate[] } | { ok: false; failure: CapabilityFailure } {
  const phases = new Map(parsePhases(text).items.map((phase) => [phase.n, phase]));
  for (const number of batch.phases) {
    const phase = phases.get(number);
    if (phase === undefined) {
      return {
        ok: false,
        failure: {
          code: "PLAN_EXEC_BATCH_PHASE_UNKNOWN",
          message: `el batch nombra F${number}, que ya no puede leerse del plan`,
          action:
            "re-inferí el batch sobre el plan vigente; no se cambia una fase que el CLI no puede ubicar",
        },
      };
    }
    if (phase.state === "bloqueada" || phase.blocker !== null) {
      return {
        ok: false,
        failure: {
          code: "PLAN_EXEC_BATCH_PHASE_BLOCKED",
          message: `F${phase.n} conserva un bloqueo y no puede acreditarse como validada`,
          action: "resolvé o escalá el bloqueo; el cierre de batch no borra razones de bloqueo",
        },
      };
    }
  }
  return {
    ok: true,
    // The transition follows completed validation/review, so this is the one
    // allowed state change. `blocker` stays undefined: the publisher preserves
    // document evidence instead of deleting it by convention.
    updates: batch.phases.map((phase) => ({ phase, state: "validada" })),
  };
}

function inferNextBatch(text: string, state: FlowRunState): ReturnType<typeof inferPlanExecBatch> {
  // `inferPlanExecBatch` itself validates that the phase has real, uniquely
  // labelled Tn.m tasks. We only choose the first still-open phase from the
  // document, which is a deterministic batch boundary rather than a claimed one.
  const openPhase = parseTasks(text).items.find(
    (task) => task.status === "open" && task.phase !== undefined,
  )?.phase;
  if (openPhase === undefined) {
    const unresolved = parsePhases(text).items.find((phase) => phase.state !== "validada");
    if (unresolved !== undefined) {
      return {
        ok: false,
        failure: {
          code: "PLAN_EXEC_BATCH_PHASE_UNRESOLVED",
          message: `F${unresolved.n} sigue '${unresolved.state}' pero no tiene tareas abiertas acreditables`,
          action:
            "normalizá la fase con plan-refine; no se salta a la validación final sobre una fase no validada",
        },
      };
    }
    return {
      ok: false,
      failure: {
        code: "PLAN_EXEC_BATCH_NONE_OPEN",
        message: "el plan no tiene una fase con tareas abiertas que este batch pueda acreditar",
        action: "el batch ya está cerrado: reanudá la corrida para que exponga la validación final",
      },
    };
  }
  const iteration = Math.max(0, ...(state.batches ?? []).map((batch) => batch.iteration)) + 1;
  return inferPlanExecBatch(text, {
    id: `batch-${iteration}`,
    iteration,
    mode: "continuous",
    phases: [openPhase],
  });
}

/**
 * Close the run's session — and refuse to, while it still holds a unit.
 *
 * The reader is the same one `aw session-close` builds, so what the flow sees and
 * what a person sees are one reading of `git worktree list`. What differs is what
 * each does with it: the public command reports and closes, this one stops. A
 * directed run reaching here is declaring itself over, and a run whose result is
 * still only on `aw/<session>` is not over — closing would put the last chance to
 * notice behind a `.closed` marker that also makes the remedy stop resolving.
 */
async function close(
  deps: InternalActionDeps,
  run: InternalActionRun,
): Promise<InternalActionOutcome> {
  const result = await runSessionClose(
    deps.fs,
    deps.paths,
    { code: run.code, requireIntegrated: true },
    async () => {
      const listed = await runWorktree(
        { fs: deps.fs, env: deps.env, git: deps.git, paths: deps.paths },
        { action: "list" },
      );
      // A list that did not come back is NOT "no units": the close refuses on it,
      // which is the whole point of asking before writing the marker.
      if (!("units" in listed)) throw new Error(JSON.stringify(listed));
      return listed.units;
    },
  );
  if ("sessionHeld" in result) {
    const held = result.sessionHeld;
    return refusal(
      "session.close",
      `${held.reason} — integralas con '${held.integrate}'`,
      canonicalJson(result),
    );
  }
  if (!("sessionClose" in result)) {
    const why = "sessionError" in result ? canonicalJson(result.sessionError) : result.error;
    return refusal("session.close", `la sesión no cerró: ${why}`, canonicalJson(result));
  }
  const closed = result.sessionClose;
  return {
    ok: closed.closed,
    summary: `sesión ${closed.folder} cerrada${closed.history === undefined ? " (sin fila de HISTORY)" : ` · HISTORY ${closed.history.action}`}`,
    output: canonicalJson(result),
    // Closing ensures the CHECKPOINT exists and rewrites the session's marker plus
    // its HISTORY row: additive and overwriting, both real.
    effects: closed.closed ? ["local_additive", "mutate_overwrite"] : [],
  };
}

function refusal(operation: string, message: string, output: string): InternalActionOutcome {
  return { ok: false, summary: `${operation}: ${message}`, output, effects: [] };
}
