export interface GitPort {
  currentBranch(repoPath: string): Promise<string | undefined>;
  isDirty(repoPath: string): Promise<boolean>;
  changedFiles(repoPath: string): Promise<string[]>;
  log(args: string[], repoPath: string): Promise<string>;
}
