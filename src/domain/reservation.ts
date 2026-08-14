/**
 * A claimed correlative, and whose it is.
 *
 * `aw next-number --claim` used to materialize an EMPTY file. The number became
 * unshareable — that part worked — but the reservation was anonymous, and two
 * failures follow from that single missing fact. A run could not tell its own
 * placeholder from a document somebody else was writing, so filling the slot
 * classified as a generic overwrite and the save row that declares only
 * `local_additive` refused it; and a run that died left a zero-byte file in
 * `docs/plans` that every reader afterwards had to guess about.
 *
 * The marker is the whole mechanism: one line naming the session that holds the
 * slot. Completing a reservation is additive while the bytes are still exactly
 * that marker — nothing was ever published there — and an overwrite in every
 * other case. That keeps "only my own untouched reservation can be completed" a
 * property of the file rather than a rule somebody has to remember to apply.
 */

/** The exact bytes a claim leaves behind for the session that owns it. */
export function reservationMarker(owner: string): string {
  return `<!-- aw:reserva ${owner} -->\n`;
}

const MARKER = /^<!--\s*aw:reserva\s+(\S+)\s*-->$/;

/**
 * The session a reservation marker names, or `null` for anything that is not one.
 *
 * "Anything else" covers a real document, an empty legacy claim and a marker
 * somebody edited, and collapsing the three is deliberate: none of them is a slot
 * a run may complete or release, and the caller's decision is the same for all.
 */
export function reservationOwnerOf(text: string): string | null {
  return MARKER.exec(text.trim())?.[1] ?? null;
}
