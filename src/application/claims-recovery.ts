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

import { join } from "node:path";
import { leadingCorrelative } from "../domain/correlative.js";
import { reservationOwnerOf } from "../domain/reservation.js";
import type { FileSystemPort } from "../ports/file-system.js";
import {
  type ClaimEvent,
  type ClaimIdentity,
  appendClaimEvent,
  claimKey,
  isRevoked,
  openOwnerOfSlot,
  readClaimEvents,
  wasPublished,
} from "./claims-ledger.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { semanticDigest } from "./semantic-operation/protocol.js";
import { CLOSED_MARKER, listSessionFolders } from "./session-resolver.js";

/**
 * What a numbered file that is not a document actually is.
 *
 * `reservation` carries an owner marker this workspace can attribute.
 * `legacy-placeholder` is the zero-byte file an older version left behind: it
 * holds a correlative and names nobody, so it can never be released on the
 * strength of its own bytes.
 */
type SlotKind = "reservation" | "legacy-placeholder";

export interface SlotState {
  /** Workspace-relative, always `docs/<category>/<NNN>-<name>`. */
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
   * The owner is still an ACTIVE session — `null` when there is no owner.
   *
   * The difference decides which action is sanctioned, and getting it wrong is
   * destructive: a reservation whose owner is still running is finished or closed
   * by that owner, and only a slot nobody is going to finish is recovered.
   * Recovering a live run's slot revokes it irrevocably, so the run can never
   * publish into the number it is holding.
   */
  ownerActive: boolean | null;
  /**
   * The bytes are still exactly this owner's marker.
   *
   * A slot that is NOT intact may still be a reservation — the ledger says who
   * holds it — but its bytes are uncertain, so freeing it needs the same explicit
   * statement a legacy placeholder needs: somebody may have written there.
   */
  intact: boolean;
}

/** The identity a reservation's slot maps to, or `null` for an unattributable one. */
function claimOfSlot(slot: SlotState): ClaimIdentity | null {
  if (slot.owner === null) return null;
  return {
    category: slot.category,
    correlative: slot.correlative,
    name: slot.name,
    owner: slot.owner,
  };
}

interface SlotScan {
  slots: SlotState[];
  /** Unreadable is reported, never folded into "there were none". */
  error?: string;
}

/**
 * The slot a numbered file is, or `null` when it is a document.
 *
 * The LEDGER decides before the bytes do, and the order is the fix for a real
 * defect: classifying from bytes alone made every empty numbered file an
 * ownerless legacy placeholder — releasable with no fence — including a published
 * document whose content happens to be empty, and including a reservation whose
 * marker somebody emptied. In the first case a recovery deleted a published
 * document; in the second it gave a correlative back while its real owner still
 * held an open claim on it. Both times the record held the answer and only the
 * bytes were consulted.
 */
function slotOf(
  category: string,
  fileName: string,
  text: string,
  events: readonly ClaimEvent[],
  activeOwners: ReadonlySet<string>,
): SlotState | null {
  const correlative = leadingCorrelative(fileName);
  if (correlative === null) return null;
  const name = fileName.slice(correlative.length + 1);
  const slot = { category, correlative, name };
  // Published is terminal and terminal means "a document lives here": whatever
  // its bytes look like, it is not a slot anybody may free.
  if (wasPublished(events, slot)) return null;

  const markerOwner = reservationOwnerOf(text);
  const base = { path: `docs/${category}/${fileName}`, category, correlative, name };
  if (markerOwner !== null) {
    return {
      ...base,
      kind: "reservation",
      owner: markerOwner,
      ownerActive: activeOwners.has(markerOwner),
      revoked: false,
      intact: true,
    };
  }
  // Real content and no marker: a document, by its bytes this time.
  if (text.trim().length > 0) return null;
  // Empty. If the ledger still holds an open claim on this slot, it is that
  // owner's reservation with damaged bytes — not nobody's placeholder.
  const open = openOwnerOfSlot(events, slot);
  if (open !== null) {
    return {
      ...base,
      kind: "reservation",
      owner: open.owner,
      ownerActive: activeOwners.has(open.owner),
      revoked: false,
      intact: false,
    };
  }
  return {
    ...base,
    kind: "legacy-placeholder",
    owner: null,
    ownerActive: null,
    revoked: false,
    intact: false,
  };
}

/**
 * Walk `docs/` into `into`, throwing on the first unreadable thing.
 *
 * The accumulator is the caller's so a failure still reports what it managed to
 * see: an unreadable category is a different fact from an empty one, and folding
 * the two would let the board say "no reservations" about a directory nobody
 * could open.
 */
async function walkSlots(
  fs: FileSystemPort,
  docs: string,
  events: readonly ClaimEvent[],
  activeOwners: ReadonlySet<string>,
  into: SlotState[],
): Promise<void> {
  for (const category of await fs.list(docs)) {
    if (category.type !== "dir") continue;
    for (const entry of await fs.list(category.path)) {
      // The filename decides whether the bytes are worth reading at all. Reading
      // every file in every docs/ subdirectory to then discard most of them on the
      // first line of `slotOf` made a scan that runs on EVERY board projection pay
      // for the whole corpus.
      if (entry.type !== "file" || leadingCorrelative(entry.name) === null) continue;
      const slot = slotOf(
        category.name,
        entry.name,
        await fs.readText(entry.path),
        events,
        activeOwners,
      );
      if (slot === null) continue;
      const claim = claimOfSlot(slot);
      slot.revoked = claim !== null && isRevoked(events, claim);
      into.push(slot);
    }
  }
}

/**
 * The session folders that are still open.
 *
 * Read once per scan, because the sanctioned action for a slot depends on it: a
 * reservation of a live session is that session's to finish or close, and only a
 * slot nobody is finishing may be recovered.
 */
async function activeSessionFolders(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<ReadonlySet<string>> {
  const active = new Set<string>();
  try {
    for (const folder of await listSessionFolders(fs, paths.cwdSessionsDir())) {
      if (await fs.exists(join(folder.path, CLOSED_MARKER))) continue;
      active.add(folder.name);
    }
  } catch {
    // An unreadable sessions dir means nobody can be proven alive. The fallback is
    // the conservative one: with no owner known to be active, no slot is offered
    // for recovery on the strength of liveness it could not check.
  }
  return active;
}

/**
 * Every reservation and legacy placeholder under `docs/`.
 *
 * Walks each immediate subdirectory rather than a list of categories, for the
 * same reason the close's sweep does: the claim mechanism is category-agnostic,
 * and a hardcoded list is a second place to update the day something else claims
 * a number.
 *
 * A failure comes back WITH its reason and with whatever was already seen. An
 * unreadable `docs/` is not an empty one, and swallowing the difference would let
 * the board answer "no reservations" about a directory nobody could open.
 */
export async function scanSlots(fs: FileSystemPort, paths: PathsService): Promise<SlotScan> {
  const docs = join(paths.workspaceDir(), "docs");
  const slots: SlotState[] = [];
  const ledger = await readClaimEvents(fs, paths);
  const activeOwners = await activeSessionFolders(fs, paths);
  const sorted = (): SlotState[] => slots.sort((a, b) => a.path.localeCompare(b.path));
  if (!(await fs.exists(docs))) return { slots };
  try {
    await walkSlots(fs, docs, ledger.events, activeOwners, slots);
  } catch (error) {
    return {
      slots: sorted(),
      error: `no se pudo revisar docs/ en busca de reservas: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { slots: sorted() };
}

interface RecoveryProposal {
  version: 1;
  target: string;
  kind: SlotKind;
  claim: ClaimIdentity | null;
  /**
   * A slot whose bytes cannot vouch for themselves needs the operator to state
   * that no producer is left.
   *
   * True for a legacy placeholder — an empty numbered file names nobody, and it
   * is what an interrupted old claim leaves AND what a half-written document
   * leaves, which the file cannot tell apart. Also true for a reservation whose
   * marker is no longer intact: the ledger still says who holds it, but somebody
   * wrote in there, and bytes nobody recognizes may be work.
   */
  requires_no_producer_confirmation: boolean;
  /**
   * The fence is already sealed and only the release is left.
   *
   * A recovery interrupted between its two records used to be unreachable
   * forever: the claim was revoked, so the preview refused with "already
   * revoked" — while its own advice was to apply the recovery again — and the
   * owner could not publish either, because the fence was up. The correlative
   * was bricked in both directions with no sanctioned exit. An operation whose
   * durable mark already exists FINISHES, it does not refuse.
   */
  resuming: boolean;
  digest: string;
}

function sealRecovery(body: Omit<RecoveryProposal, "digest">): RecoveryProposal {
  return { ...body, digest: semanticDigest(body) };
}

type RecoveryFailure = { error: string; action: string };

/** The proposal for one slot, or why there is none. */
export async function previewRecovery(
  fs: FileSystemPort,
  paths: PathsService,
  target: string,
): Promise<{ proposal: RecoveryProposal } | RecoveryFailure> {
  const scan = await scanSlots(fs, paths);
  const slot = scan.slots.find((candidate) => candidate.path === target);
  if (slot === undefined) {
    return {
      error: `'${target}' no es una reserva ni un placeholder legacy de este workspace`,
      action:
        scan.error ??
        "corré 'aw claims' para ver los correlativos recuperables; un documento publicado no se recupera",
    };
  }
  return {
    proposal: sealRecovery({
      version: 1,
      target: slot.path,
      kind: slot.kind,
      claim: claimOfSlot(slot),
      requires_no_producer_confirmation: !slot.intact,
      resuming: slot.revoked,
    }),
  };
}

interface RecoveryApplied {
  target: string;
  revoked: ClaimIdentity | null;
  released: boolean;
  /** True when this call finished a recovery whose fence was already sealed. */
  resumed: boolean;
  digest: string;
}

/**
 * Seal the fence, then release — and never the other way round.
 *
 * The whole thing runs under the workspace lock, which is not decoration: the
 * check that the slot is still what the preview saw, the seal and the removal are
 * three separate awaits, and without the lock a sanctioned publication could pass
 * its own fence, take the lock, write its document and have this function delete
 * it a moment later — leaving the correlative recorded as both spent-forever and
 * eligible-again, with the published document silently gone. Its two siblings hold
 * the lock across exactly this span for exactly this reason.
 *
 * It also re-derives its own proposal inside the lock instead of trusting the
 * digest it was handed: the approval proves a person authorized THIS recovery, not
 * that the world still looks the way it did when they read it.
 */
export async function applyRecovery(
  fs: FileSystemPort,
  paths: PathsService,
  input: { target: string; approval: string; noProducerConfirmed?: boolean },
): Promise<{ applied: RecoveryApplied } | RecoveryFailure> {
  const outcome = await withCwdLock(fs, paths, () => recoverUnderLock(fs, paths, input));
  if ("error" in outcome && "action" in outcome) return outcome;
  if ("error" in outcome) {
    return {
      error: `no se pudo tomar el candado del workspace: ${outcome.error}`,
      action: "esperá a que otro flujo lo libere y volvé a aplicar la recuperación",
    };
  }
  return outcome;
}

async function recoverUnderLock(
  fs: FileSystemPort,
  paths: PathsService,
  input: { target: string; approval: string; noProducerConfirmed?: boolean },
): Promise<{ applied: RecoveryApplied } | RecoveryFailure> {
  const preview = await previewRecovery(fs, paths, input.target);
  if ("error" in preview) return preview;
  const proposal = preview.proposal;
  if (proposal.digest !== input.approval) {
    return {
      error: "la aprobación no corresponde a la recuperación vigente",
      action: `volvé a mirarla con 'aw claims recover ${input.target}' y aprobá el digest que devuelve`,
    };
  }
  if (proposal.requires_no_producer_confirmation && input.noProducerConfirmed !== true) {
    return {
      error:
        proposal.kind === "legacy-placeholder"
          ? `'${input.target}' es un placeholder legacy ambiguo: sus bytes no prueban que nadie vaya a escribirlo`
          : `'${input.target}' ya no tiene el marcador intacto de su dueño: alguien escribió ahí`,
      action:
        "confirmá explícitamente que no queda productor capaz de escribir ese destino antes de liberar su correlativo",
    };
  }

  const claim = proposal.claim;
  if (claim !== null && !proposal.resuming) {
    // The fence FIRST. If this throws, nothing was released and the slot is
    // exactly as it was: the recovery failed, which is the correct outcome.
    // Releasing first would leave a window where the correlative is eligible and
    // a late sealed publication can still land on it.
    await appendClaimEvent(fs, paths, {
      at: new Date().toISOString(),
      event: "revoked",
      claim,
      cause: `aw claims recover: recuperación autorizada de ${proposal.target}`,
    });
  }
  // Recorded before the file goes, same reason as the close's release: a slot
  // freed with no line saying so is the state this ledger exists to end. The
  // identity is the SLOT's, so it joins to its own history by claimKey — an
  // ownerless placeholder still records the category, correlative and name it
  // gave back, and only its owner field says nobody held it.
  await appendClaimEvent(fs, paths, {
    at: new Date().toISOString(),
    event: "released",
    claim: claim ?? {
      category: slotIdentityOf(proposal.target).category,
      correlative: slotIdentityOf(proposal.target).correlative,
      name: slotIdentityOf(proposal.target).name,
      owner: LEGACY_OWNERLESS,
    },
    cause:
      claim === null
        ? "aw claims recover: placeholder legacy liberado con confirmación explícita de que no queda productor"
        : `aw claims recover: liberado tras revocar ${claimKey(claim)}`,
  });
  await fs.remove(join(paths.workspaceDir(), proposal.target));
  return {
    applied: {
      target: proposal.target,
      revoked: claim,
      released: true,
      resumed: proposal.resuming,
      digest: proposal.digest,
    },
  };
}

/** The owner field of a slot that never had one. Never a session folder. */
const LEGACY_OWNERLESS = "(placeholder legacy sin dueño)";

/** `docs/<cat>/<NNN>-<name>` split the same way every ledger record splits it. */
function slotIdentityOf(target: string): {
  category: string;
  correlative: string;
  name: string;
} {
  const parts = target.split("/");
  const category = parts[1] ?? "";
  const file = parts[2] ?? "";
  const correlative = leadingCorrelative(file) ?? "";
  return {
    category,
    correlative,
    name: correlative.length > 0 ? file.slice(correlative.length + 1) : file,
  };
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
  if (slot.ownerActive === true && slot.owner !== null) {
    return `aw session-close --code ${slot.owner}`;
  }
  const confirm = slot.intact ? "" : " --confirm-no-producer";
  return `aw claims recover ${slot.path}${confirm}`;
}
