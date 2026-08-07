import type {
  ConflictStage,
  ConflictStages,
  DiffNumstatEntry,
  GitPort,
  MergeResult,
  WorktreeEntry,
} from "../ports/git.js";
import type { ProcessPort, RunOptions, RunResult } from "../ports/process.js";

/**
 * Non-interactive git env: `GIT_TERMINAL_PROMPT=0` makes git FAIL FAST instead of
 * blocking on a terminal credential prompt (a push against a repo needing creds
 * would otherwise hang the TUI, recoverable only with Ctrl+C). Applied to every
 * git command — harmless for local ops, essential for the network ones.
 */
function nonInteractiveGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export class GitCliAdapter implements GitPort {
  constructor(private readonly process: ProcessPort) {}

  /** Run options for a git command in `repoPath` with the non-interactive env. */
  private opts(repoPath: string, extra: Partial<RunOptions> = {}): RunOptions {
    return { cwd: repoPath, env: nonInteractiveGitEnv(), ...extra };
  }

  /** Run git, throwing `git <label> failed in <repo>: <stderr>` on non-zero exit. */
  private async mustRun(label: string, args: string[], repoPath: string): Promise<RunResult> {
    const result = await this.process.run("git", args, this.opts(repoPath));
    if (result.code !== 0) {
      throw new Error(`git ${label} failed in ${repoPath}: ${result.stderr.trim()}`);
    }
    return result;
  }

  async isGitRepo(repoPath: string): Promise<boolean> {
    const result = await this.process.run("git", ["rev-parse", "--git-dir"], this.opts(repoPath));
    return result.code === 0;
  }

  async currentBranch(repoPath: string): Promise<string | undefined> {
    const result = await this.process.run(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      this.opts(repoPath),
    );
    if (result.code !== 0) {
      return undefined;
    }
    const name = result.stdout.trim();
    return name.length > 0 ? name : undefined;
  }

  async isDirty(repoPath: string): Promise<boolean> {
    const result = await this.mustRun("status", ["status", "--porcelain"], repoPath);
    return result.stdout.trim().length > 0;
  }

  async changedFiles(repoPath: string): Promise<string[]> {
    const result = await this.mustRun("status", ["status", "--porcelain"], repoPath);
    // Split BEFORE trimming, and trim each line on its own.
    //
    // Trimming the whole output first ate the leading space of the FIRST porcelain
    // line (` M path` → `M path`), so the `slice(3)` below came back one character
    // short — and only ever on that line, which is what made it read as a path
    // that simply does not exist (`rc/…` for `src/…`). The comment this replaces
    // called the quirk back-compat for prior consumers; there were none. Every
    // consumer (`aw sources`, `aw check-branch`, the branch hook) shows or counts
    // paths, and no test pinned it either.
    return result.stdout
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((path) => path.length > 0);
  }

  async diffNumstat(repoPath: string): Promise<DiffNumstatEntry[]> {
    try {
      const result = await this.process.run(
        "git",
        ["diff", "--numstat", "HEAD"],
        this.opts(repoPath, { timeoutMs: 5000 }),
      );
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
    await this.mustRun(`checkout ${branch}`, ["checkout", branch], repoPath);
  }

  async pull(repoPath: string): Promise<void> {
    await this.mustRun("pull", ["pull"], repoPath);
  }

  async merge(repoPath: string, fromBranch: string): Promise<MergeResult> {
    const result = await this.process.run("git", ["merge", fromBranch], this.opts(repoPath));
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
    await this.mustRun(`push ${branch}`, ["push", "origin", branch], repoPath);
  }

  async isMerging(repoPath: string): Promise<boolean> {
    const result = await this.process.run(
      "git",
      ["rev-parse", "--verify", "MERGE_HEAD"],
      this.opts(repoPath),
    );
    return result.code === 0;
  }

  async conflictedFiles(repoPath: string): Promise<string[]> {
    const result = await this.process.run(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      this.opts(repoPath),
    );
    if (result.code !== 0) {
      return [];
    }
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async mergeOrigin(repoPath: string): Promise<string | undefined> {
    const result = await this.process.run(
      "git",
      ["name-rev", "--name-only", "MERGE_HEAD"],
      this.opts(repoPath),
    );
    if (result.code !== 0) return undefined;
    const raw = result.stdout.trim();
    if (raw.length === 0 || raw === "undefined") return undefined;
    return cleanRefName(raw);
  }

  async conflictStages(repoPath: string, path: string): Promise<ConflictStages> {
    // `ls-files -u` is the only source that gives BOTH the stage number and the
    // blob hash. Reading the worktree file instead would show the conflict
    // markers git already wrote, not the three sides that produced them.
    const listed = await this.process.run(
      "git",
      ["ls-files", "-u", "--", path],
      this.opts(repoPath),
    );
    const hashes = new Map<string, string>();
    if (listed.code === 0) {
      for (const line of listed.stdout.split("\n")) {
        const match = /^\d+ ([0-9a-f]{40}) ([123])\t/.exec(line);
        if (match?.[1] && match[2]) hashes.set(match[2], match[1]);
      }
    }

    const base = await this.readStage(repoPath, hashes.get("1"));
    const ours = await this.readStage(repoPath, hashes.get("2"));
    const theirs = await this.readStage(repoPath, hashes.get("3"));
    const present = [base, ours, theirs].filter((s) => s.hash !== null);
    return {
      path,
      base,
      ours,
      theirs,
      binary: present.some((s) => s.content === null),
    };
  }

  private async readStage(repoPath: string, hash: string | undefined): Promise<ConflictStage> {
    if (hash === undefined) return { hash: null, content: null, bytes: 0 };
    const result = await this.process.run("git", ["cat-file", "-p", hash], this.opts(repoPath));
    if (result.code !== 0) return { hash, content: null, bytes: 0 };
    const bytes = Buffer.byteLength(result.stdout, "utf8");
    // A NUL byte is the same heuristic git itself uses to call a blob binary.
    const content = result.stdout.includes("\u0000") ? null : result.stdout;
    return { hash, content, bytes };
  }

  async stagePath(repoPath: string, path: string): Promise<void> {
    await this.mustRun(`add ${path}`, ["add", "--", path], repoPath);
  }

  async commit(repoPath: string, message: string): Promise<void> {
    await this.mustRun("commit", ["commit", "-m", message], repoPath);
  }

  async worktreeList(repoPath: string): Promise<WorktreeEntry[]> {
    const result = await this.mustRun(
      "worktree list",
      ["worktree", "list", "--porcelain"],
      repoPath,
    );
    return parseWorktreePorcelain(result.stdout);
  }

  async worktreeAdd(
    repoPath: string,
    worktreePath: string,
    branch: string,
    base: string | null,
  ): Promise<void> {
    const args =
      base === null
        ? ["worktree", "add", worktreePath, branch]
        : ["worktree", "add", "-b", branch, worktreePath, base];
    await this.mustRun(`worktree add ${branch}`, args, repoPath);
  }

  async worktreeRemove(repoPath: string, worktreePath: string): Promise<void> {
    // Never `--force`: a tree with uncommitted work is the user's, and deleting
    // it to make a command succeed is the one failure mode this whole feature
    // exists to prevent.
    await this.mustRun(
      `worktree remove ${worktreePath}`,
      ["worktree", "remove", worktreePath],
      repoPath,
    );
  }

  async worktreePrune(repoPath: string): Promise<void> {
    await this.mustRun("worktree prune", ["worktree", "prune"], repoPath);
  }

  async branchExists(repoPath: string, branch: string): Promise<boolean> {
    const result = await this.process.run(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      this.opts(repoPath),
    );
    return result.code === 0;
  }
}

/**
 * `git worktree list --porcelain`: records separated by a blank line, one
 * `key value` per line. The FIRST record is the repository's own working tree.
 *
 * `branch` arrives as a full ref (`refs/heads/aw/103-x`) and a detached tree
 * carries a bare `detached` line instead — so an absent branch is a real state,
 * not a parse failure.
 */
export function parseWorktreePorcelain(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      current = {
        path: value,
        head: null,
        branch: null,
        main: entries.length === 0,
        prunable: false,
      };
      entries.push(current);
      continue;
    }
    if (current === null) continue;
    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "prunable") current.prunable = true;
  }
  return entries;
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
