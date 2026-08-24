/**
 * The inventory of touched files a checkpoint reports, bounded on purpose.
 *
 * It used to be `git diff --numstat HEAD` run from wherever the process
 * happened to start, which is not a boundary at all. In a workspace nested
 * inside a bigger repository the effective scope became the parent repository,
 * so a section meant to say "here is where you were" listed hundreds of files
 * belonging to sibling projects while omitting the one file the session had just
 * created. Three properties make it useful again, and each closes one way the
 * old reading could lie:
 *
 * - **The boundary is declared, never inherited.** It is the workspace plus the
 *   source units the session recorded in its own custody — durable, typed
 *   evidence. Nothing is inferred from a path or a name, because guessing at
 *   ownership is precisely what produced the foreign entries.
 * - **Untracked counts as touched.** A file the session just created has no
 *   entry in `HEAD`, so a diff against `HEAD` cannot see it — and that file is
 *   usually the most interesting thing a resume needs to know about.
 * - **A unit that cannot be read says so.** An empty inventory and a failed
 *   collection used to print the same sentence, so "no uncommitted changes"
 *   could equally mean "git exited non-zero and nobody mentioned it".
 *
 * What it deliberately is NOT: a window over the session's lifetime. Attributing
 * changes to the interval a session was open needs data the collection does not
 * have, and would make the same tree answer differently on every read. This is
 * the CURRENT state of the tree, which is the thing a resume can act on.
 */

import type { CustodySource } from "../../domain/session/custody.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import { readCustody } from "../session-custody-service.js";

/** The reserved alias of the workspace itself, the one unit always in scope. */
export const WORKSPACE_UNIT = "workspace";

/**
 * Readable ceiling for the CONTEXTUAL half alone.
 *
 * The old cap applied to the whole list, so twenty unrelated edits were enough
 * to push the session's own file out of sight — the section stayed short and
 * became useless at the same time. Paths the session claims are never subject
 * to it.
 */
export const CONTEXTUAL_LIMIT = 20;

/** One entry, spelled the way the operator will read it. */
export interface TouchedFile {
  /** Unit it belongs to: {@link WORKSPACE_UNIT} or a source alias. */
  unit: string;
  /** Path relative to that unit's boundary. */
  path: string;
  /** Line deltas, or `null` when they were not read for this entry. */
  added: string | null;
  removed: string | null;
  /** The path exists in the working tree but in no commit yet. */
  untracked: boolean;
  /** The session's custody names this path as one of its own artifacts. */
  linked: boolean;
}

/** A unit that was read, and what its inventory stands against. */
export interface ObservedUnit {
  alias: string;
  boundary: string;
  /** Commit the working tree was compared against; `null` on a repo with none. */
  reference: string | null;
}

/** A unit in scope that could not be read, and why not. */
export interface UnobservedUnit {
  alias: string;
  boundary: string;
  reason: string;
}

export interface FilesTouched {
  observed: ObservedUnit[];
  unobserved: UnobservedUnit[];
  /** Paths the session's custody claims, ahead of everything else. */
  linked: TouchedFile[];
  /** The rest of what is inside the boundary, already capped. */
  contextual: TouchedFile[];
  /** Contextual entries the cap left out, per unit. */
  omitted: OmittedFromUnit[];
}

/** How many contextual entries one unit did not get to print. */
export interface OmittedFromUnit {
  unit: string;
  count: number;
}

/**
 * Every entry inside the boundary, including the ones the cap did not print.
 *
 * The reported number is about the SCOPE, not about the section's length: a
 * caller asking "how much did this session touch" is not asking how much fits
 * on screen.
 */
export function totalInScope(touched: FilesTouched): number {
  const cut = touched.omitted.reduce((sum, entry) => sum + entry.count, 0);
  return touched.linked.length + touched.contextual.length + cut;
}

interface ScopedUnit {
  alias: string;
  boundary: string;
}

export async function collectFilesTouched(
  fs: FileSystemPort,
  git: GitPort,
  workspaceRoot: string,
  sessionPath: string,
): Promise<FilesTouched> {
  const custody = await readCustody(fs, sessionPath);
  const present = custody.status === "present" ? custody.custody : null;

  const unobserved: UnobservedUnit[] = [];
  if (custody.status === "unreadable") {
    // "Present and untrustworthy — never silently treated as absent" is the
    // custody reader's own contract. Collapsing it into the legacy no-custody
    // case would drop the session's declared units AND its claimed paths, so
    // the file it just created would fall back into the capped contextual half:
    // the incident's symptom, reached through a different door.
    unobserved.push({ alias: "custodia", boundary: sessionPath, reason: custody.reason });
  }

  // Custody artifact paths are already workspace-relative, which is the same
  // spelling this inventory uses for the workspace unit.
  const claimed = new Set((present?.artifacts ?? []).map((artifact) => artifact.path));

  const units = unitsInScope(present?.sources ?? [], workspaceRoot, unobserved);

  const observed: ObservedUnit[] = [];
  const linked: TouchedFile[] = [];
  const contextual: TouchedFile[] = [];

  for (const unit of units) {
    let entries: TouchedFile[];
    let reference: string | null;
    try {
      entries = await observeUnit(git, unit, claimed);
      reference = await git.head(unit.boundary);
    } catch (err) {
      // One unreadable unit never costs the others their inventory: a partial
      // reading that names what is missing beats a blank that names nothing.
      unobserved.push({ alias: unit.alias, boundary: unit.boundary, reason: reasonOf(err) });
      continue;
    }
    observed.push({ alias: unit.alias, boundary: unit.boundary, reference });
    for (const entry of entries) {
      (entry.linked ? linked : contextual).push(entry);
    }
  }

  linked.sort(byUnitThenPath);
  contextual.sort(byUnitThenPath);
  const { shown, omitted } = shareTheCap(contextual);
  // Counts are read only for what actually gets printed, so the cost tracks the
  // section's length instead of however noisy the surrounding repository is.
  await fillCounts(git, units, [...linked, ...shown]);

  return { observed, unobserved, linked, contextual: shown, omitted };
}

/**
 * Hands the readable cap out round-robin instead of first-come.
 *
 * Sorting puts the workspace first, so a plain `slice` gave the whole cap to
 * whichever unit sorted first: twenty churning docs were enough to print ZERO
 * files from the isolation unit where a plan-exec session does its actual work,
 * while the scope line went on announcing that unit as observed. A reader
 * cannot tell that from a clean unit, which is the confusion AC-06 forbids.
 * The cap stays global — AC-05 says twenty contextual entries — but every unit
 * gets a turn before any unit gets a second entry.
 */
function shareTheCap(contextual: TouchedFile[]): {
  shown: TouchedFile[];
  omitted: OmittedFromUnit[];
} {
  const byUnit = new Map<string, TouchedFile[]>();
  for (const entry of contextual) {
    const bucket = byUnit.get(entry.unit);
    if (bucket === undefined) byUnit.set(entry.unit, [entry]);
    else bucket.push(entry);
  }
  const queues = [...byUnit.entries()];
  const quotas = quotaPerUnit(queues.map(([, queue]) => queue.length));
  const shown: TouchedFile[] = [];
  // Whatever exceeds a unit's quota is what the cap left out, named by its unit
  // so the truncation says WHOSE entries are missing, not merely how many.
  const omitted: OmittedFromUnit[] = [];
  for (const [index, [unit, queue]] of queues.entries()) {
    const quota = quotas[index] ?? 0;
    shown.push(...queue.slice(0, quota));
    if (queue.length > quota) omitted.push({ unit, count: queue.length - quota });
  }
  shown.sort(byUnitThenPath);
  return { shown, omitted };
}

/**
 * Hands out {@link CONTEXTUAL_LIMIT} places round-robin over the given sizes.
 *
 * One place per unit per round, so a unit with three entries keeps all three
 * while a unit with three hundred takes the slack — instead of whichever unit
 * sorted first swallowing the entire cap.
 */
function quotaPerUnit(sizes: number[]): number[] {
  const quotas = sizes.map(() => 0);
  let left = CONTEXTUAL_LIMIT;
  let progressed = true;
  while (left > 0 && progressed) {
    progressed = false;
    for (let i = 0; i < sizes.length && left > 0; i += 1) {
      if ((quotas[i] ?? 0) >= (sizes[i] ?? 0)) continue;
      quotas[i] = (quotas[i] ?? 0) + 1;
      left -= 1;
      progressed = true;
    }
  }
  return quotas;
}

/**
 * The units this session may report on, refusing the ones it cannot name.
 *
 * `isCustodyShape` only checks that `sources` is an array, so every field of an
 * entry reaches here unverified whatever the type claims — a hand-edited or
 * truncated custody is enough. A missing path used to become `cwd: undefined`,
 * which makes git run in the PROCESS's own directory and publish another
 * repository's files as this unit's: the exact defect this module exists to
 * close, with no signal at all. Refusing loudly is the whole point.
 */
function unitsInScope(
  sources: readonly CustodySource[],
  workspaceRoot: string,
  unobserved: UnobservedUnit[],
): ScopedUnit[] {
  const units: ScopedUnit[] = [{ alias: WORKSPACE_UNIT, boundary: workspaceRoot }];
  for (const source of sources) {
    // The isolation unit is where this session's own edits live; a session that
    // took none could only have touched the source checkout itself.
    const boundary = source.unit_path ?? source.path;
    const named = typeof source.alias === "string" && source.alias !== "";
    const alias = named ? source.alias : "(sin alias)";
    if (typeof boundary !== "string" || boundary === "") {
      unobserved.push({
        alias,
        boundary: "(sin ruta)",
        reason: "la custodia no declara unit_path ni path",
      });
    } else if (alias === WORKSPACE_UNIT) {
      // Two units answering to one name would read each other's counts.
      unobserved.push({
        alias,
        boundary,
        reason: `una unidad fuente no puede llamarse ${WORKSPACE_UNIT}`,
      });
    } else {
      units.push({ alias, boundary });
    }
  }
  return units;
}

async function observeUnit(
  git: GitPort,
  unit: ScopedUnit,
  claimed: Set<string>,
): Promise<TouchedFile[]> {
  const prefix = await git.repoPrefix(unit.boundary);
  if (prefix === null) {
    throw new Error(`${unit.boundary} no está dentro de un repositorio Git`);
  }
  const entries: TouchedFile[] = [];
  for (const change of await git.localChanges(unit.boundary)) {
    const path = withinBoundary(change.path, prefix);
    if (path === null) continue;
    entries.push({
      unit: unit.alias,
      path,
      added: null,
      removed: null,
      untracked: change.untracked,
      // Only the workspace unit can match: custody spells its artifacts
      // relative to the workspace and nothing else.
      linked: unit.alias === WORKSPACE_UNIT && claimed.has(path),
    });
  }
  return entries;
}

/**
 * The path relative to the boundary, or `null` when it falls outside it.
 *
 * `localChanges` answers for the whole repository, so in a nested workspace
 * everything a sibling project changed arrives here too. This is the single line
 * that keeps somebody else's work out of this session's checkpoint.
 */
function withinBoundary(repoRelative: string, prefix: string): string | null {
  if (prefix === "") return repoRelative;
  return repoRelative.startsWith(prefix) ? repoRelative.slice(prefix.length) : null;
}

async function fillCounts(
  git: GitPort,
  units: ScopedUnit[],
  entries: TouchedFile[],
): Promise<void> {
  // Walked directly, never indexed by alias: a Map keyed on the alias made two
  // units answering to one name read each other's repository for their counts.
  for (const { alias, boundary } of units) {
    const mine = entries.filter((entry) => entry.unit === alias);
    if (mine.length === 0) continue;
    const tracked = mine.filter((entry) => !entry.untracked).map((entry) => entry.path);
    const untracked = mine.filter((entry) => entry.untracked).map((entry) => entry.path);
    let counts: Record<string, { added: string; removed: string }>;
    try {
      counts = await git.numstatFor(boundary, tracked, untracked);
    } catch {
      // Counts are decoration on top of the path. Losing them is worth a line
      // without numbers, never a section without the file.
      continue;
    }
    for (const entry of mine) {
      const found = counts[entry.path];
      if (found === undefined) continue;
      entry.added = found.added;
      entry.removed = found.removed;
    }
  }
}

/** A total order, so two readings of the same tree cannot disagree. */
function byUnitThenPath(a: TouchedFile, b: TouchedFile): number {
  if (a.unit !== b.unit) {
    if (a.unit === WORKSPACE_UNIT) return -1;
    if (b.unit === WORKSPACE_UNIT) return 1;
    return a.unit < b.unit ? -1 : 1;
  }
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
