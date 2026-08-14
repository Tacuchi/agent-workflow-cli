/**
 * The journal: the only thing that exists between "nothing happened" and "it is
 * done".
 *
 * A retirement deletes session folders, so its own record cannot live inside one —
 * the operation would erase the evidence it needs to finish itself. It lives under
 * `.workflow/.retirement/`, outside everything the operation is allowed to remove,
 * and it disappears when the operation converges.
 *
 * What it exists for is a single question a re-entering process has to answer:
 * **which side of the commit point is the world on?** And the answer is never "how
 * far did the previous process think it got" — that reading died with the process.
 * The answer is the REF: at the prepared tip means committed, still at the expected
 * old value means nothing was published. So the journal carries the two values that
 * make the question answerable, and the phase it records is a hint for a human, not
 * the decision.
 *
 * While a journal exists, the operation is neither a success nor a failure: it is
 * IN FLIGHT, and every Workline surface that projects state has to say so rather
 * than describe a half-retired workspace as if it were finished.
 */

import { join } from "node:path";
import type { RetirementProposal } from "../../domain/retirement/proposal.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { PathsService } from "../paths-service.js";

/** Directory the journals live in — outside every deletable session. */
export const JOURNAL_DIR = ".retirement";

/** How far the writer BELIEVED it got. Never the basis of a decision. */
export type JournalPhase =
  /** Effects computed and sealed; nothing staged yet. */
  | "prepared"
  /** Quarantine written and reverts built on private refs; the ref not moved. */
  | "ready"
  /** The compare-and-swap succeeded. Past this point, finishing is the only path. */
  | "committed";

export interface RetirementJournal {
  version: number;
  /** The approval's digest: one journal per authorized operation. */
  digest: string;
  phase: JournalPhase;
  /** Local date it was opened, so a stale journal is recognizable to a human. */
  opened: string;
  /** The sealed proposal, verbatim — what was authorized, not a summary of it. */
  proposal: RetirementProposal;
  /** Absolute path of the quarantine directory this operation staged into. */
  quarantine: string;
  /** Private refs it created, so a rollback drops exactly those. */
  private_refs: string[];
  /**
   * The commit this run actually built, once it has.
   *
   * Not part of the seal — a commit id carries its timestamp, so two runs of the
   * same authorized reverts produce different ids for the same result. It is
   * recorded here because the re-entry can then recognize its own work by identity
   * instead of only by tree.
   */
  prepared_tip?: string;
}

export const JOURNAL_VERSION = 1;

export function journalDir(paths: PathsService): string {
  return join(paths.cwdRoot(), JOURNAL_DIR);
}

export function journalPath(paths: PathsService, digest: string): string {
  return join(journalDir(paths), `${digest}.json`);
}

export function quarantinePath(paths: PathsService, digest: string): string {
  return join(journalDir(paths), `${digest}.quarantine`);
}

export function openJournal(input: {
  proposal: RetirementProposal;
  quarantine: string;
  opened: string;
}): RetirementJournal {
  return {
    version: JOURNAL_VERSION,
    digest: input.proposal.digest,
    phase: "prepared",
    opened: input.opened,
    proposal: input.proposal,
    quarantine: input.quarantine,
    private_refs: [],
  };
}

export async function writeJournal(
  fs: FileSystemPort,
  paths: PathsService,
  journal: RetirementJournal,
): Promise<void> {
  await fs.mkdirp(journalDir(paths));
  await fs.writeText(journalPath(paths, journal.digest), `${JSON.stringify(journal, null, 2)}\n`);
}

export async function dropJournal(
  fs: FileSystemPort,
  paths: PathsService,
  digest: string,
): Promise<void> {
  await fs.remove(journalPath(paths, digest));
}

export type JournalRead =
  | { status: "present"; journal: RetirementJournal }
  | { status: "absent" }
  | { status: "unreadable"; reason: string };

export async function readJournal(
  fs: FileSystemPort,
  paths: PathsService,
  digest: string,
): Promise<JournalRead> {
  const path = journalPath(paths, digest);
  if (!(await fs.exists(path))) return { status: "absent" };
  return parseJournal(fs, path);
}

/**
 * Every journal in flight right now.
 *
 * Read by the surfaces that project state, because a workspace with a journal is
 * not a workspace anybody can describe yet: one of its sessions may be gone from
 * disk while its row is not written, or a ref may have moved while the filesystem
 * has not caught up. Reporting the pending operation is what turns that window
 * from a lie into a visible state.
 */
export async function listPendingJournals(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<{ journals: RetirementJournal[]; unreadable: Array<{ path: string; reason: string }> }> {
  const dir = journalDir(paths);
  if (!(await fs.exists(dir))) return { journals: [], unreadable: [] };
  const journals: RetirementJournal[] = [];
  const unreadable: Array<{ path: string; reason: string }> = [];
  for (const entry of await fs.list(dir)) {
    if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
    const read = await parseJournal(fs, entry.path);
    if (read.status === "present") journals.push(read.journal);
    else if (read.status === "unreadable")
      unreadable.push({ path: entry.path, reason: read.reason });
  }
  return { journals, unreadable };
}

async function parseJournal(fs: FileSystemPort, path: string): Promise<JournalRead> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readText(path));
  } catch (err) {
    return {
      status: "unreadable",
      reason: `no se pudo leer el journal de retiro ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isJournal(parsed)) {
    return { status: "unreadable", reason: `${path} no tiene la forma de un journal de retiro` };
  }
  return { status: "present", journal: parsed };
}

function isJournal(value: unknown): value is RetirementJournal {
  if (value === null || typeof value !== "object") return false;
  const j = value as Record<string, unknown>;
  return (
    typeof j.version === "number" &&
    typeof j.digest === "string" &&
    typeof j.phase === "string" &&
    typeof j.quarantine === "string" &&
    Array.isArray(j.private_refs) &&
    j.proposal !== null &&
    typeof j.proposal === "object"
  );
}
