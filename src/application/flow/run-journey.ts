/**
 * The journey that a persisted run may cross.
 *
 * PLAN-exec is the single flow whose persisted batch cursor changes the shape of
 * its journey. Every other flow remains the registry journey verbatim. Keeping
 * that distinction at this application seam also lets controlled registry
 * fixtures replace `journeyOfFlow` without accidentally reading the production
 * registry through `journeyForState`'s lexical implementation.
 */

import { journeyForState, journeyOfFlow } from "../../domain/flow/authority.js";
import type { FlowRunState } from "../../domain/flow/run-state.js";

export function journeyForRun(state: FlowRunState) {
  const base = journeyOfFlow(state.flow);
  return state.flow === "plan-exec" ? journeyForState(state, base) : base;
}
