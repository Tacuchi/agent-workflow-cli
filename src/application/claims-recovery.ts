/**
 * Recovering a reservation whose owner never came back.
 *
 * The normal cycle needs none of this: completing, closing and cancelling all
 * resolve a reservation through its owner. What is left is the run that simply
 * died — no publication, no close, nothing terminal — and left a correlative held
 * by a session that is never going to finish it. There is deliberately NO clock
 * here: a reservation does not expire, because "it has been a while" is not
 * evidence that nobody is coming, and a timer that frees a slot somebody is still
 * writing into would be worse than the stranded number it fixes.
 *
 * So the release is explicit, authorized, and ORDERED. The order is the whole
 * safety argument and it runs one way only:
 *
 *   1. the reservation is still exactly its own intact marker — otherwise the
 *      bytes are somebody's work and this is not a recovery;
 *   2. a revocation is SEALED, durably and irrevocably, scoped to that one claim;
 *   3. and only then is the slot released.
 *
 * Step 2 before step 3 is not a preference. Once the file is gone the correlative
 * is eligible again, so a late sealed proposal from the dead owner — one that was
 * approved before the recovery and lands after it — would write a document onto a
 * number somebody else may already hold. The fence is what makes that publication
 * fail instead of collide, and a fence written after the release is a window. If
 * the seal cannot be written, the recovery FAILS and releases nothing: a released
 * slot with no fence is the one outcome this must never produce.
 *
 * The revocation belongs to the CLAIM, never to the session. The owner may be
 * alive and working on other things, and revoking its whole session to reclaim
 * one number would destroy work to tidy up a correlative.
 */

/**
 * What a numbered file that is not a document actually is.
 *
 * `reservation` carries an owner marker this hub can attribute.
 * `legacy-placeholder` is the zero-byte file an older version left behind: it
 * holds a correlative and names nobody, so it can never be released on the
 * strength of its own bytes.
 */
type SlotKind = "reservation" | "legacy-placeholder";

export interface SlotState {
  /** Hub-relative, always `docs/<category>/<NNN>-<name>`. */
  path: string;
  kind: SlotKind;
  category: string;
  correlative: string;
  name: string;
  /** The session that owns it — `null` for a legacy placeholder. */
  owner: string | null;
  /** Already fenced by a previous revocation: its release is a completion, not a new one. */
  revoked: boolean;
  /**
   * The owner is active or paused — `null` when there is no owner.
   * Historical field name retained for the agent-workflow index; it means live ownership.
   *
   * The difference decides which action is sanctioned, and getting it wrong is
   * destructive: a reservation whose owner is still running is finished or closed
   * by that owner, and only a slot nobody is going to finish is recovered.
   * Recovering a live run's slot revokes it irrevocably, so the run can never
   * publish into the number it is holding.
   */
  ownerActive: boolean | null;
  /** A paused owner retains the claim but must resume before finishing it. */
  ownerPaused: boolean;
  /**
   * The bytes are still exactly this owner's marker.
   *
   * A slot that is NOT intact may still be a reservation — the ledger says who
   * holds it — but its bytes are uncertain, so freeing it needs the same explicit
   * statement a legacy placeholder needs: somebody may have written there.
   */
  intact: boolean;
}

/**
 * The one action this slot sanctions, named per slot.
 *
 * A reservation of a live session is resumed or closed by its owner; only a slot
 * nobody is finishing gets recovered. And a slot whose bytes are not its own
 * intact marker carries the confirmation flag in the command itself, so the
 * operator sees the extra assertion being asked of them before they type it.
 */
export function sanctionedActionFor(slot: SlotState): string {
  // A live owner's reservation is NOT a recovery candidate. Naming the recovery
  // here was destructive: the board handed the running session the one command
  // that revokes its own slot irrevocably, and the flow reads this very field as
  // "the sanctioned next command". Closing the owner releases an intact
  // reservation as part of closing, which is the action that actually resolves it.
  if (slot.ownerActive === true && !slot.revoked && slot.owner !== null) {
    return slot.ownerPaused
      ? `aw session-load --code ${slot.owner}`
      : `aw session-close --code ${slot.owner}`;
  }
  const confirm = slot.intact ? "" : " --confirm-no-producer";
  return `aw claims recover ${slot.path}${confirm}`;
}
