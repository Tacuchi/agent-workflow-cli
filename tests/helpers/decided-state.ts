/**
 * Everything a run DECIDED, with the attempt bookkeeping left out.
 *
 * "A rejection writes nothing" used to be assertable byte for byte, and three
 * suites did exactly that. It stopped being literally true when the boundary
 * attempts cap arrived: a refused answer spends an attempt, and that count is
 * the entire mechanism — comparing the whole file would be asserting the cap
 * cannot work.
 *
 * What must still be identical after a rejection is everything the run decided:
 * the cursor and what it skipped, the boundary in force, the pending action, the
 * observations, the authorizations, the effect ledger and the degradations. That
 * is what this returns. The seal goes with the attempts because it is computed
 * OVER them — keeping it would smuggle the excluded field back in through its
 * digest, and so do the two counters reconciled from the monotone sidecar: they
 * are the same bookkeeping seen from outside the run, and comparing them would
 * again be asserting that the cap cannot work.
 */
export function decidedState(raw: string): unknown {
  const {
    attempts: _spent,
    attempt_floor: _floor,
    attempt_grants: _granted,
    digest: _seal,
    ...decided
  } = JSON.parse(raw);
  return decided;
}
