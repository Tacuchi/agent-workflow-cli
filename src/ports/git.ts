export interface DiffNumstatEntry {
  added: string;
  removed: string;
  path: string;
}

/** Outcome of a `git merge`: ok=false with conflicted files on merge conflict. */
export interface MergeResult {
  ok: boolean;
  conflicted: string[];
}

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** Absolute path of the working directory. */
  path: string;
  /** HEAD commit; `null` on a branch with no commit yet. */
  head: string | null;
  /** Short branch name (`aw/103-slug`); `null` when the worktree is detached. */
  branch: string | null;
  /** The repository's OWN working tree — always the first entry git reports. */
  main: boolean;
  /** git found the directory gone: `git worktree prune` is what clears it. */
  prunable: boolean;
}

/**
 * What a commit really produced: the ref's value before it, after it, and the
 * parents of the new commit.
 *
 * `parents` is what a revert cannot do without: reverting a merge needs to be
 * told which side to keep, and the answer is a fact about the commit rather than
 * a preference of whoever reverts it later.
 */
export interface CommitReceipt {
  /** The branch the commit landed on; `null` on a detached HEAD. */
  branch: string | null;
  /** HEAD before the commit; `null` when this was the repository's first. */
  before: string | null;
  /** The commit that was created. */
  after: string;
  parents: string[];
}

export interface GitPort {
  isGitRepo(repoPath: string): Promise<boolean>;
  currentBranch(repoPath: string): Promise<string | undefined>;
  isDirty(repoPath: string): Promise<boolean>;
  changedFiles(repoPath: string): Promise<string[]>;
  /**
   * The commit HEAD points at; `null` on an unborn HEAD.
   *
   * A branch NAME is not a baseline — it keeps meaning something different as
   * work lands on it — so what a session records when it first touches a source
   * is the commit, which never changes.
   */
  head(repoPath: string): Promise<string | null>;
  /** Files touched in HEAD diff: `git diff --numstat HEAD`. */
  diffNumstat(repoPath: string): Promise<DiffNumstatEntry[]>;
  /** `git checkout <branch>`. Throws on failure. */
  checkout(repoPath: string, branch: string): Promise<void>;
  /** `git pull` on the checked-out branch. Throws on failure. */
  pull(repoPath: string): Promise<void>;
  /** `git merge <fromBranch>`. Returns ok=false + conflicted files on conflict. */
  merge(repoPath: string, fromBranch: string): Promise<MergeResult>;
  /** `git push <remote?> <branch>`. Plain push (never --force). Throws on failure. */
  push(repoPath: string, branch: string): Promise<void>;
  /** True when the repo is mid-merge (MERGE_HEAD present). */
  isMerging(repoPath: string): Promise<boolean>;
  /** Unmerged paths: `git diff --name-only --diff-filter=U`. */
  conflictedFiles(repoPath: string): Promise<string[]>;
  /**
   * Branch name being merged in (theirs), via `git name-rev` on MERGE_HEAD.
   * Undefined when not mid-merge or the commit can't be named to a ref.
   */
  mergeOrigin(repoPath: string): Promise<string | undefined>;
  /**
   * The three index stages of one conflicted path. Read-only.
   *
   * The blob hashes are what makes a resolution verifiable later: they identify
   * the exact conflict a proposal was written against, so `fix-git apply` can
   * refuse one whose stages moved underneath it.
   */
  conflictStages(repoPath: string, path: string): Promise<ConflictStages>;
  /** `git add -- <path>`. Throws on failure. Never `git add -A`. */
  stagePath(repoPath: string, path: string): Promise<void>;
  /**
   * `git commit -m <message>` on the staged content. Never `--no-verify`,
   * never `--amend`, never a push — those stay outside this port on purpose.
   *
   * It RETURNS what it did. A commit whose SHAs are read back later can only be
   * matched to the run that made it by guessing — by its message, its author or
   * its timestamp — and none of those is evidence. The receipt is the evidence,
   * and it is the only thing a revert proposal is allowed to build on.
   */
  commit(repoPath: string, message: string): Promise<CommitReceipt>;
  /**
   * `git worktree list --porcelain`.
   *
   * This is the LIVE registry of a source's isolation units: git already knows
   * which trees exist, on which branch each one sits, and which ones lost their
   * directory. A registry file of our own could only ever be a second opinion
   * about the same facts — and the one that goes stale.
   */
  worktreeList(repoPath: string): Promise<WorktreeEntry[]>;
  /**
   * `git worktree add` at `worktreePath` on `branch`. With `base` it creates the
   * branch there (`-b`); with `base: null` it checks out a branch that already
   * exists. Throws on failure — including git's own refusal to put the same
   * branch in two worktrees, which is what makes occupancy inherited rather
   * than implemented.
   */
  worktreeAdd(
    repoPath: string,
    worktreePath: string,
    branch: string,
    base: string | null,
  ): Promise<void>;
  /** `git worktree remove <path>`. Throws when the tree has uncommitted work. */
  worktreeRemove(repoPath: string, worktreePath: string): Promise<void>;
  /** `git worktree prune`: drops the administrative entries of vanished trees. */
  worktreePrune(repoPath: string): Promise<void>;
  /** True when `branch` already exists locally. */
  branchExists(repoPath: string, branch: string): Promise<boolean>;
  /**
   * Full names of every ref that CONTAINS `sha` (`git for-each-ref --contains`).
   *
   * What it is for is deciding whether undoing a commit is a local matter. A
   * commit reachable from a remote-tracking ref has been published: reverting it
   * locally is legitimate, rewriting it is not, and publishing that revert is
   * somebody else's separate action. Both halves need to know which case it is,
   * and the refs are the only fact that says so.
   */
  refsContaining(repoPath: string, sha: string): Promise<string[]>;
}

export interface ConflictStage {
  /** Index blob hash, `null` when the stage is absent (add/add, delete/modify). */
  hash: string | null;
  /** Decoded text, `null` when the stage is absent or is not UTF-8 text. */
  content: string | null;
  bytes: number;
}

export interface ConflictStages {
  path: string;
  /** stage 1 — the common ancestor */
  base: ConflictStage;
  /** stage 2 — HEAD */
  ours: ConflictStage;
  /** stage 3 — the branch being merged in */
  theirs: ConflictStage;
  /** Any present stage is not decodable text: never resolved automatically. */
  binary: boolean;
}
