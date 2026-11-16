/**
 * Reading and extending a session's custody — the only path that writes it.
 *
 * Every mutation here is an APPEND of something that really happened plus a
 * re-seal, and never a recomputation of the record from the current state of the
 * hub. That distinction is the whole value of the file: a custody rebuilt
 * from what exists now could only ever agree with what exists now, which is the
 * one thing a baseline must not do.
 */

import { join } from "node:path";
import { CUSTODY_FILE, type SessionCustody } from "../domain/session/custody.js";
import type { FileSystemPort } from "../ports/file-system.js";

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
