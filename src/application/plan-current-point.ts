import { type ParsedPhases, parsePhases } from "./parsers/phases.js";

/**
 * WHERE A PLAN IS ACTUALLY RESUMED FROM, which is not where a note said.
 *
 * A decision note records its resume point on the day it was written, and that
 * is history: by the time somebody comes back to settle the obligation it
 * created, the phase it named may be validated and its commits integrated.
 * Offering it as a place to return to sends whoever reads it into work that is
 * already done — which is precisely what left a real plan being told to resume
 * inside a phase nobody could reopen.
 *
 * So the current point is DERIVED from what the plan says now: the first phase
 * it does not report validated, or the closure when it reports them all. Never
 * invented, and never the note's own point when that phase is finished.
 */
const CLOSURE_POINT = "el cierre del plan";

/**
 * A plan whose phases carry no state at all cannot say where it stands.
 *
 * And it must not be answered as the closure: "every phase is validated" and
 * "this document predates the phase contract" would then read identically, and
 * the second one would be reported as work already finished — the exact
 * inversion this module exists to prevent, on the legacy plans a transversal
 * settlement is most often pointed at.
 */
const NO_CONTRACT_POINT = "sin contrato de fases: el plan no declara estados";

export function currentResumePoint(planText: string): string {
  return resumePointOf(parsePhases(planText));
}

/**
 * The same answer from a parse somebody already has.
 *
 * The board parses every plan's phases for its own counters a few lines before
 * it needs this, and parsing the same document twice per plan per board build is
 * work nobody asked for. The text-taking form stays for the callers that only
 * have the bytes.
 */
export function resumePointOf(parsed: ParsedPhases): string {
  const phases = parsed.items;
  if (phases.length === 0) return NO_CONTRACT_POINT;
  // Ascending by number, not document order: a plan whose blocks are out of
  // order would otherwise name a later phase as the one to come back to.
  const open = [...phases].sort((a, b) => a.n - b.n).find((phase) => phase.state !== "validada");
  if (open === undefined) return CLOSURE_POINT;
  const named = open.name.trim().length > 0 ? `F${open.n} — ${open.name}` : `F${open.n}`;
  // A blocked phase is where the work is, and its reason is why nobody can pick
  // it up: dropping it would send somebody to a phase that cannot move.
  return open.state === "bloqueada"
    ? `${named} (bloqueada${open.blocker === null ? "" : `: ${open.blocker}`})`
    : named;
}
