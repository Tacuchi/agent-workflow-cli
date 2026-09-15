/**
 * The durable record of how somebody meant to execute a cut — and the only place
 * it lives.
 *
 * Same shape and same reasons as the claims ledger next to it: append-only, one
 * JSON record per line, under `.workflow/` and deliberately OUTSIDE `docs/`. The
 * corpus is for documents somebody published; an intent is workspace state, not a
 * document, and putting it in `docs/` would make the record itself look like a
 * spec or a plan.
 *
 * Append-only is load-bearing for a different reason here than there. A
 * revocation has to be irrevocable; an intent, by contrast, is *meant* to be
 * corrected — plans get reordered, a group gets split, something moves to the
 * next pass. So a correction is a NEW record that supersedes the previous one
 * for reading, and the previous one stays exactly where it was. Rewriting it
 * would destroy the one thing that makes a reorder reviewable: what the order
 * used to be, and therefore that somebody changed it.
 */

import { join } from "node:path";
import {
  type CutIntent,
  type CutIntentReading,
  assertDeclarable,
  positionOf,
} from "../domain/cut-intent.js";
import { type WorklineNodeId, formatNodeId, isWorklineKind } from "../domain/workline-node.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";

/** Lives next to HISTORY.md and claims.jsonl: workspace state, never corpus. */
const LEDGER_FILE = "cut-intents.jsonl";
const LEDGER_VERSION = 1;

export interface CutIntentEvent {
  version: number;
  /** ISO instant, so two records about one cut read in the order they happened. */
  at: string;
  event: "declared";
  intent: CutIntent;
  /** Why it was declared or corrected — the half a later reader cannot recover. */
  cause?: string;
}

export function cutIntentLedgerPath(paths: PathsService): string {
  return join(paths.cwdRoot(), LEDGER_FILE);
}

/**
 * Add one record. Append-only by construction: there is no update and no delete.
 *
 * Validated before the write for the reason the whole file exists: a malformed
 * record cannot be corrected in place, only buried, so the cheap refusal is here.
 * One record is one short line, so `O_APPEND` keeps concurrent writers from
 * interleaving halves of it — the same bound the claims ledger relies on, and the
 * same reason a record is not pretty-printed.
 */
export async function appendCutIntent(
  fs: FileSystemPort,
  paths: PathsService,
  event: Omit<CutIntentEvent, "version" | "event">,
): Promise<void> {
  assertDeclarable(event.intent);
  const record: CutIntentEvent = { version: LEDGER_VERSION, event: "declared", ...event };
  await fs.appendText(cutIntentLedgerPath(paths), `${JSON.stringify(record)}\n`);
}

export interface CutIntentRead {
  events: CutIntentEvent[];
  /**
   * Lines that did not parse, kept as a COUNT rather than dropped silently.
   *
   * A ledger nobody can fully read is not an empty ledger. Reporting "no intent
   * declared" from a file with unreadable lines would invent the silence this
   * record exists to end, and the board would then present the correlative as
   * somebody's decision.
   */
  unreadable: number;
}

/** Every record, oldest first. A missing ledger reads as empty, never as an error. */
export async function readCutIntents(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<CutIntentRead> {
  const path = cutIntentLedgerPath(paths);
  if (!(await fs.exists(path))) return { events: [], unreadable: 0 };
  const raw = await fs.readText(path);
  const events: CutIntentEvent[] = [];
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

function parseEvent(line: string): CutIntentEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<CutIntentEvent>;
  if (typeof candidate.at !== "string" || candidate.event !== "declared") return null;
  const intent = candidate.intent;
  if (typeof intent !== "object" || intent === null) return null;
  if (!isNode(intent.spec) || !isNodeList(intent.order) || !isNodeList(intent.deferred)) {
    return null;
  }
  return value as CutIntentEvent;
}

function isNode(value: unknown): value is WorklineNodeId {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Partial<WorklineNodeId>;
  return isWorklineKind(node.kind) && typeof node.key === "string" && node.key.length > 0;
}

function isNodeList(value: unknown): value is WorklineNodeId[] {
  return Array.isArray(value) && value.every(isNode);
}

/**
 * The intent in force for this spec: the LAST record about it, or `null`.
 *
 * Derived rather than stored, because the ledger is append-only and a "current"
 * flag would be exactly the mutable state that makes an append-only log
 * pointless. Last-wins is the whole correction mechanism: declaring again is how
 * you fix an order, and the superseded record stays readable above it.
 */
export function currentIntentOf(
  events: readonly CutIntentEvent[],
  spec: WorklineNodeId,
): CutIntentEvent | null {
  const key = formatNodeId(spec);
  let current: CutIntentEvent | null = null;
  for (const event of events) {
    if (formatNodeId(event.intent.spec) === key) current = event;
  }
  return current;
}

/**
 * The intent in force that mentions this plan, or `null`.
 *
 * Asked by plan rather than by spec because that is the question the board has:
 * it is holding a plan and wants to know where the person put it. A plan is
 * mentioned by at most one cut in force — its spec's — so the first match is the
 * answer, and a plan named by a superseded record only counts if the record that
 * superseded it still names it.
 */
export function currentIntentForPlan(
  events: readonly CutIntentEvent[],
  plan: WorklineNodeId,
): CutIntentEvent | null {
  const specs = new Set(events.map((event) => formatNodeId(event.intent.spec)));
  const key = formatNodeId(plan);
  for (const spec of specs) {
    const [kind, ...rest] = spec.split(":");
    if (!isWorklineKind(kind)) continue;
    const current = currentIntentOf(events, { kind, key: rest.join(":") });
    if (current === null) continue;
    const mentioned = [...current.intent.order, ...current.intent.deferred].some(
      (node) => formatNodeId(node) === key,
    );
    if (mentioned) return current;
  }
  return null;
}

/**
 * What the workspace answers about one plan — the explicit reading, never a list.
 *
 * The `declared: false` branch carries its reason because the three ways a plan
 * can have no declared place are not the same thing to the person reading it:
 * nobody ever declared a cut for its spec, the ledger could not be fully read, or
 * a cut exists and simply does not mention this plan. Collapsing them into an
 * empty list is what would let a caller fill the silence with the correlative.
 */
export function readingForPlan(read: CutIntentRead, plan: WorklineNodeId): CutIntentReading {
  const current = currentIntentForPlan(read.events, plan);
  if (current === null) {
    if (read.unreadable > 0) {
      return {
        declared: false,
        reason: `no hay intención declarada legible para '${formatNodeId(plan)}': el libro tiene ${read.unreadable} línea(s) que no se pueden leer, así que su ausencia no está probada`,
      };
    }
    return {
      declared: false,
      reason: `nadie declaró una intención de corte que nombre a '${formatNodeId(plan)}'`,
    };
  }
  return {
    declared: true,
    intent: current.intent,
    at: current.at,
    position: positionOf(current.intent, plan),
  };
}
