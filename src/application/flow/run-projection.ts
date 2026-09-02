/**
 * What a stopped run looks like from OUTSIDE the conversation that stopped it.
 *
 * `resume` and `status` both answer "what is left and how does it continue", and
 * a run standing at a boundary is the most precise answer either of them can
 * give. They read it from HERE, once: two surfaces deriving "what is next" on
 * their own would be the second authority this whole initiative exists to remove
 * — and the one that matters most, because it is the one a person acts on.
 *
 * Read-only and fail-quiet by design: a session with no run is a legacy session
 * (`null`, and the caller keeps its own answer), and a run whose state does not
 * match its journey says so instead of projecting a boundary nobody can trust.
 */

import type { FlowBoundaryKind } from "../../domain/flow/directive.js";
import type { AssuranceStatus } from "../../domain/flow/route.js";
import {
  type FlowRunScope,
  checkAgainstJourney,
  legacyRunNeedsAdoption,
} from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { PathsService } from "../paths-service.js";
import { resolveBoundary } from "./advance.js";
import { journeyForRun } from "./run-journey.js";
import { locateRun, readRun } from "./run-state-service.js";

export interface FlowRunProjection {
  flow: string;
  boundary: FlowBoundaryKind;
  transition: string | null;
  title: string | null;
  /** The exact invocation to run, at an `execution` boundary. Never a paraphrase. */
  invocation: string | null;
  /** The command that continues the run. Presented, never executed. */
  command: string;
  /** One line: where the run stands. */
  summary: string;
  /**
   * The plan this run executes and the sources it isolates, or `null`.
   *
   * Read from the same file the boundary comes from, which is what makes two
   * concurrent runs distinguishable at all: without it every open `plan-exec`
   * session looks like every other one, and `resume` proposes the same next step
   * to both. The units are projected beside it from `worktree list` — one says
   * what the run MAY edit, the other which trees it actually holds.
   */
  scope: FlowRunScope | null;
  /** Null only when the persisted run is unreadable or still legacy. */
  assurance: AssuranceStatus | null;
}

export async function projectRun(
  fs: FileSystemPort,
  paths: PathsService,
  folder: string,
): Promise<FlowRunProjection | null> {
  const read = await readRun(fs, locateRun(paths, folder));
  if (!read.ok) {
    // An absent run is the normal case for every session older than the engine;
    // a refusal is not, and hiding it would let `resume` propose work over a state
    // the engine will not touch.
    if (read.failure.code === "FLOW_RUN_ABSENT") return null;
    return {
      flow: "?",
      boundary: "blocked",
      transition: null,
      title: null,
      invocation: null,
      command: `aw flow advance --code ${folder} --adopt`,
      summary: `corrida ilegible (${read.failure.code}): ${read.failure.action}`,
      // Unreadable means unreadable: a scope quoted off a state the engine
      // refuses would be the one field of this projection nobody could trust.
      scope: null,
      assurance: null,
    };
  }
  if (legacyRunNeedsAdoption(read.state)) {
    return {
      flow: read.state.flow,
      boundary: "blocked",
      transition: read.state.boundary,
      title: null,
      invocation: null,
      command: `aw flow advance --code ${folder} --flow ${read.state.flow} --adopt`,
      summary: `corrida legacy v${read.state.version}: requiere adopción explícita antes de continuar`,
      scope: read.state.scope,
      assurance: null,
    };
  }
  const journey = journeyForRun(read.state);
  const incoherent = checkAgainstJourney(read.state, journey);
  if (incoherent !== null) {
    return {
      flow: read.state.flow,
      boundary: "blocked",
      transition: read.state.boundary,
      title: null,
      invocation: null,
      command: `aw flow advance --code ${folder}`,
      summary: `${incoherent.message} — ${incoherent.action}`,
      scope: read.state.scope,
      assurance: read.state.assurance,
    };
  }
  const resolved = resolveBoundary(read.state, journey);
  const stopped = resolved.stopped;
  if (stopped === null) {
    return {
      flow: read.state.flow,
      boundary: "final",
      transition: null,
      title: null,
      invocation: null,
      command: `aw session-close --code ${folder}`,
      summary:
        read.state.assurance === "verified"
          ? "complete · verified"
          : `complete · ${read.state.assurance}: la evidencia omitida o sustituida no se presenta como aprobada`,
      scope: read.state.scope,
      assurance: read.state.assurance,
    };
  }
  const invocation =
    resolved.action === null
      ? null
      : [resolved.action.invocation.program, ...resolved.action.invocation.args].join(" ");
  return {
    flow: read.state.flow,
    boundary: resolved.kind,
    transition: stopped.id,
    title: stopped.title,
    invocation,
    // At an execution boundary what continues the run is the invocation itself —
    // anything else would send whoever resumes to re-derive the command from
    // prose, which is exactly what the sealed action exists to prevent.
    command: invocation ?? `aw flow advance --code ${folder}`,
    summary:
      invocation === null
        ? `frontera ${resolved.kind} en ${stopped.id} — ${stopped.title}`
        : `frontera execution en ${stopped.id} — ejecutá '${invocation}' y devolvé su salida real con 'aw flow submit --code ${folder}'`,
    scope: read.state.scope,
    assurance: read.state.assurance,
  };
}
