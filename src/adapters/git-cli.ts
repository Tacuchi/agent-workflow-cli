import type { DiffNumstatEntry, GitPort, MergeResult } from "../ports/git.js";
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
    // NOTE: trim BEFORE splitting consumes the leading space of the first line
    // in porcelain format (e.g., ` M path` → `M path`, then [3:] would be off
    // by one). This quirk is preserved for back-compat with prior consumers.
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

  async diffNumstat(repoPath: string): Promise<DiffNumstatEntry[]> {
    try {
      const result = await this.process.run("git", ["diff", "--numstat", "HEAD"], {
        cwd: repoPath,
        timeoutMs: 5000,
      });
      if (result.code !== 0) return [];
      const entries: DiffNumstatEntry[] = [];
      for (const line of result.stdout.split("\n")) {
        const parts = line.split("\t");
        if (
          parts.length >= 3 &&
          parts[0] !== undefined &&
          parts[1] !== undefined &&
          parts[2] !== undefined
        ) {
          entries.push({ added: parts[0], removed: parts[1], path: parts[2] });
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  async checkout(repoPath: string, branch: string): Promise<void> {
    const result = await this.process.run("git", ["checkout", branch], { cwd: repoPath });
    if (result.code !== 0) {
      throw new Error(`git checkout ${branch} failed in ${repoPath}: ${result.stderr.trim()}`);
    }
  }

  async pull(repoPath: string): Promise<void> {
    const result = await this.process.run("git", ["pull"], { cwd: repoPath });
    if (result.code !== 0) {
      throw new Error(`git pull failed in ${repoPath}: ${result.stderr.trim()}`);
    }
  }

  async merge(repoPath: string, fromBranch: string): Promise<MergeResult> {
    const result = await this.process.run("git", ["merge", fromBranch], { cwd: repoPath });
    if (result.code === 0) {
      return { ok: true, conflicted: [] };
    }
    const conflicted = await this.conflictedFiles(repoPath);
    if (conflicted.length > 0) {
      return { ok: false, conflicted };
    }
    throw new Error(`git merge ${fromBranch} failed in ${repoPath}: ${result.stderr.trim()}`);
  }

  async push(repoPath: string, branch: string): Promise<void> {
    const result = await this.process.run("git", ["push", "origin", branch], { cwd: repoPath });
    if (result.code !== 0) {
      throw new Error(`git push ${branch} failed in ${repoPath}: ${result.stderr.trim()}`);
    }
  }

  async isMerging(repoPath: string): Promise<boolean> {
    const result = await this.process.run("git", ["rev-parse", "--verify", "MERGE_HEAD"], {
      cwd: repoPath,
    });
    return result.code === 0;
  }

  async conflictedFiles(repoPath: string): Promise<string[]> {
    const result = await this.process.run("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd: repoPath,
    });
    if (result.code !== 0) {
      return [];
    }
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async mergeOrigin(repoPath: string): Promise<string | undefined> {
    const result = await this.process.run("git", ["name-rev", "--name-only", "MERGE_HEAD"], {
      cwd: repoPath,
    });
    if (result.code !== 0) return undefined;
    const raw = result.stdout.trim();
    if (raw.length === 0 || raw === "undefined") return undefined;
    return cleanRefName(raw);
  }
}

/**
 * `git name-rev` can return `remotes/origin/x`, `tags/x`, `x~2`, `x^0` — reduce
 * to a branch-ish label (best-effort identification of the incoming branch).
 */
function cleanRefName(name: string): string {
  return name
    .replace(/[~^].*$/, "") // drop ~N / ^N suffixes
    .replace(/^remotes\/[^/]+\//, "") // drop remotes/<remote>/
    .replace(/^tags\//, "");
}
