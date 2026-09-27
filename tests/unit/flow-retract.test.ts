import { expect, it } from "vitest";
import { journeyForState, journeyOfFlow } from "../../src/domain/flow/authority.js";
import {
  type FlowRunState,
  applyTransition,
  checkAgainstJourney,
  newRunState,
  parseRunState,
  retractSignal,
  sealRunState,
  serializeRunState,
  withBoundary,
} from "../../src/domain/flow/run-state.js";

const SIGNAL = "plan.independent-tranches";
const OTHER = "plan.no-shared-deps";
const PRODUCER = "plan-refine.split-signal";
const CONSUMER = "plan-refine.split-in-place";
const GATE = "plan-refine.save-confirmation";

function reseal({ digest: _digest, ...state }: FlowRunState): FlowRunState {
  return sealRunState(state);
}

it.each([false, true])("retract corrige la segunda vuelta; señal histórica=%s", (historical) => {
  const base = journeyOfFlow("plan-refine");
  const firstEnd = base.findIndex((row) => row.id === GATE) + 1;
  let before = reseal({
    ...newRunState("plan-refine", "999-retract-plan-refine"),
    applied: base.slice(0, firstEnd).map((row) => row.id),
    reentries: [
      {
        kind: "refine",
        transition: GATE,
        occurrence: 1,
        from: "plan-refine.journey-map",
      },
    ],
  });
  const journey = journeyForState(before);
  const at = journey.findIndex((row, index) => index >= firstEnd && row.id === CONSUMER);
  expect(at).toBeGreaterThanOrEqual(firstEnd);
  before = reseal({
    ...before,
    applied: journey.slice(0, at).map((row) => row.id),
    boundary: CONSUMER,
    skipped: [CONSUMER],
    observations: [
      { transition: PRODUCER, signals: historical ? [SIGNAL] : [] },
      { transition: PRODUCER, reentry_iteration: 1, signals: [SIGNAL, OTHER] },
    ],
  });
  const validate = (state: FlowRunState) => {
    expect(parseRunState(serializeRunState(state), state.session).ok).toBe(true);
    expect(checkAgainstJourney(state, journey)).toBeNull();
  };
  validate(before);
  const result = retractSignal(before, journey, SIGNAL);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.message);
  validate(result.state);
  expect(result.state.observations[0]).toEqual(before.observations[0]);
  expect(result.state.observations[1]?.signals).toEqual([OTHER]);
  expect(result.state.events.at(-1)).toMatchObject({
    kind: "retracted",
    signal: SIGNAL,
    observations: [before.observations[1]],
  });
  expect(result.state.applied).toEqual(before.applied);
  expect(result.state.attempts).toEqual(before.attempts);
  expect(result.state.effects).toEqual(before.effects);

  const after = withBoundary(applyTransition(before, CONSUMER), journey[at + 1]?.id ?? null);
  validate(after);
  expect(retractSignal(after, journey, SIGNAL)).toMatchObject({
    ok: false,
    failure: { code: "FLOW_RETRACT_ALREADY_CONSUMED" },
  });
});
