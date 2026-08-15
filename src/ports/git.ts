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
 * One path git reports as changed, in the detail an attribution needs.
 *
 * `changedFiles` answers "which paths moved" and that is not enough to decide
 * whether a change may be discarded: a rename is two paths, an exec-bit flip is a
 * change with identical content, an untracked file has no HEAD side at all, and a
 * symlink or a binary cannot be restored by writing text. Each of those is a
 * different decision, so each one is a field rather than a guess.
 */
export interface LocalChange {
  /** Path as git spells it, relative to the repository root. */
  path: string;
  /** Where a rename came FROM; `null` when the change is not a rename. */
  from: string | null;
  /** The XY code verbatim (`M.`, `.M`, `R.`, `D.`, `??`, `!!`). */
  code: string;
  /** The index differs from HEAD. */
  staged: boolean;
  /** The working tree differs from the index. */
  unstaged: boolean;
  untracked: boolean;
  /** Octal mode in HEAD (`100644`, `100755`, `120000`); `null` when absent. */
  head_mode: string | null;
  /** Octal mode in the working tree; `null` when the path is gone. */
  worktree_mode: string | null;
}

/** A git operation left half-done in the repository. */
export type GitOperationState = "clean" | "merge" | "revert" | "cherry-pick" | "rebase";

/** The outcome of an operation that either happens or explains itself. */
export interface GitAttempt {
  ok: boolean;
  /** Why it refused, verbatim from git. Empty on success. */
  why: string;
}

/** The outcome of rehearsing a revert: conflicts are named, nothing is committed. */
export interface RevertRehearsal {
  ok: boolean;
  conflicted: string[];
  why: string;
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
   * Digest of the exact working-tree state relative to HEAD.
   *
   * `isDirty` and `changedFiles` answer whether a tree changed and which paths
   * moved; neither changes when an already-dirty file's bytes change again.
   * Checkout-bound evidence needs the latter distinction, so this fingerprint
   * includes the binary patch, status metadata and untracked file blobs.
   */
  checkoutFingerprint(repoPath: string): Promise<string>;
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

  // ── The typed surface a retirement is allowed to use ────────────────────────
  //
  // Every question below is asked through a named operation with parsed output.
  // No service builds a git command line: a destructive flow that could pass a
  // string through to git would put the whole safety argument in the hands of
  // whoever composed that string.

  /** `git status --porcelain=v2 -z`, parsed. Untracked included, ignored excluded. */
  localChanges(repoPath: string): Promise<LocalChange[]>;
  /** The value of one ref, or `null` when it does not exist. */
  refValue(repoPath: string, ref: string): Promise<string | null>;
  /** The tree object a revision points at — what "the expected result" IS. */
  treeOf(repoPath: string, rev: string): Promise<string | null>;
  /**
   * Every path a revision's tree contains (`git ls-tree -r --name-only`).
   *
   * Needed for the one collision `read-tree -n -m` does not report: a path the
   * target tree would CREATE where an untracked file already sits. Without `-u`
   * git has no working tree to check, and with `-u` it would be doing the switch —
   * so the dry run answers about tracked content only, and this closes the rest.
   */
  treePaths(repoPath: string, rev: string): Promise<string[]>;
  /** Whether a git operation is half-done, so nothing is attempted over it. */
  operationState(repoPath: string): Promise<GitOperationState>;
  /** True when `ancestor` is reachable from `descendant`. */
  isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean>;
  /**
   * A worktree at `path` on a DETACHED head at `rev`.
   *
   * Detached on purpose: rehearsing a revert must not create a branch somebody
   * could later mistake for work, and it must not be able to move a real ref.
   */
  worktreeAddDetached(repoPath: string, worktreePath: string, rev: string): Promise<void>;
  /**
   * `git revert --no-commit` inside a worktree — the rehearsal.
   *
   * It writes only in that temporary tree and commits nothing, which is what makes
   * "this revert would conflict" answerable BEFORE anybody approves it.
   * `mainline` picks which parent of a merge is kept.
   */
  rehearseRevert(
    worktreePath: string,
    sha: string,
    mainline: number | null,
  ): Promise<RevertRehearsal>;
  /** Commit whatever the rehearsal staged in that worktree. */
  commitIn(worktreePath: string, message: string): Promise<CommitReceipt>;
  /**
   * Whether the working tree could be moved onto `rev` — asked without doing it
   * (`git read-tree -n -m`).
   *
   * This is a PRECONDITION and not a step: the compare-and-swap moves the ref and
   * not the tree, so a sync that could refuse has to refuse before the swap. After
   * the swap there is no way back that is not a rewrite, and a refusal there would
   * be a partial success nobody can resolve.
   */
  canSyncTree(repoPath: string, rev: string): Promise<GitAttempt>;
  /** The same move, performed (`git read-tree -u -m`). Never `reset --hard`. */
  syncTree(repoPath: string, rev: string): Promise<GitAttempt>;
  /**
   * `git update-ref <ref> <next> <expectedOld>` — the single commit point.
   *
   * The expected old value is the whole point: it turns "publish the result" into
   * an operation that either happens exactly once or reports that the world moved.
   */
  updateRefCas(
    repoPath: string,
    ref: string,
    next: string,
    expectedOld: string | null,
  ): Promise<GitAttempt>;
  /** Point a private ref at a commit, so a prepared result stays reachable. */
  setRef(repoPath: string, ref: string, sha: string): Promise<GitAttempt>;
  /** Drop a ref this operation created. Never used on a ref it did not create. */
  deleteRef(repoPath: string, ref: string): Promise<GitAttempt>;
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
