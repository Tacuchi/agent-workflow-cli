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
import type { EnvPort } from "../../ports/env.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import type { ResolvedRuntime } from "../../runtime/types.js";
import { runArtifactsCommand } from "../artifacts-service.js";
import { parseMdSectionBilingual } from "../markdown.js";
import type { PathsService } from "../paths-service.js";
import { readSessionArtifacts } from "../release-data/artifacts.js";
import { canonicalJson } from "../semantic-operation/protocol.js";
import { runSessionClose } from "../session-close-service.js";
import { runStatusCommand } from "../status-service.js";

/** The run's own coordinates — the only scope an internal operation may touch. */
export interface InternalActionRun {
  session: string;
  code: string;
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
    }
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
  const report = await runArtifactsCommand(deps.fs, deps.env, deps.paths, { code: run.code });
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

async function close(
  deps: InternalActionDeps,
  run: InternalActionRun,
): Promise<InternalActionOutcome> {
  const result = await runSessionClose(deps.fs, deps.paths, { code: run.code });
  if (!("sessionClose" in result)) {
    const why = "sessionError" in result ? canonicalJson(result.sessionError) : result.error;
    return refusal("session.close", `la sesión no cerró: ${why}`, canonicalJson(result));
  }
  const closed = result.sessionClose;
  const pending = closed.pending_integration ?? [];
  return {
    ok: closed.closed,
    summary: `sesión ${closed.folder} cerrada${closed.history === undefined ? " (sin fila de HISTORY)" : ` · HISTORY ${closed.history.action}`}${pending.length > 0 ? ` · ${pending.length} unidad(es) sin integrar` : ""}`,
    output: canonicalJson(result),
    // Closing ensures the CHECKPOINT exists and rewrites the session's marker plus
    // its HISTORY row: additive and overwriting, both real.
    effects: closed.closed ? ["local_additive", "mutate_overwrite"] : [],
  };
}

function refusal(operation: string, message: string, output: string): InternalActionOutcome {
  return { ok: false, summary: `${operation}: ${message}`, output, effects: [] };
}
