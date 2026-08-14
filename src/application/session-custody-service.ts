/**
 * Reading and extending a session's custody — the only path that writes it.
 *
 * Every mutation here is an APPEND of something that really happened plus a
 * re-seal, and never a recomputation of the record from the current state of the
 * workspace. That distinction is the whole value of the file: a custody rebuilt
 * from what exists now could only ever agree with what exists now, which is the
 * one thing a baseline must not do.
 */

import { join } from "node:path";
import {
  ABSENT_BASELINE,
  CUSTODY_FILE,
  type CustodyArtifact,
  type CustodyEffect,
  type CustodySource,
  type SessionCustody,
  preservedBaseline,
  sealCustody,
} from "../domain/session/custody.js";
import type { WorklineNodeId } from "../domain/workline-node.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { localDateIso } from "./dates.js";

export function custodyPath(sessionPath: string): string {
  return join(sessionPath, CUSTODY_FILE);
}

export type CustodyRead =
  | { status: "present"; custody: SessionCustody }
  /** Legacy session: born before custody existed. Normal flows keep working. */
  | { status: "absent" }
  /** Present and untrustworthy — never silently treated as absent. */
  | { status: "unreadable"; reason: string };

export async function readCustody(fs: FileSystemPort, sessionPath: string): Promise<CustodyRead> {
  const path = custodyPath(sessionPath);
  if (!(await fs.exists(path))) return { status: "absent" };
  let raw: string;
  try {
    raw = await fs.readText(path);
  } catch (err) {
    return { status: "unreadable", reason: `no se pudo leer ${CUSTODY_FILE}: ${message(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: "unreadable", reason: `${CUSTODY_FILE} no es JSON válido: ${message(err)}` };
  }
  if (!isCustodyShape(parsed)) {
    return { status: "unreadable", reason: `${CUSTODY_FILE} no tiene la forma de una custodia` };
  }
  return { status: "present", custody: parsed };
}

export async function writeCustody(
  fs: FileSystemPort,
  sessionPath: string,
  custody: SessionCustody,
): Promise<void> {
  await fs.writeText(custodyPath(sessionPath), `${JSON.stringify(custody, null, 2)}\n`);
}

/**
 * The custody a session is born with.
 *
 * It is sealed inside the same locked operation that mints the number and
 * creates the folder, because those three facts are one fact: a session that
 * exists is a session that can start mutating, and a baseline taken after the
 * first mutation describes a state that is already gone.
 */
export interface BirthInput {
  subject: WorklineNodeId;
  subjectPath: string;
  parents: readonly WorklineNodeId[];
  artifacts: readonly CustodyArtifact[];
  created: string;
}

export function birthCustody(input: BirthInput): SessionCustody {
  return sealCustody({
    subject: input.subject,
    subjectPath: input.subjectPath,
    parents: input.parents,
    created: input.created,
    artifacts: input.artifacts,
  });
}

/**
 * The baseline of one declared input, read from disk BEFORE the run touches it.
 *
 * A path that is not there yet is recorded as an explicit absence rather than
 * skipped: `reset` has to be able to delete a file back out of existence, and it
 * can only do that if somebody wrote down that it did not exist.
 */
export async function baselineOf(
  fs: FileSystemPort,
  workspaceRoot: string,
  relativePath: string,
): Promise<CustodyArtifact> {
  const absolute = join(workspaceRoot, relativePath);
  if (!(await fs.exists(absolute))) {
    return { path: relativePath, role: "input", before: ABSENT_BASELINE };
  }
  return {
    path: relativePath,
    role: "input",
    before: preservedBaseline(await fs.readText(absolute)),
  };
}

/**
 * Extend a session's custody, or say why it could not be extended.
 *
 * A session with NO custody is a legacy one and reports `absent` — the caller
 * carries on, which is what keeps existing flows behaving exactly as they did.
 * A custody that exists and cannot be read is a REFUSAL: the session already
 * promised it could be retired, and continuing to mutate under a broken record
 * is how that promise turns out to be unkeepable.
 */
export type CustodyUpdate =
  | { status: "updated"; custody: SessionCustody }
  | { status: "absent" }
  | { status: "unreadable"; reason: string };

export async function extendCustody(
  fs: FileSystemPort,
  sessionPath: string,
  extend: (current: SessionCustody) => SessionCustody,
): Promise<CustodyUpdate> {
  const read = await readCustody(fs, sessionPath);
  if (read.status !== "present") return read;
  const next = extend(read.custody);
  await writeCustody(fs, sessionPath, next);
  return { status: "updated", custody: next };
}

/** Re-seal a record after appending to it: the digest always covers the whole. */
function reseal(custody: SessionCustody, changes: Partial<SessionCustody>): SessionCustody {
  return sealCustody({
    subject: changes.subject ?? custody.subject,
    subjectPath: changes.subject_path ?? custody.subject_path,
    parents: changes.parents ?? custody.parents,
    created: changes.created ?? custody.created,
    artifacts: changes.artifacts ?? custody.artifacts,
    sources: changes.sources ?? custody.sources,
    effects: changes.effects ?? custody.effects,
  });
}

/**
 * Record a source as this session first found it, and never again.
 *
 * Idempotent by alias on purpose: `worktree ensure` is idempotent, and a second
 * call re-reading HEAD would overwrite the baseline with a state the session
 * itself produced — the exact way a baseline stops being one.
 */
export function withSourceBaseline(custody: SessionCustody, source: CustodySource): SessionCustody {
  const known = custody.sources.find((s) => s.alias === source.alias);
  if (known !== undefined) {
    // The unit is the one field a later call may legitimately fill: a session can
    // record the source first and take its unit afterwards.
    if (known.unit_branch !== null || source.unit_branch === null) return custody;
    const merged: CustodySource = {
      ...known,
      unit_branch: source.unit_branch,
      unit_path: source.unit_path,
    };
    return reseal(custody, {
      sources: custody.sources.map((s) => (s.alias === source.alias ? merged : s)),
    });
  }
  return reseal(custody, { sources: [...custody.sources, source] });
}

export function withEffect(custody: SessionCustody, effect: CustodyEffect): SessionCustody {
  return reseal(custody, { effects: [...custody.effects, effect] });
}

/**
 * Record what a publication really wrote.
 *
 * The role is decided by what was on disk BEFORE the write, not by what the
 * proposal called itself: an artifact that already existed is an input this
 * session modified — a reset owes its previous bytes back — and one that did not
 * is an output, which a reset simply removes. Re-publishing the same path never
 * downgrades an input into an output, because the first baseline is the true one.
 */
export function withArtifacts(
  custody: SessionCustody,
  artifacts: readonly CustodyArtifact[],
): SessionCustody {
  const merged = [...custody.artifacts];
  for (const artifact of artifacts) {
    if (merged.some((known) => known.path === artifact.path)) continue;
    merged.push(artifact);
  }
  return merged.length === custody.artifacts.length
    ? custody
    : reseal(custody, { artifacts: merged });
}

export function effectNow(
  kind: CustodyEffect["kind"],
  fields: Partial<Omit<CustodyEffect, "kind" | "at">> = {},
  now: Date = new Date(),
): CustodyEffect {
  return {
    kind,
    alias: fields.alias ?? null,
    before: fields.before ?? null,
    after: fields.after ?? null,
    parents: fields.parents ?? [],
    ref: fields.ref ?? null,
    paths: fields.paths ?? [],
    at: localDateIso(now),
  };
}

function isCustodyShape(value: unknown): value is SessionCustody {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.version === "number" &&
    typeof candidate.digest === "string" &&
    typeof candidate.subject_path === "string" &&
    isNode(candidate.subject) &&
    Array.isArray(candidate.parents) &&
    Array.isArray(candidate.artifacts) &&
    Array.isArray(candidate.sources) &&
    Array.isArray(candidate.effects)
  );
}

function isNode(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  return typeof node.kind === "string" && typeof node.key === "string";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
