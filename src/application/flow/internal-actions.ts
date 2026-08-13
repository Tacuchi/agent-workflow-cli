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

import type { EffectClass } from "../../domain/capability/effects.js";
import type { InternalActionPlan } from "../../domain/flow/authority.js";
import type { FlowRunScope } from "../../domain/flow/run-state.js";
import type { LocalProposal } from "../../domain/proposal.js";
import type { EnvPort } from "../../ports/env.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import type { ResolvedRuntime } from "../../runtime/types.js";
import { runArtifactsCommand } from "../artifacts-service.js";
import { applyLocalProposal } from "../local-proposal.js";
import { parseMdSectionBilingual } from "../markdown.js";
import { type PathsService, resolveWorkspaceRoot } from "../paths-service.js";
import { readSessionArtifacts } from "../release-data/artifacts.js";
import { canonicalJson } from "../semantic-operation/protocol.js";
import { runSessionClose } from "../session-close-service.js";
import { runStatusCommand } from "../status-service.js";
import { type IsolationUnit, runWorktree } from "../worktree-service.js";

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
  return {
    ok: true,
    summary: result.already_applied
      ? `la propuesta ya estaba aplicada: ${destinations.join(", ")} sin cambios`
      : `publicado: ${result.written.join(", ")}`,
    output: canonicalJson({ ...result, digest: proposal.digest, destinations }),
    // Only what really landed. A re-entry that found the bytes already there
    // credits the same classes — the effect IS applied — and the summary is what
    // distinguishes "now" from "already", which is the honest split.
    effects: [...result.applied],
  };
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
