/**
 * The journey that a persisted run may cross.
 *
 * Every flow expands its registry journey with the reentries its run recorded,
 * and PLAN-exec also with its batch cursor. Keeping the base lookup at this
 * application seam also lets controlled registry fixtures replace
 * `journeyOfFlow` without accidentally reading the production registry through
 * `journeyForState`'s lexical implementation.
 */

import { expandJourney, journeyForState, journeyOfFlow } from "../../domain/flow/authority.js";
import type { FlowRunState } from "../../domain/flow/run-state.js";

export function journeyForRun(state: FlowRunState) {
  return journeyForState(state, journeyOfFlow(state.flow));
}

/** {@link journeyForRun} with the reentry each row came from, over the same base. */
export function expandedJourneyForRun(state: FlowRunState) {
  return expandJourney(state, journeyOfFlow(state.flow));
}
