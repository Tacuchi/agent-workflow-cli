export interface DiffNumstatEntry {
  added: string;
  removed: string;
  path: string;
}

export interface GitPort {
  isGitRepo(repoPath: string): Promise<boolean>;
  currentBranch(repoPath: string): Promise<string | undefined>;
  isDirty(repoPath: string): Promise<boolean>;
  changedFiles(repoPath: string): Promise<string[]>;
  log(args: string[], repoPath: string): Promise<string>;
  /** Mirror de qtc_core.checkpoint.git_files_touched: `git diff --numstat HEAD`. */
  diffNumstat(repoPath: string): Promise<DiffNumstatEntry[]>;
}
