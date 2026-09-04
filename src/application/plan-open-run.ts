/**
 * WHO IS HOLDING A PLAN RIGHT NOW, read once for everybody who asks.
 *
 * Two very different commands need this same fact. `aw settle` needs it to
 * refuse: settling underneath a live run would interleave two publications over
 * one chain. The board needs it to name an exit: the way out of a pending
 * obligation is that run's own next boundary when there is one, and `aw settle`
 * when there is not — and a board that guessed would send somebody to the wrong
 * half of that.
 *
 * Read from the same projection `aw status` and `aw resume` present, so "there
 * is a run on this plan" is one answer and not two — and the command that comes
 * back is the one that projection computed, because a run that still needs
 * `--adopt` refuses a bare `advance`.
 */

import type { FileSystemPort } from "../ports/file-system.js";
import { findActiveSessions } from "./checkpoint-service.js";
import { type FlowRunProjection, projectRun } from "./flow/run-projection.js";
import type { PathsService } from "./paths-service.js";

/** The run that holds a plan, with the command that continues IT. */
export interface HoldingRun {
  session: string;
  command: string;
  /** Why it counts as holding the plan — said, not implied. */
  why: string;
}

/**
 * One pass over the live runs: which plan each one holds, and the odd one out.
 *
 * `unreadable` is separate because it holds an UNKNOWN plan, so it applies to
 * every plan asked about rather than to one key of the map.
 */
export interface HoldingRuns {
  byPlan: ReadonlyMap<string, HoldingRun>;
  /** A run whose state cannot be read: it may hold anything, so it holds this. */
  unreadable: HoldingRun | null;
}

/**
 * Every live `plan-exec` run, by the plan it holds.
 *
 * Four readings, in this order and for these reasons:
 *
 * - a run whose state cannot be READ holds an unknown plan, so it counts. The
 *   safe half is the same one an unreadable decision chain gets: fail closed and
 *   name it, because acting underneath a state nobody can read is the precise
 *   interleaving this reading exists to prevent;
 * - a run of ANY OTHER FLOW holds no plan at all. A `quick` or a `spec-refine`
 *   never fixes one, and treating it as a holder is how this reading came to
 *   claim every plan in the workspace;
 * - a run whose journey is EXHAUSTED (`final`) holds nothing any more, even
 *   though its session was never closed. Counting it would leave `aw settle`
 *   useless in exactly the workspace it was built for — a plan blocked today,
 *   whose run finished long ago;
 * - a `plan-exec` run with no scope yet may still fix THIS plan, so it counts
 *   too — said as what it is rather than as an unreadable state.
 */
export async function readHoldingRuns(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<HoldingRuns> {
  const byPlan = new Map<string, HoldingRun>();
  let unreadable: HoldingRun | null = null;
  for (const session of await findActiveSessions(fs, paths)) {
    const run = await projectRun(fs, paths, session.folder);
    if (run === null) continue;
    if (run.flow === "?") {
      unreadable ??= {
        session: session.folder,
        command: run.command,
        why: "tiene un estado de corrida que no se puede leer, así que no se puede descartar que tenga este plan",
      };
      continue;
    }
    // El flujo se mira ANTES del scope, y el orden es el defecto que esto
    // arregla: `scope` nace nulo y sólo lo fija la declaración de alcance de
    // `plan-exec`, así que mirarlo primero convertía toda corrida de `quick`,
    // `spec-refine` o `plan-new` en «una corrida ilegible» — y con eso en la
    // dueña de TODO plan que nadie más nombrara. `aw settle` quedaba inservible
    // en cualquier workspace con otra sesión abierta, que es el workspace normal
    // y justo el que la orden existe para destrabar.
    if (run.flow !== "plan-exec") continue;
    if (run.boundary === "final") continue;
    if (run.scope === null) {
      // Una corrida de ejecución que todavía no fijó su plan puede fijar este,
      // y ahí sí valdría la mitad segura — dicha por lo que es, no como una
      // ilegibilidad que no existe.
      unreadable ??= {
        session: session.folder,
        command: run.command,
        why: "tiene una corrida de ejecución que todavía no fijó su plan, así que no se puede descartar que tome este",
      };
      continue;
    }
    // First writer wins: two runs over one plan is a condition the claims ledger
    // refuses upstream, and picking the later one here would name the newer of
    // two sessions that should not both exist.
    if (!byPlan.has(run.scope.plan)) {
      byPlan.set(run.scope.plan, {
        session: session.folder,
        command: reachedBy(run, session.folder),
        why: `tiene una corrida de ejecución abierta sobre '${run.scope.plan}': su cierre salda sus propias obligaciones`,
      });
    }
  }
  return { byPlan, unreadable };
}

/**
 * The command that takes SOMEBODY ELSE to this run.
 *
 * The projection's own `command` is what continues the run from inside it, and
 * at an execution boundary that is the sealed invocation itself — `npm test --
 * …` — which advances nothing on its own: it has to be run and its real output
 * submitted. Handed to a stranger as a plan's route it would be a command that
 * does not do what the row says, so an execution boundary is named by the
 * directive that re-renders it. Every other boundary keeps the projection's own
 * command, because a legacy run refuses a bare `advance` and only the projection
 * knows that.
 */
function reachedBy(run: FlowRunProjection, folder: string): string {
  return run.boundary === "execution" ? `aw flow advance --code ${folder}` : run.command;
}

/**
 * The run holding one plan, or `null`.
 *
 * A run that NAMES this plan is preferred over an unreadable one, because its
 * refusal says which plan and which session — and the unreadable reading still
 * applies to every plan no run named.
 *
 * The exact path is tried first, and a case-insensitive match is the fallback
 * rather than the rule. On a case-insensitive filesystem — macOS by default —
 * `docs/Plans/042.md` and `docs/plans/042.md` are ONE document that a run and a
 * board can end up naming differently, and an exact comparison then reports "no
 * run holds this plan" about a plan a run is holding: the precise interleaving
 * the guard exists to prevent. On a filesystem where the two really are two
 * files the fallback over-blocks instead, which is a refusal that names a real
 * session — the safe half, and the same one an unreadable run gets.
 */
export function holdingRunOf(runs: HoldingRuns, plan: string): HoldingRun | null {
  const exact = runs.byPlan.get(plan);
  if (exact !== undefined) return exact;
  const folded = plan.toLowerCase();
  for (const [held, run] of runs.byPlan) {
    if (held.toLowerCase() === folded) return run;
  }
  return runs.unreadable;
}
