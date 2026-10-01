/**
 * The durable record of the passes to production — and the only place it lives.
 *
 * Same shape and same reasons as the two ledgers next to it: append-only, one
 * JSON record per line, under `.workflow/` and deliberately OUTSIDE `docs/`. A
 * pass is hub state, not a document somebody published.
 *
 * Append-only matters here in a third way, different from the claims ledger's
 * irrevocable fence and from the cut intent's reviewable correction: an arrival
 * and its reversion are BOTH facts that happened, and a reversion that deleted
 * the arrival would make a shipped-then-rolled-back release indistinguishable
 * from one that never shipped. The two records together are the history; either
 * one alone is a smaller truth.
 */

import { join } from "node:path";
import {
  type PassStanding,
  type ReleasePass,
  ReleasePassError,
  type SourceArrival,
  type SqlApplication,
  type SqlApplicationStanding,
  assertDeclarable,
  isArrivalKind,
  passStandingOf,
  sqlApplicationStandingOf,
} from "../domain/release-pass.js";
import { type WorklineNodeId, formatNodeId, isWorklineKind } from "../domain/workline-node.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";

/** Lives next to HISTORY.md, claims.jsonl and cut-intents.jsonl. */
const LEDGER_FILE = "release-passes.jsonl";
const LEDGER_VERSION = 1;

export type ReleasePassEvent =
  | { version: number; at: string; event: "declared"; pass: ReleasePass; cause?: string }
  | { version: number; at: string; event: "arrived"; pass_version: string; arrival: SourceArrival }
  | { version: number; at: string; event: "reverted"; pass_version: string; cause?: string }
  | {
      version: number;
      at: string;
      event: "linked";
      pass_version: string;
      /** Hub-relative path. The file is never opened, moved or renumbered. */
      artifact: string;
    }
  | {
      version: number;
      at: string;
      event: "applied";
      pass_version: string;
      /** The pass ran in this environment (SQL or deployment). Its own axis. */
      application: SqlApplication;
    };

/**
 * `Omit` over a discriminated union collapses it to the keys every member
 * shares, which here is none of the ones that matter. Distributing it keeps each
 * variant's own fields — the alternative is a parameter type that accepts no
 * real event.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type UnversionedEvent = DistributiveOmit<ReleasePassEvent, "version">;

export function releasePassLedgerPath(paths: PathsService): string {
  return join(paths.cwdRoot(), LEDGER_FILE);
}

export interface ReleasePassRead {
  events: ReleasePassEvent[];
  /**
   * Lines that did not parse, kept as a COUNT rather than dropped silently.
   *
   * A ledger nobody can fully read is not an empty ledger, and here the
   * difference decides whether work reads as shipped: an unreadable arrival would
   * make a released pass look open, and an unreadable reversion would make a
   * rolled-back one look live.
   */
  unreadable: number;
}

/** Every record, oldest first. A missing ledger reads as empty, never as an error. */
export async function readReleasePasses(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<ReleasePassRead> {
  const path = releasePassLedgerPath(paths);
  if (!(await fs.exists(path))) return { events: [], unreadable: 0 };
  const raw = await fs.readText(path);
  const events: ReleasePassEvent[] = [];
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

async function append(
  fs: FileSystemPort,
  paths: PathsService,
  event: UnversionedEvent,
): Promise<void> {
  const record = { version: LEDGER_VERSION, ...event } as ReleasePassEvent;
  await fs.appendText(releasePassLedgerPath(paths), `${JSON.stringify(record)}\n`);
}

/**
 * Declare a pass. Refuses a name already in the book.
 *
 * Uniqueness is enforced HERE and only here, which is the whole discipline the
 * version-as-identity choice rests on: after this point the name identifies and
 * nothing reads meaning into its shape. Two passes sharing a name would make
 * every arrival ambiguous about which of them it belongs to.
 */
export async function declarePass(
  fs: FileSystemPort,
  paths: PathsService,
  input: { at: string; pass: ReleasePass; cause?: string },
): Promise<void> {
  assertDeclarable(input.pass);
  const read = await readReleasePasses(fs, paths);
  const taken = read.events.some(
    (event) => event.event === "declared" && event.pass.version === input.pass.version,
  );
  if (taken) {
    throw new ReleasePassError(
      "RELEASE_PASS_VERSION_TAKEN",
      `ya hay un pase declarado con la versión '${input.pass.version}': la versión nombra al pase y dos pases no pueden compartir nombre`,
    );
  }
  await append(fs, paths, {
    at: input.at,
    event: "declared",
    pass: input.pass,
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
  });
}

/** Record that one source arrived. Never verified against the world: declared. */
export async function recordArrival(
  fs: FileSystemPort,
  paths: PathsService,
  input: { at: string; passVersion: string; arrival: SourceArrival },
): Promise<void> {
  await append(fs, paths, {
    at: input.at,
    event: "arrived",
    pass_version: input.passVersion,
    arrival: input.arrival,
  });
}

/**
 * Record that this pass ran against an environment (its SQL or deployment).
 *
 * A fifth fact rather than a fifth arrival kind: it must not reach
 * `passStandingOf`, which crosses arrivals against the pass's CODE sources. An
 * application moves the application axis and leaves the release axis exactly
 * where it was.
 */
export async function recordApplication(
  fs: FileSystemPort,
  paths: PathsService,
  input: { at: string; passVersion: string; application: SqlApplication },
): Promise<void> {
  await append(fs, paths, {
    at: input.at,
    event: "applied",
    pass_version: input.passVersion,
    application: input.application,
  });
}

/** Record a reversion. A new fact that never erases the arrivals it follows. */
export async function recordReversion(
  fs: FileSystemPort,
  paths: PathsService,
  input: { at: string; passVersion: string; cause?: string },
): Promise<void> {
  await append(fs, paths, {
    at: input.at,
    event: "reverted",
    pass_version: input.passVersion,
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
  });
}

/**
 * Link an artifact to a pass, by hub-relative path.
 *
 * The file is checked for EXISTENCE and nothing else — never opened, never moved,
 * never renumbered, never executed. A link is a pointer the pass holds; making it
 * anything more would turn "this release shipped with that document" into a
 * second custodian of the document itself.
 */
export async function linkArtifact(
  fs: FileSystemPort,
  paths: PathsService,
  input: { at: string; passVersion: string; artifact: string },
): Promise<{ linked: true } | { linked: false; reason: string }> {
  const absolute = join(paths.hubDir(), input.artifact);
  if (!(await fs.exists(absolute))) {
    return {
      linked: false,
      reason: `'${input.artifact}' no existe en el hub: un pase enlaza artefactos por ruta, y una ruta que no está no es un artefacto`,
    };
  }
  await append(fs, paths, {
    at: input.at,
    event: "linked",
    pass_version: input.passVersion,
    artifact: input.artifact,
  });
  return { linked: true };
}

/** One pass with everything the book says about it, and its derived standing. */
export interface DerivedPass {
  pass: ReleasePass;
  declared_at: string;
  /**
   * Its place in the book, 0-based. THE order between passes — never a
   * comparison of version names, which are not orderable across sources and may
   * not exist at all for a source that publishes none.
   */
  sequence: number;
  arrivals: SourceArrival[];
  reverted: boolean;
  artifacts: string[];
  standing: PassStanding;
  /** That its SQL ran, per environment, in ledger order. */
  applications: SqlApplication[];
  /** Its application axis, derived apart from `standing` and never folded into it. */
  application: SqlApplicationStanding;
}

/**
 * Every declared pass, in ledger order, with its state derived from its facts.
 *
 * Records naming a version nobody declared are skipped rather than inventing a
 * pass for them: a pass exists because somebody declared it, and an arrival for
 * an unknown name is a damaged record, not a new release.
 */
export function derivePasses(events: readonly ReleasePassEvent[]): DerivedPass[] {
  const declared = declaredPasses(events);
  for (const event of events) applyFact(declared, event);
  for (const derived of declared.values()) {
    derived.standing = passStandingOf(derived.pass, derived.arrivals, derived.reverted);
    derived.application = sqlApplicationStandingOf(derived.applications);
  }
  return [...declared.values()];
}

/** The declarations, in ledger order. A repeated name is history, not a second pass. */
function declaredPasses(events: readonly ReleasePassEvent[]): Map<string, DerivedPass> {
  const byVersion = new Map<string, DerivedPass>();
  for (const event of events) {
    if (event.event !== "declared" || byVersion.has(event.pass.version)) continue;
    byVersion.set(event.pass.version, {
      pass: event.pass,
      declared_at: event.at,
      sequence: byVersion.size,
      arrivals: [],
      reverted: false,
      artifacts: [],
      standing: passStandingOf(event.pass, [], false),
      applications: [],
      application: sqlApplicationStandingOf([]),
    });
  }
  return byVersion;
}

/** One fact onto its pass. A fact about an undeclared name is dropped, never invented into one. */
function applyFact(declared: Map<string, DerivedPass>, event: ReleasePassEvent): void {
  if (event.event === "declared") return;
  const derived = declared.get(event.pass_version);
  if (derived === undefined) return;
  if (event.event === "arrived") derived.arrivals.push(event.arrival);
  else if (event.event === "reverted") derived.reverted = true;
  else if (event.event === "applied") derived.applications.push(event.application);
  else derived.artifacts.push(event.artifact);
}

/**
 * Where one plan stands on the production axis — the third answer matters most.
 *
 * `no-record` is NOT `pending`: a plan closed before this book existed was never
 * going to be named by it, and reporting it as waiting for a pass invents a
 * backlog out of history. Reporting it as released would be worse. Only the
 * record can tell the two apart, and when it says nothing, that is the answer.
 */
export type ProductionStanding =
  | { axis: "in-production"; pass: string; at: string }
  | {
      axis: "pending-pass";
      pass: string;
      /** Sources this pass still needs before it counts as released. */
      missing: string[];
      /**
       * It is pending because its pass was REVERTED, not because it never
       * arrived. Without this the two are indistinguishable at the board, and
       * the most important fact the ledger holds about that row — that it
       * shipped and was rolled back — is lost the moment it is derived. ID-08
       * asks for the work to go back to postponed WITH ITS REASON; this is it.
       */
      reverted: boolean;
    }
  | { axis: "no-record" };

export function productionStandingOf(
  passes: readonly DerivedPass[],
  plan: WorklineNodeId,
): ProductionStanding {
  const key = formatNodeId(plan);
  const carrying = passes.filter((derived) =>
    derived.pass.plans.some((node) => formatNodeId(node) === key),
  );
  if (carrying.length === 0) return { axis: "no-record" };
  // Latest-first: a plan re-shipped by a later pass is described by that pass,
  // and the sequence is the book's, never a comparison of version names.
  const live = [...carrying].reverse().find((derived) => derived.standing.state === "released");
  if (live !== undefined) {
    const last = live.arrivals[live.arrivals.length - 1];
    return { axis: "in-production", pass: live.pass.version, at: last?.at ?? live.declared_at };
  }
  const latest = carrying[carrying.length - 1];
  if (latest === undefined) return { axis: "no-record" };
  // A reversion undoes the release, not the arrivals: the records stay, and what
  // it would take to be live again is the WHOLE pass. Reporting the recorded
  // `missing` here returned an empty list on a pass whose two sources had both
  // arrived — "waiting on a pass" and "nothing is missing" at once, which is no
  // answer at all.
  if (latest.standing.state === "reverted") {
    return {
      axis: "pending-pass",
      pass: latest.pass.version,
      missing: [...latest.pass.sources],
      reverted: true,
    };
  }
  return {
    axis: "pending-pass",
    pass: latest.pass.version,
    missing: latest.standing.missing,
    reverted: false,
  };
}

function parseEvent(line: string): ReleasePassEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { at?: unknown; event?: unknown };
  if (typeof candidate.at !== "string") return null;
  if (candidate.event === "declared") return parseDeclared(value);
  if (candidate.event === "arrived") return parseArrived(value);
  if (candidate.event === "applied") return parseApplied(value);
  if (candidate.event === "reverted" || candidate.event === "linked") return parseSimple(value);
  return null;
}

function parseDeclared(value: object): ReleasePassEvent | null {
  const pass = (value as { pass?: unknown }).pass;
  if (typeof pass !== "object" || pass === null) return null;
  const candidate = pass as Partial<ReleasePass>;
  if (typeof candidate.version !== "string" || candidate.version.length === 0) return null;
  if (!Array.isArray(candidate.sources) || !candidate.sources.every((s) => typeof s === "string")) {
    return null;
  }
  if (!Array.isArray(candidate.plans) || !candidate.plans.every(isNode)) return null;
  return value as ReleasePassEvent;
}

function parseArrived(value: object): ReleasePassEvent | null {
  const candidate = value as { pass_version?: unknown; arrival?: unknown };
  if (typeof candidate.pass_version !== "string") return null;
  const arrival = candidate.arrival;
  if (typeof arrival !== "object" || arrival === null) return null;
  const a = arrival as Partial<SourceArrival>;
  if (typeof a.source !== "string" || a.source.length === 0) return null;
  if (!isArrivalKind(a.kind) || typeof a.detail !== "string" || typeof a.at !== "string") {
    return null;
  }
  return value as ReleasePassEvent;
}

/**
 * An application record. Its own branch so that a well-formed one is not counted
 * as unreadable — and an unreadable application would make SQL that already ran
 * look pending, which is the failure this axis exists to prevent.
 */
function parseApplied(value: object): ReleasePassEvent | null {
  const candidate = value as { pass_version?: unknown; application?: unknown };
  if (typeof candidate.pass_version !== "string") return null;
  const application = candidate.application;
  if (typeof application !== "object" || application === null) return null;
  const a = application as Partial<SqlApplication>;
  if (typeof a.environment !== "string" || a.environment.length === 0) return null;
  if (typeof a.detail !== "string" || typeof a.at !== "string") return null;
  return value as ReleasePassEvent;
}

function parseSimple(value: object): ReleasePassEvent | null {
  const candidate = value as { pass_version?: unknown; event?: unknown; artifact?: unknown };
  if (typeof candidate.pass_version !== "string") return null;
  if (candidate.event === "linked" && typeof candidate.artifact !== "string") return null;
  return value as ReleasePassEvent;
}

function isNode(value: unknown): value is WorklineNodeId {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Partial<WorklineNodeId>;
  return isWorklineKind(node.kind) && typeof node.key === "string" && node.key.length > 0;
}

/**
 * A production axis folded from several.
 *
 * Used for a spec over its plans, and defined HERE rather than at either caller
 * because two spellings of "is this shipped" is exactly the disagreement the
 * single derivation exists to prevent.
 *
 * It FAILS CLOSED on absence. One part the record cannot place makes the whole
 * unplaceable, because a spec whose second plan no pass ever named has not
 * shipped — and filtering that part out before folding is how "one plan
 * released, one never declared" came back as `in-production`. That is the same
 * false claim AC-08 forbids inside a pass, one level up: over-claiming here is
 * the error that costs something, and under-claiming only asks somebody to
 * declare the missing pass.
 */
export function foldProduction(standings: readonly ProductionStanding[]): ProductionStanding {
  if (standings.length === 0) return { axis: "no-record" };
  const unplaceable = standings.find((standing) => standing.axis === "no-record");
  if (unplaceable !== undefined) return unplaceable;
  const pending = standings.find((standing) => standing.axis === "pending-pass");
  if (pending !== undefined) return pending;
  return standings[standings.length - 1] ?? { axis: "no-record" };
}
