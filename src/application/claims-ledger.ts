/**
 * The durable trace of a reservation's whole life — and the only place it lives.
 *
 * A claim used to leave exactly one artifact: the marker file itself. That made
 * the reservation visible while it existed and completely unaccountable once it
 * did not. Nothing recorded who had claimed a correlative, why it went away, or
 * whether it had ever been published — so a released number was
 * indistinguishable from one that never existed, and a recovery had no evidence
 * to stand on.
 *
 * This ledger is append-only and lives under `.workflow/`, deliberately OUTSIDE
 * `docs/`: the corpus is for documents somebody published, and a reservation's
 * history is not one. Putting it in `docs/` would make the trace itself look like
 * a spec or a plan, which is the confusion the whole change exists to end.
 *
 * It answers three different questions with one file, which is why there is one
 * file and not three:
 *   - **what happened** — the audit trail, still readable after the session's
 *     folder is gone, because a session is deleted and its history should not be;
 *   - **which correlatives came back** — a number released and never published is
 *     eligible again, and only this record knows the difference;
 *   - **what may no longer be published** — a revocation is a durable fence, and
 *     a fence that lives in memory is not one.
 *
 * Append-only is load-bearing for the third: a record that can be rewritten is a
 * fence somebody can lift, and the revocation has to be irrevocable to be worth
 * anything.
 */

import { join } from "node:path";
import { compareCorrelatives, isCorrelative } from "../domain/correlative.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";

/** Lives next to HISTORY.md: workspace state, never workspace corpus. */
const LEDGER_FILE = "claims.jsonl";
const LEDGER_VERSION = 1;

/**
 * What happened to a claim.
 *
 * `published` and `released` are both terminal and they are NOT the same fact:
 * a published correlative is spent forever, a released one is eligible again.
 * Collapsing them would either lose numbers or hand out a number that is holding
 * a document.
 */
type ClaimEventKind = "claimed" | "published" | "released" | "revoked";

/**
 * What makes two records the same slot.
 *
 * The owner is part of the identity, not a detail of it: two sessions may claim
 * the same NAME in the same category, and they are different reservations. This
 * is also the granularity a revocation is scoped to — the claim, never the
 * session, so revoking one leaves the owner's other reservations alone.
 */
export interface ClaimIdentity {
  /** The `docs/<category>` the slot lives in — `plans`, `specs`, … */
  category: string;
  correlative: string;
  /** The rest of the filename after `<NNN>-`. */
  name: string;
  /** The session folder that owns it. */
  owner: string;
}

export interface ClaimEvent {
  version: number;
  /** ISO instant, so the order of two records on one claim is readable. */
  at: string;
  event: ClaimEventKind;
  claim: ClaimIdentity;
  /** Why — recorded for every event a reader would otherwise have to guess about. */
  cause?: string;
}

/** The identity as one comparable string. Order is fixed so it is stable. */
export function claimKey(claim: ClaimIdentity): string {
  return `${claim.category}/${claim.correlative}-${claim.name}@${claim.owner}`;
}

export function ledgerPath(paths: PathsService): string {
  return join(paths.cwdRoot(), LEDGER_FILE);
}

/**
 * Add one record. Append-only by construction: there is no update and no delete.
 *
 * Two callers, two different guarantees, and the difference is worth stating
 * rather than glossing:
 *
 * - the **claim** appends inside the workspace lock that mints the slot, so the
 *   reservation and its record cannot separate;
 * - the **release** at session close does NOT hold that lock — the close's
 *   reservation sweep is deliberately outside it and non-fatal — so its record
 *   is ordered by `O_APPEND` alone.
 *
 * That is sufficient here only because a record is one short line: `O_APPEND`
 * makes a single small write atomic, so two processes appending cannot interleave
 * halves of a record. It would stop being sufficient the day a record grew past a
 * pipe buffer, which is the reason a record is one line and not a pretty-printed
 * object.
 */
export async function appendClaimEvent(
  fs: FileSystemPort,
  paths: PathsService,
  event: Omit<ClaimEvent, "version">,
): Promise<void> {
  const record: ClaimEvent = { version: LEDGER_VERSION, ...event };
  await fs.appendText(ledgerPath(paths), `${JSON.stringify(record)}\n`);
}

interface LedgerRead {
  events: ClaimEvent[];
  /**
   * Lines that did not parse, kept as a COUNT rather than dropped silently.
   *
   * A ledger nobody can fully read is not an empty ledger, and the difference
   * decides whether a recovery may proceed: reporting "no revocation found" from
   * a file with unreadable lines would lift a fence by accident.
   */
  unreadable: number;
}

/** Every record, oldest first. A missing ledger reads as empty, never as an error. */
export async function readClaimEvents(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<LedgerRead> {
  const path = ledgerPath(paths);
  if (!(await fs.exists(path))) return { events: [], unreadable: 0 };
  const raw = await fs.readText(path);
  const events: ClaimEvent[] = [];
  let unreadable = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = parseEvent(trimmed);
    if (parsed === null) unreadable += 1;
    else events.push(parsed);
  }
  return { events, unreadable };
}

function parseEvent(line: string): ClaimEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<ClaimEvent>;
  const claim = candidate.claim;
  if (
    typeof candidate.at !== "string" ||
    typeof candidate.event !== "string" ||
    typeof claim !== "object" ||
    claim === null ||
    typeof claim.category !== "string" ||
    typeof claim.correlative !== "string" ||
    typeof claim.name !== "string" ||
    typeof claim.owner !== "string"
  ) {
    return null;
  }
  return value as ClaimEvent;
}

/**
 * The claims this owner still holds: a `claimed` with no terminal record after it.
 *
 * Derived rather than stored, because the ledger is append-only and a "still
 * open" flag would be exactly the kind of mutable state that makes an
 * append-only log pointless. `published`, `released` and `revoked` are all
 * terminal — the first spends the number, the other two end the owner's hold on
 * it — so any of them closes the claim for this reading.
 */
export function openClaimsOf(events: readonly ClaimEvent[], owner: string): ClaimIdentity[] {
  const open = new Map<string, ClaimIdentity>();
  for (const event of events) {
    if (event.claim.owner !== owner) continue;
    const key = claimKey(event.claim);
    if (event.event === "claimed") open.set(key, event.claim);
    else open.delete(key);
  }
  return [...open.values()];
}

/**
 * The claim a workspace-relative `docs/<category>/<NNN>-<name>` path would be.
 *
 * `null` for anything that is not a numbered document inside a category, which
 * is what keeps this from reading a claim out of an unrelated destination.
 */
function claimOfDocsPath(path: string, owner: string): ClaimIdentity | null {
  const parts = path.split("/").filter((segment) => segment.length > 0);
  const docsAt = parts.indexOf("docs");
  if (docsAt === -1 || parts.length - docsAt !== 3) return null;
  const category = parts[docsAt + 1];
  const file = parts[docsAt + 2];
  if (category === undefined || file === undefined) return null;
  const match = /^(\d{3,})-(.+)$/.exec(file);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { category, correlative: match[1], name: match[2], owner };
}

/**
 * Which claims of this owner a publication just completed.
 *
 * The whole decision of "did this write finish a reservation of mine?" lives
 * here rather than at the publication site, and getting it wrong is durable in
 * both directions:
 *
 * - **Under-crediting** leaves a claim open about a correlative that is holding a
 *   published document, which invites a later recovery to release live bytes.
 *   That is why `already_applied` is handled here: the re-entry that finds the
 *   document already on disk reports `written: []`, and crediting only `written`
 *   left the claim open FOREVER — every retry answers the same way, so nothing
 *   could ever correct it. When the apply says already-applied, every destination
 *   holds exactly the proposed bytes, so the destinations are the candidates.
 * - **Over-crediting** writes a permanent "spent forever" fence on a correlative
 *   the session never reserved. So a candidate only counts when it closes one of
 *   THIS owner's open claims, read from the ledger — not from the shape of
 *   whatever proposal happened to carry the write. Every flow's publication goes
 *   through this same path, not only the one whose single artifact is its own slot.
 *
 * Both directions had a surviving mutant when this logic sat inlined at the call
 * site, which is the other reason it is here: it is testable in isolation.
 */
export function completedClaimsIn(
  events: readonly ClaimEvent[],
  owner: string,
  publication: {
    written: readonly string[];
    already_applied: boolean;
    destinations: readonly string[];
  },
): ClaimIdentity[] {
  const candidates = publication.already_applied ? publication.destinations : publication.written;
  if (candidates.length === 0) return [];
  const open = new Set(openClaimsOf(events, owner).map((claim) => claimKey(claim)));
  if (open.size === 0) return [];
  const completed: ClaimIdentity[] = [];
  for (const path of candidates) {
    const claim = claimOfDocsPath(path, owner);
    if (claim === null || !open.has(claimKey(claim))) continue;
    completed.push(claim);
  }
  return completed;
}

/**
 * Every claim this ledger has ever revoked.
 *
 * Membership is permanent by construction: one `revoked` record fences the claim
 * forever, and no later record lifts it. That is what "irrevocable" has to mean
 * to be worth anything — a fence somebody can reopen is not a fence, and the
 * whole reason a recovery may free a correlative is that no late publication can
 * still land on it.
 */
function revokedKeys(events: readonly ClaimEvent[]): Set<string> {
  const revoked = new Set<string>();
  for (const event of events) {
    if (event.event === "revoked") revoked.add(claimKey(event.claim));
  }
  return revoked;
}

/** Whether this exact claim is fenced. */
export function isRevoked(events: readonly ClaimEvent[], claim: ClaimIdentity): boolean {
  return revokedKeys(events).has(claimKey(claim));
}

/**
 * The destinations of a publication that a revocation forbids.
 *
 * Checked at the publication point rather than at the release: once a recovery
 * has freed a correlative, the slot no longer exists on disk, so a late sealed
 * proposal would read its destination as a plain creation and land a document on
 * a number that may already belong to somebody else. The fence is the only thing
 * standing between "the reservation was recovered" and "two documents share a
 * correlative".
 */
export function revokedAmong(
  events: readonly ClaimEvent[],
  owner: string,
  destinations: readonly string[],
): ClaimIdentity[] {
  const revoked = revokedKeys(events);
  if (revoked.size === 0) return [];
  const blocked: ClaimIdentity[] = [];
  for (const path of destinations) {
    const claim = claimOfDocsPath(path, owner);
    if (claim === null || !revoked.has(claimKey(claim))) continue;
    blocked.push(claim);
  }
  return blocked;
}

/**
 * Destinations that look like a numbered document of this owner's category space.
 *
 * Used only to scope the fail-closed: a ledger with unreadable lines cannot prove
 * the ABSENCE of a revocation, so a publication that could be completing a
 * reservation must refuse rather than guess. A write that is not a numbered
 * document in a category cannot be a reservation, so it is never held up by a
 * ledger it does not depend on.
 */
export function claimShapedAmong(owner: string, destinations: readonly string[]): ClaimIdentity[] {
  const shaped: ClaimIdentity[] = [];
  for (const path of destinations) {
    const claim = claimOfDocsPath(path, owner);
    if (claim !== null) shaped.push(claim);
  }
  return shaped;
}

/** A slot's identity without its owner: what a file on disk can be matched by. */
interface SlotIdentity {
  category: string;
  correlative: string;
  name: string;
}

function sameSlot(claim: ClaimIdentity, slot: SlotIdentity): boolean {
  return (
    claim.category === slot.category &&
    claim.correlative === slot.correlative &&
    claim.name === slot.name
  );
}

/**
 * Whether this slot was ever published, by anyone.
 *
 * Asked BEFORE the bytes are interpreted, because bytes lie in one direction that
 * matters: a published document whose content happens to be empty looks exactly
 * like the legacy placeholder a recovery is allowed to delete. The record knows
 * the difference and the file does not, so the record decides.
 */
export function wasPublished(events: readonly ClaimEvent[], slot: SlotIdentity): boolean {
  return events.some((event) => event.event === "published" && sameSlot(event.claim, slot));
}

/**
 * The owner whose claim on this slot is still open, or `null`.
 *
 * Lets a file that is no longer its own intact marker — emptied by an editor, a
 * `> file`, a checkout — still be attributed to the session that reserved it.
 * Without this the same file reads as ownerless, and freeing it would give the
 * correlative back with no fence for the owner that is still holding it.
 */
export function openOwnerOfSlot(
  events: readonly ClaimEvent[],
  slot: SlotIdentity,
): ClaimIdentity | null {
  let open: ClaimIdentity | null = null;
  for (const event of events) {
    if (!sameSlot(event.claim, slot)) continue;
    open = event.event === "claimed" ? event.claim : null;
  }
  return open;
}

/**
 * Correlatives of this category that were released and never published, ascending.
 *
 * The second reason this ledger exists. Minting used to compute `max + 1` and
 * probe forward only, so a correlative given back in the middle of the range was
 * lost forever — this workspace's own `docs/plans` has a permanent hole at `033`
 * from exactly that. Only the record can tell a number that came back from one
 * that never existed, because the disk looks identical either way.
 *
 * Judged per (category, correlative) and by the LAST terminal record, not by the
 * presence of any: a number can be released, re-claimed and then published, and
 * after that it is spent. `published` is the one state that never becomes eligible
 * again — a correlative holding a document is not a free number, whatever else
 * the history says about it.
 *
 * Ascending because the rule has to be deterministic and reproducible, and
 * lowest-first also fills the holes rather than growing the range. The caller is
 * still responsible for skipping anything taken on disk: this answers "did the
 * record give it back", never "is the name free right now".
 */
export function eligibleCorrelatives(events: readonly ClaimEvent[], category: string): string[] {
  const state = new Map<string, ClaimEventKind>();
  for (const event of events) {
    if (event.claim.category !== category) continue;
    if (event.event === "claimed") continue;
    state.set(event.claim.correlative, event.event);
  }
  const eligible: string[] = [];
  for (const [correlative, last] of state) {
    // Validated before it can be handed out. A single semi-valid ledger line
    // would otherwise put a non-correlative into the mint, where it becomes an
    // unrecognizable filename or a throw on the comparator.
    if (last === "released" && isCorrelative(correlative)) eligible.push(correlative);
  }
  // `compareCorrelatives` and not a hand-rolled numeric sort: it is bigint-based,
  // so it stays correct past the width where `parseInt` loses precision — and a
  // second ordering rule for the same domain type is a second thing to keep true.
  return eligible.sort(compareCorrelatives);
}
