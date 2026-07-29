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

export interface GitPort {
  isGitRepo(repoPath: string): Promise<boolean>;
  currentBranch(repoPath: string): Promise<string | undefined>;
  isDirty(repoPath: string): Promise<boolean>;
  changedFiles(repoPath: string): Promise<string[]>;
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
   */
  commit(repoPath: string, message: string): Promise<void>;
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
