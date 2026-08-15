import { createHash } from "node:crypto";
import type {
  CommitReceipt,
  ConflictStage,
  ConflictStages,
  DiffNumstatEntry,
  GitAttempt,
  GitOperationState,
  GitPort,
  LocalChange,
  MergeResult,
  RevertRehearsal,
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

  /**
   * A content-sensitive fingerprint for checkout-bound proof.
   *
   * Git's porcelain status deliberately omits the bytes of a modified file, so
   * it cannot distinguish two edits to the same already-dirty path.  The patch
   * covers tracked content and mode changes; porcelain v2 preserves status and
   * submodule facts; untracked files need their own blob ids because `git diff
   * HEAD` does not include them.  The value never leaves the checkout and is
   * only used as an opaque component of `CheckoutProof.checkout_digest`.
   */
  async checkoutFingerprint(repoPath: string): Promise<string> {
    const [patch, status, untracked] = await Promise.all([
      this.mustRun(
        "diff for checkout fingerprint",
        ["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--"],
        repoPath,
      ),
      this.mustRun("status for checkout fingerprint", ["status", "--porcelain=v2", "-z"], repoPath),
      this.mustRun(
        "untracked files for checkout fingerprint",
        ["ls-files", "--others", "--exclude-standard", "-z"],
        repoPath,
      ),
    ]);
    const hash = createHash("sha256");
    hash.update("patch\0", "utf8");
    hash.update(patch.stdout, "utf8");
    hash.update("status\0", "utf8");
    hash.update(status.stdout, "utf8");

    const paths = untracked.stdout
      .split("\0")
      .filter((path) => path.length > 0)
      .sort();
    for (const path of paths) {
      const blob = await this.mustRun(
        "untracked blob for checkout fingerprint",
        ["hash-object", "--no-filters", "--", path],
        repoPath,
      );
      hash.update("untracked\0", "utf8");
      hash.update(path, "utf8");
      hash.update("\0", "utf8");
      hash.update(blob.stdout.trim(), "utf8");
      hash.update("\0", "utf8");
    }
    return `sha256:${hash.digest("hex")}`;
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

  async commit(repoPath: string, message: string): Promise<CommitReceipt> {
    // HEAD is read BEFORE the commit: after it, the previous value is only
    // reachable through the new commit's own parents, and on the repository's
    // first commit it is not reachable at all.
    const before = await this.headSha(repoPath);
    await this.mustRun("commit", ["commit", "-m", message], repoPath);
    const after = await this.headSha(repoPath);
    if (after === null) {
      throw new Error(`git commit failed in ${repoPath}: HEAD sigue sin apuntar a un commit`);
    }
    return {
      branch: (await this.currentBranch(repoPath)) ?? null,
      before,
      after,
      parents: await this.parentsOf(repoPath, after),
    };
  }

  async head(repoPath: string): Promise<string | null> {
    return this.headSha(repoPath);
  }

  /** `null` on an unborn HEAD — a fresh repository with no commit yet. */
  private async headSha(repoPath: string): Promise<string | null> {
    const result = await this.process.run("git", ["rev-parse", "HEAD"], this.opts(repoPath));
    if (result.code !== 0) return null;
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  }

  private async parentsOf(repoPath: string, sha: string): Promise<string[]> {
    const result = await this.process.run(
      "git",
      ["rev-list", "--parents", "-n", "1", sha],
      this.opts(repoPath),
    );
    if (result.code !== 0) return [];
    // `<sha> <parent…>` — the commit itself leads, so its parents are the rest.
    return result.stdout.trim().split(/\s+/).slice(1);
  }

  async refsContaining(repoPath: string, sha: string): Promise<string[]> {
    const result = await this.process.run(
      "git",
      ["for-each-ref", "--format=%(refname)", `--contains=${sha}`],
      this.opts(repoPath),
    );
    if (result.code !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async localChanges(repoPath: string): Promise<LocalChange[]> {
    const result = await this.mustRun(
      "status --porcelain=v2",
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      repoPath,
    );
    return parseStatusV2(result.stdout);
  }

  async refValue(repoPath: string, ref: string): Promise<string | null> {
    const result = await this.process.run(
      "git",
      ["rev-parse", "--verify", "--quiet", ref],
      this.opts(repoPath),
    );
    const sha = result.stdout.trim();
    return result.code === 0 && sha.length > 0 ? sha : null;
  }

  async treeOf(repoPath: string, rev: string): Promise<string | null> {
    const result = await this.process.run(
      "git",
      ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`],
      this.opts(repoPath),
    );
    const tree = result.stdout.trim();
    return result.code === 0 && tree.length > 0 ? tree : null;
  }

  async treePaths(repoPath: string, rev: string): Promise<string[]> {
    const result = await this.process.run(
      "git",
      ["ls-tree", "-r", "-z", "--name-only", rev],
      this.opts(repoPath),
    );
    if (result.code !== 0) return [];
    return result.stdout.split("\0").filter((p) => p.length > 0);
  }

  async operationState(repoPath: string): Promise<GitOperationState> {
    // git's own pseudo-refs are the record of an interrupted operation, and asking
    // git for them keeps this adapter needing only one binary: a `test -d` on
    // `.git/rebase-merge` would have been a second program to spawn and one that
    // does not exist on Windows.
    for (const [pseudoRef, state] of [
      ["REBASE_HEAD", "rebase"],
      ["MERGE_HEAD", "merge"],
      ["REVERT_HEAD", "revert"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
    ] as Array<[string, GitOperationState]>) {
      if ((await this.refValue(repoPath, pseudoRef)) !== null) return state;
    }
    return "clean";
  }

  async isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.process.run(
      "git",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      this.opts(repoPath),
    );
    return result.code === 0;
  }

  async worktreeAddDetached(repoPath: string, worktreePath: string, rev: string): Promise<void> {
    await this.mustRun(
      "worktree add --detach",
      ["worktree", "add", "--detach", "--quiet", worktreePath, rev],
      repoPath,
    );
  }

  async rehearseRevert(
    worktreePath: string,
    sha: string,
    mainline: number | null,
  ): Promise<RevertRehearsal> {
    const args = ["revert", "--no-commit"];
    if (mainline !== null) args.push("-m", String(mainline));
    args.push(sha);
    const result = await this.process.run("git", args, this.opts(worktreePath));
    if (result.code === 0) return { ok: true, conflicted: [], why: "" };
    const conflicted = await this.conflictedFiles(worktreePath);
    return { ok: false, conflicted, why: result.stderr.trim() };
  }

  async commitIn(worktreePath: string, message: string): Promise<CommitReceipt> {
    return this.commit(worktreePath, message);
  }

  async canSyncTree(repoPath: string, rev: string): Promise<GitAttempt> {
    return this.attempt("read-tree -n -m", ["read-tree", "-n", "-m", rev], repoPath);
  }

  async syncTree(repoPath: string, rev: string): Promise<GitAttempt> {
    return this.attempt("read-tree -u -m", ["read-tree", "-u", "-m", rev], repoPath);
  }

  async updateRefCas(
    repoPath: string,
    ref: string,
    next: string,
    expectedOld: string | null,
  ): Promise<GitAttempt> {
    // An absent old value is spelled as the empty string, which is git's own way
    // of saying "this ref must not exist yet" — not the same as "whatever it is".
    const args = ["update-ref", ref, next, expectedOld ?? ""];
    return this.attempt("update-ref (CAS)", args, repoPath);
  }

  async setRef(repoPath: string, ref: string, sha: string): Promise<GitAttempt> {
    return this.attempt("update-ref", ["update-ref", ref, sha], repoPath);
  }

  async deleteRef(repoPath: string, ref: string): Promise<GitAttempt> {
    return this.attempt("update-ref -d", ["update-ref", "-d", ref], repoPath);
  }

  /** Run git and report whether it agreed, with its own words when it did not. */
  private async attempt(label: string, args: string[], cwd: string): Promise<GitAttempt> {
    const result = await this.process.run("git", args, this.opts(cwd));
    if (result.code === 0) return { ok: true, why: "" };
    const why = result.stderr.trim();
    return { ok: false, why: why.length > 0 ? why : `git ${label} falló en ${cwd}` };
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
/**
 * `git status --porcelain=v2 -z`, parsed into one entry per path.
 *
 * v2 and not v1, and NUL-terminated rather than newline-terminated, for reasons
 * that are all about not guessing: v2 carries the three modes (so an exec-bit flip
 * and a symlink are visible), it marks a rename as a rename with its original
 * path, and `-z` means a filename with a space, a quote or a newline in it arrives
 * intact instead of being re-quoted into something a parser has to undo.
 *
 * A rename record carries TWO paths in one entry, so the walk consumes an extra
 * field for it — which is the one place a split-on-NUL loop cannot be stateless.
 */
export function parseStatusV2(stdout: string): LocalChange[] {
  const fields = stdout.split("\0").filter((f) => f.length > 0);
  const out: LocalChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    const entry = recordOf(field);
    if (entry === null) continue;
    // A rename's original path is the NEXT field, not part of this one — the one
    // place this walk cannot be stateless.
    if (field.startsWith("2 ")) {
      entry.from = fields[i + 1] ?? null;
      i += 1;
    }
    out.push(entry);
  }
  return out;
}

/** One v2 record, whichever of the five kinds it is. `null` = nothing to report. */
function recordOf(field: string): LocalChange | null {
  const kind = field[0];
  if (kind === "?") return untrackedChange(field.slice(2));
  if (kind === "!") return null; // ignored: never this operation's business
  if (kind === "1" || kind === "2") return trackedChange(kind, field.split(" "));
  if (kind === "u") return unmergedChange(field.split(" "));
  return null;
}

/** `u XY sub m1 m2 m3 mW h1 h2 h3 path` — a path left conflicted. */
function unmergedChange(parts: string[]): LocalChange | null {
  const path = parts.slice(10).join(" ");
  if (path.length === 0) return null;
  return {
    path,
    from: null,
    code: parts[1] ?? "UU",
    staged: true,
    unstaged: true,
    untracked: false,
    head_mode: null,
    worktree_mode: modeOrNull(parts[5]),
  };
}

function trackedChange(kind: string, parts: string[]): LocalChange | null {
  // `1 XY sub mH mI mW hH hI path` · `2 XY sub mH mI mW hH hI Xscore path`
  const code = parts[1] ?? "";
  const pathFrom = kind === "1" ? 8 : 9;
  const path = parts.slice(pathFrom).join(" ");
  if (path.length === 0 || code.length < 2) return null;
  return {
    path,
    from: null,
    code,
    staged: code[0] !== ".",
    unstaged: code[1] !== ".",
    untracked: false,
    head_mode: modeOrNull(parts[3]),
    worktree_mode: modeOrNull(parts[5]),
  };
}

function untrackedChange(path: string): LocalChange {
  return {
    path,
    from: null,
    code: "??",
    staged: false,
    unstaged: true,
    untracked: true,
    head_mode: null,
    worktree_mode: null,
  };
}

/** `000000` is git's way of saying "absent on this side", not a mode. */
function modeOrNull(mode: string | undefined): string | null {
  return mode === undefined || mode === "000000" ? null : mode;
}

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
