import type { GitPort } from "../ports/git.js";
import type { ProcessPort } from "../ports/process.js";

export class GitCliAdapter implements GitPort {
  constructor(private readonly process: ProcessPort) {}

  async isGitRepo(repoPath: string): Promise<boolean> {
    const result = await this.process.run("git", ["rev-parse", "--git-dir"], { cwd: repoPath });
    return result.code === 0;
  }

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
    // Mirror Python qtc_core.sources._git which does `result.stdout.strip()` BEFORE
    // splitting — this consumes the leading space of the first line in porcelain
    // format (e.g., ` M path` → `M path`, then [3:] would be off by one). We
    // replicate that quirk to keep byte-byte parity with Python while migrating;
    // the bug stays until we fix it in both runtimes.
    const raw = result.stdout.trim();
    return raw
      .split("\n")
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim());
  }

  async log(args: string[], repoPath: string): Promise<string> {
    const result = await this.process.run("git", ["log", ...args], { cwd: repoPath });
    if (result.code !== 0) {
      throw new Error(`git log failed in ${repoPath}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }
}
