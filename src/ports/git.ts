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
}
