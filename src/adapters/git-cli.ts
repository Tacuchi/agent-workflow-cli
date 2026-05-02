import type { GitPort } from "../ports/git.js";
import type { ProcessPort } from "../ports/process.js";

export class GitCliAdapter implements GitPort {
  constructor(private readonly process: ProcessPort) {}

  async currentBranch(repoPath: string): Promise<string | undefined> {
    const result = await this.process.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoPath,
    });
    if (result.code !== 0) {
      return undefined;
    }
    const name = result.stdout.trim();
    return name.length > 0 ? name : undefined;
  }

  async isDirty(repoPath: string): Promise<boolean> {
    const result = await this.process.run("git", ["status", "--porcelain"], { cwd: repoPath });
    if (result.code !== 0) {
      throw new Error(`git status failed in ${repoPath}: ${result.stderr.trim()}`);
    }
    return result.stdout.trim().length > 0;
  }

  async changedFiles(repoPath: string): Promise<string[]> {
    const result = await this.process.run("git", ["status", "--porcelain"], { cwd: repoPath });
    if (result.code !== 0) {
      throw new Error(`git status failed in ${repoPath}: ${result.stderr.trim()}`);
    }
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.slice(3));
  }

  async log(args: string[], repoPath: string): Promise<string> {
    const result = await this.process.run("git", ["log", ...args], { cwd: repoPath });
    if (result.code !== 0) {
      throw new Error(`git log failed in ${repoPath}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }
}
