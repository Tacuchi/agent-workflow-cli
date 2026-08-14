/**
 * Recording into custody what an operation REALLY did.
 *
 * One module rather than a call scattered through each service, for a reason
 * that outlives the code: everything here has to be an observation of a result,
 * and keeping the observations together is what makes it checkable that none of
 * them is a re-derivation. A recorder that read the repository to decide what to
 * write would be a second opinion about the same facts — and the one that goes
 * stale.
 *
 * Every function is a no-op on a session with NO custody. That is the legacy
 * path and it is deliberate: a session born before custody existed keeps running
 * exactly as it did, and it is `discard/reset prepare` — not these writes — that
 * refuses to act without evidence.
 */

import type { CustodyArtifact, CustodySource } from "../domain/session/custody.js";
import { ABSENT_BASELINE, preservedBaseline } from "../domain/session/custody.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { CommitReceipt, GitPort } from "../ports/git.js";
import type { PathsService } from "./paths-service.js";
import { semanticDigest } from "./semantic-operation/protocol.js";
import {
  type CustodyUpdate,
  effectNow,
  extendCustody,
  withArtifacts,
  withEffect,
  withSourceBaseline,
} from "./session-custody-service.js";

/** Enough to write custody. Every recorder needs at least this. */
export interface CustodyWriteDeps {
  fs: FileSystemPort;
  paths: PathsService;
}

/** Plus git, for the recorders whose facts come out of a repository. */
export interface RecorderDeps extends CustodyWriteDeps {
  git: GitPort;
}

/** Where a session's custody lives, given the folder name the caller holds. */
function sessionPathOf(paths: PathsService, sessionFolder: string): string {
  return `${paths.cwdSessionsDir()}/${sessionFolder}`;
}

export interface UnitFacts {
  alias: string;
  /** The source repository, never the unit's working tree. */
  sourcePath: string;
  unitPath: string;
  unitBranch: string;
  /** The source's declared working branch — what the unit was cut from. */
  base: string;
}

/**
 * A session took its isolation unit: seal how the source stood at that moment.
 *
 * The dirty state is recorded because it is the only way to later refuse to
 * discard a change we did not make: whatever was already uncommitted here at
 * baseline belongs to somebody else, and no diff taken afterwards can tell the
 * two apart on its own.
 */
export async function recordUnitTaken(
  deps: RecorderDeps,
  sessionFolder: string,
  facts: UnitFacts,
): Promise<CustodyUpdate> {
  const source = await readSourceBaseline(deps, facts);
  return extendCustody(deps.fs, sessionPathOf(deps.paths, sessionFolder), (custody) =>
    withEffect(withSourceBaseline(custody, source), {
      ...effectNow("unit_taken", {
        alias: facts.alias,
        after: source.baseline_head,
        ref: `refs/heads/${facts.unitBranch}`,
      }),
    }),
  );
}

async function readSourceBaseline(deps: RecorderDeps, facts: UnitFacts): Promise<CustodySource> {
  const dirty = await safeChangedFiles(deps.git, facts.sourcePath);
  return {
    alias: facts.alias,
    path: facts.sourcePath,
    branch: (await safeBranch(deps.git, facts.sourcePath)) ?? facts.base,
    baseline_head: await safeHead(deps.git, facts.unitPath, facts.sourcePath),
    unit_branch: facts.unitBranch,
    unit_path: facts.unitPath,
    dirty_digest: semanticDigest([...dirty].sort()),
    dirty_paths: [...dirty].sort(),
  };
}

/**
 * The unit's own HEAD when it can be read, the source's otherwise.
 *
 * The unit is the tree the session will commit into, so ITS tip is the point its
 * commits start from. Falling back to the source covers the call that records
 * the baseline before the tree is materialized — same branch, same commit.
 */
async function safeHead(
  git: GitPort,
  unitPath: string,
  sourcePath: string,
): Promise<string | null> {
  const fromUnit = await tryHead(git, unitPath);
  return fromUnit ?? (await tryHead(git, sourcePath));
}

async function tryHead(git: GitPort, path: string): Promise<string | null> {
  try {
    return await git.head(path);
  } catch {
    return null;
  }
}

async function safeBranch(git: GitPort, path: string): Promise<string | undefined> {
  try {
    return await git.currentBranch(path);
  } catch {
    return undefined;
  }
}

async function safeChangedFiles(git: GitPort, path: string): Promise<string[]> {
  try {
    return await git.changedFiles(path);
  } catch {
    return [];
  }
}

/** An integration landed: the merge commit it produced is the session's own. */
export async function recordIntegration(
  deps: RecorderDeps,
  sessionFolder: string,
  facts: { alias: string; sourcePath: string; into: string; before: string | null },
): Promise<CustodyUpdate> {
  const after = await tryHead(deps.git, facts.sourcePath);
  return extendCustody(deps.fs, sessionPathOf(deps.paths, sessionFolder), (custody) =>
    withEffect(custody, {
      ...effectNow("unit_integrated", {
        alias: facts.alias,
        before: facts.before,
        after,
        ref: `refs/heads/${facts.into}`,
      }),
    }),
  );
}

/** A typed commit reported its SHAs; they go in verbatim. */
export async function recordCommit(
  deps: RecorderDeps,
  sessionFolder: string,
  alias: string,
  receipt: CommitReceipt,
): Promise<CustodyUpdate> {
  return extendCustody(deps.fs, sessionPathOf(deps.paths, sessionFolder), (custody) =>
    withEffect(custody, {
      ...effectNow("commit", {
        alias,
        before: receipt.before,
        after: receipt.after,
        parents: receipt.parents,
        ref: receipt.branch === null ? null : `refs/heads/${receipt.branch}`,
      }),
    }),
  );
}

export interface PublishedArtifact {
  /** Workspace-relative destination. */
  path: string;
  /** The bytes that were there BEFORE the write; `null` when nothing was. */
  previous: string | null;
}

/**
 * A publication landed: each destination becomes an input or an output.
 *
 * The role comes from what was on disk before the write — the caller reads that
 * and passes it — because after the write the two cases are indistinguishable,
 * and getting them backwards is the difference between a reset that restores a
 * document and one that deletes it.
 */
export async function recordPublication(
  deps: CustodyWriteDeps,
  sessionFolder: string,
  published: readonly PublishedArtifact[],
): Promise<CustodyUpdate> {
  if (published.length === 0) return { status: "absent" };
  const artifacts: CustodyArtifact[] = published.map((entry) => ({
    path: entry.path,
    role: entry.previous === null ? "output" : "input",
    before: entry.previous === null ? ABSENT_BASELINE : preservedBaseline(entry.previous),
  }));
  return extendCustody(deps.fs, sessionPathOf(deps.paths, sessionFolder), (custody) =>
    withEffect(withArtifacts(custody, artifacts), {
      ...effectNow("artifact_published", { paths: artifacts.map((a) => a.path) }),
    }),
  );
}

/** The run adopted a flow: which one, so the trail says what this session IS. */
export async function recordFlowAdoption(
  deps: CustodyWriteDeps,
  sessionFolder: string,
  flow: string,
): Promise<CustodyUpdate> {
  return extendCustody(deps.fs, sessionPathOf(deps.paths, sessionFolder), (custody) =>
    withEffect(custody, { ...effectNow("flow_adopted", { paths: [flow] }) }),
  );
}
