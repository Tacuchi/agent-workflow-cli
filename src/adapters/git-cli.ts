import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { checkSafeRelativePath } from "../domain/safe-path.js";
import type {
  AheadBehind,
  CommitReceipt,
  ConflictStage,
  ConflictStages,
  DirtyPath,
  GitAttempt,
  GitOperationState,
  GitPort,
  LocalChange,
  MergeResult,
  NumstatCounts,
  RevertRehearsal,
  WorktreeEntry,
} from "../ports/git.js";
import type { ProcessPort, RunBinaryResult, RunOptions, RunResult } from "../ports/process.js";

/**
 * Non-interactive git env: `GIT_TERMINAL_PROMPT=0` makes git FAIL FAST instead of
 * blocking on a terminal credential prompt (a push against a repo needing creds
 * would otherwise hang the TUI, recoverable only with Ctrl+C). Applied to every
 * git command — harmless for local ops, essential for the network ones.
 */
/** Stands in for the blob id of an untracked path git cannot hash; never a real one. */
const UNHASHABLE_BLOB = "unhashable";
const DELETED_BLOB = "deleted";

/** `ls-files -s` entries of mode 160000, by path: the commit each submodule is pinned at. */
function gitlinksOf(staged: Buffer): Map<string, string> {
  const gitlinks = new Map<string, string>();
  for (const entry of nulSeparated(staged)) {
    const tab = entry.indexOf("\t");
    const [mode, object] = entry.slice(0, tab).split(" ");
    if (mode === "160000" && object !== undefined) gitlinks.set(entry.slice(tab + 1), object);
  }
  return gitlinks;
}

function nulSeparated(bytes: Buffer): string[] {
  return bytes
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

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

  private failed(label: string, repoPath: string, stderr: string): Error {
    return new Error(`git ${label} failed in ${repoPath}: ${stderr.trim()}`);
  }

  /** Run git, throwing `git <label> failed in <repo>: <stderr>` on non-zero exit. */
  private async mustRun(
    label: string,
    args: string[],
    repoPath: string,
    extra: Partial<RunOptions> = {},
  ): Promise<RunResult> {
    const result = await this.process.run("git", args, this.opts(repoPath, extra));
    if (result.code !== 0) {
      throw this.failed(label, repoPath, result.stderr);
    }
    return result;
  }

  /** `mustRun` for output that must not be decoded (see `ProcessPort.runBinary`). */
  private async mustRunBinary(
    label: string,
    args: string[],
    repoPath: string,
  ): Promise<RunBinaryResult> {
    const result = await this.process.runBinary("git", args, this.opts(repoPath));
    if (result.code !== 0) {
      throw this.failed(label, repoPath, result.stderr.toString("utf8"));
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
   *
   * Git's output is hashed as BYTES and never decoded: a digest that has to be
   * reproducible cannot depend on a text encoding it does not need.
   */
  async checkoutFingerprint(repoPath: string, excluded?: readonly string[]): Promise<string> {
    const scope = excluded === undefined ? [] : [".", ...excluded.map((p) => `:(exclude)${p}`)];
    const [patch, status, untracked] = await Promise.all([
      this.mustRunBinary(
        "diff for checkout fingerprint",
        ["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--", ...scope],
        repoPath,
      ),
      this.mustRunBinary(
        "status for checkout fingerprint",
        ["status", "--porcelain=v2", "-z", ...(excluded === undefined ? [] : ["--", ...scope])],
        repoPath,
      ),
      this.mustRunBinary(
        "untracked files for checkout fingerprint",
        [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
          ...(excluded === undefined ? [] : ["--", ...scope]),
        ],
        repoPath,
      ),
    ]);
    const hash = createHash("sha256");
    hash.update("patch\0", "utf8");
    hash.update(patch.stdout);
    hash.update("status\0", "utf8");
    hash.update(status.stdout);
    await this.hashUntracked(hash, repoPath, untracked.stdout);
    if (excluded !== undefined) {
      // hash-object alone follows symlinks and omits execute bits. A no-index
      // patch includes both Git's file mode and a symlink's destination.
      for (const path of nulSeparated(untracked.stdout).sort()) {
        const patch = await this.process.runBinary(
          "git",
          ["diff", "--no-index", "--binary", "--no-ext-diff", "--", "/dev/null", path],
          this.opts(repoPath),
        );
        if (patch.code !== 0 && patch.code !== 1)
          throw this.failed("untracked state", repoPath, patch.stderr.toString());
        hash.update(patch.stdout);
      }
    }
    return `sha256:${hash.digest("hex")}`;
  }

  /**
   * The content of the tree under `root` alone, without the excluded subpaths.
   *
   * `checkoutFingerprint` measures the whole repository relative to HEAD, so in a
   * hub a neighbouring project moves it, and so does a commit or a `git add` that
   * changes no byte under `root`. This one is what a batch is compared against:
   * every path under `root` git tracks or would track, each with the blob id of
   * its bytes on disk — so only what the files hold decides whether they changed.
   */
  async scopedFingerprint(root: string, excluded: readonly string[]): Promise<string> {
    const pathspec = ["--", ".", ...excluded.map((path) => `:(exclude)${path}`)];
    const [listed, removed, staged] = await Promise.all([
      this.mustRunBinary(
        "paths for scoped fingerprint",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...pathspec],
        root,
      ),
      this.mustRunBinary(
        "deleted paths for scoped fingerprint",
        ["ls-files", "-z", "--deleted", ...pathspec],
        root,
      ),
      this.mustRunBinary(
        "index for scoped fingerprint",
        ["ls-files", "-z", "-s", ...pathspec],
        root,
      ),
    ]);
    const deleted = new Set(nulSeparated(removed.stdout));
    const paths = [...new Set(nulSeparated(listed.stdout))].sort();
    // A submodule is a directory git records by commit: its entry stands for its
    // content, and handing it to `hash-object` would fail the whole batch. It is
    // the commit STAGED in this repository, so work inside the submodule counts
    // once the parent records it.
    const gitlinks = gitlinksOf(staged.stdout);
    const present = paths.filter((path) => !deleted.has(path) && !gitlinks.has(path));
    const blobs = await this.blobsOf(root, present);
    for (const [path, commit] of gitlinks) blobs.set(path, `gitlink:${commit}`);
    const hash = createHash("sha256");
    for (const path of paths) {
      hash.update(path, "utf8");
      hash.update("\0", "utf8");
      hash.update(deleted.has(path) ? DELETED_BLOB : (blobs.get(path) ?? UNHASHABLE_BLOB), "utf8");
      hash.update("\0", "utf8");
    }
    return `sha256:${hash.digest("hex")}`;
  }

  /**
   * The blob id of each path's bytes, in one `hash-object` when it can.
   *
   * A path git cannot hash, or one whose name breaks the line protocol, sends the
   * batch to the per-path fallback, where an unhashable entry is recorded as such
   * instead of taking the whole tree down.
   */
  private async blobsOf(cwd: string, paths: readonly string[]): Promise<Map<string, string>> {
    const blobs = new Map<string, string>();
    if (paths.length === 0) return blobs;
    const batch = paths.some((path) => path.includes("\n"))
      ? null
      : await this.process.run(
          "git",
          ["hash-object", "--no-filters", "--stdin-paths"],
          this.opts(cwd, { stdin: `${paths.join("\n")}\n` }),
        );
    const ids = batch?.code === 0 ? batch.stdout.trim().split("\n") : [];
    if (ids.length === paths.length) {
      paths.forEach((path, index) => blobs.set(path, ids[index] as string));
      return blobs;
    }
    for (const path of paths) {
      const blob = await this.process.run(
        "git",
        ["hash-object", "--no-filters", "--", path],
        this.opts(cwd),
      );
      if (blob.code === 0) blobs.set(path, blob.stdout.trim());
    }
    return blobs;
  }

  /** Each untracked path with its blob id, in a stable order. */
  private async hashUntracked(
    hash: ReturnType<typeof createHash>,
    cwd: string,
    listing: Buffer,
  ): Promise<void> {
    for (const path of nulSeparated(listing).sort()) {
      const blob = await this.process.run(
        "git",
        ["hash-object", "--no-filters", "--", path],
        this.opts(cwd),
      );
      hash.update("untracked\0", "utf8");
      hash.update(path, "utf8");
      hash.update("\0", "utf8");
      // A dangling symlink, a link to a directory, or a file git cannot open has
      // no blob id, and it is recorded as such. Failing here dropped the WHOLE
      // source from the eligible set — one unhashable entry left a readable tree
      // with no way to prove itself, rejected for a source that does exist.
      hash.update(blob.code === 0 ? blob.stdout.trim() : UNHASHABLE_BLOB, "utf8");
      hash.update("\0", "utf8");
    }
  }

  async repoPrefix(repoPath: string): Promise<string | null> {
    const result = await this.process.run(
      "git",
      ["rev-parse", "--show-prefix"],
      this.opts(repoPath),
    );
    // A non-zero exit here means "this is not a repository", which is a real
    // answer about a boundary rather than a failure to report as one.
    if (result.code !== 0) return null;
    return result.stdout.trim();
  }

  async numstatFor(
    repoPath: string,
    tracked: string[],
    untracked: string[],
  ): Promise<Record<string, NumstatCounts>> {
    return {
      ...(await this.trackedNumstat(repoPath, tracked)),
      ...(await this.untrackedNumstat(repoPath, untracked)),
    };
  }

  private async trackedNumstat(
    repoPath: string,
    paths: string[],
  ): Promise<Record<string, NumstatCounts>> {
    if (paths.length === 0) return {};
    // `--relative` makes git spell the answer the way the caller asked the
    // question — relative to THIS directory, not to the repository root — so a
    // nested workspace gets back the same paths it passed in.
    //
    // `-z` is not a nicety: without it git applies `core.quotePath` and answers
    // `"a\303\261o.txt"` for a path the caller asked about as `año.txt`. The
    // lookup then misses and that file silently loses its counts. `localChanges`
    // already reads with `-z`, so this keeps both sides in one spelling.
    // Records are `added TAB removed TAB path NUL`.
    const result = await this.process.run(
      "git",
      ["diff", "--numstat", "-z", "--relative", "HEAD", "--", ...paths],
      this.opts(repoPath, { timeoutMs: 5000 }),
    );
    if (result.code !== 0) return {};
    const counts: Record<string, NumstatCounts> = {};
    for (const record of result.stdout.split("\0")) {
      const [added, removed, path] = record.split("\t");
      if (added !== undefined && removed !== undefined && path !== undefined) {
        counts[path] = { added, removed };
      }
    }
    return counts;
  }

  /**
   * A path with no entry in `HEAD` is counted against an empty file instead.
   *
   * `--no-index` exits 1 to say "there ARE differences", which is the only
   * outcome a brand-new file can produce. Reading that as failure is what would
   * leave every untracked path — the ones a resume most needs — uncounted.
   */
  private async untrackedNumstat(
    repoPath: string,
    paths: string[],
  ): Promise<Record<string, NumstatCounts>> {
    const counts: Record<string, NumstatCounts> = {};
    for (const path of paths) {
      const result = await this.process.run(
        "git",
        // The LITERAL "/dev/null", never the platform's own null device: git
        // special-cases this exact string as the empty side everywhere, Git for
        // Windows included, while Windows's real null device is just a path it
        // fails to read — which would leave every untracked file uncounted.
        ["diff", "--numstat", "--no-index", "--", "/dev/null", path],
        this.opts(repoPath, { timeoutMs: 5000 }),
      );
      if (result.code !== 0 && result.code !== 1) continue;
      const [added, removed] = (result.stdout.split("\n")[0] ?? "").split("\t");
      if (added !== undefined && removed !== undefined) {
        counts[path] = { added, removed };
      }
    }
    return counts;
  }

  async checkout(repoPath: string, branch: string): Promise<void> {
    await this.mustRun(`checkout ${branch}`, ["checkout", branch], repoPath);
  }

  async remoteHasBranch(repoPath: string, branch: string): Promise<boolean> {
    const result = await this.process.run(
      "git",
      ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
      this.opts(repoPath),
    );
    if (result.code === 0) return true;
    // `--exit-code` answers 2 exactly when origin was read and nothing matched.
    if (result.code === 2) return false;
    throw this.failed(`ls-remote origin ${branch}`, repoPath, result.stderr);
  }

  async fetchBranch(repoPath: string, branch: string): Promise<void> {
    await this.mustRun(
      `fetch origin ${branch}`,
      ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      repoPath,
    );
  }

  async fastForward(repoPath: string, rev: string): Promise<void> {
    await this.mustRun(`merge --ff-only ${rev}`, ["merge", "--ff-only", rev], repoPath);
  }

  async aheadBehind(repoPath: string, left: string, right: string): Promise<AheadBehind> {
    const result = await this.mustRun(
      `rev-list ${left}...${right}`,
      ["rev-list", "--left-right", "--count", `${left}...${right}`],
      repoPath,
    );
    const [ahead, behind] = result.stdout.trim().split(/\s+/).map(Number);
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  }

  async revList(
    repoPath: string,
    include: string,
    exclude: string[],
    options: { firstParent?: boolean } = {},
  ): Promise<string[]> {
    const walk = options.firstParent === true ? ["--first-parent"] : [];
    const result = await this.mustRun(
      `rev-list ${include}`,
      ["rev-list", ...walk, include, "--not", ...exclude],
      repoPath,
    );
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
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
    // An explicit refspec: the branch lands on its homonym and nowhere else,
    // whatever `push.default` or the branch's upstream say.
    await this.mustRun(
      `push ${branch}`,
      ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`],
      repoPath,
    );
  }

  async isMerging(repoPath: string): Promise<boolean> {
    const result = await this.process.run(
      "git",
      ["rev-parse", "--verify", "MERGE_HEAD"],
      this.opts(repoPath),
    );
    return result.code === 0;
  }

  async mergeHeads(repoPath: string): Promise<string[]> {
    const where = await this.mustRun(
      "rev-parse --git-path MERGE_HEAD",
      ["rev-parse", "--git-path", "MERGE_HEAD"],
      repoPath,
    );
    try {
      const text = await readFile(resolve(repoPath, where.stdout.trim()), "utf8");
      return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async mergeBases(repoPath: string): Promise<string[]> {
    const result = await this.process.run(
      "git",
      ["merge-base", "--all", "HEAD", "MERGE_HEAD"],
      this.opts(repoPath),
    );
    if (result.code === 1) return [];
    if (result.code !== 0) throw this.failed("merge-base --all", repoPath, result.stderr);
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
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
    const hashes = new Map<string, { hash: string; mode: string }>();
    if (listed.code === 0) {
      for (const line of listed.stdout.split("\n")) {
        const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([123])\t/.exec(line);
        if (match?.[1] && match[2] && match[3])
          hashes.set(match[3], { mode: match[1], hash: match[2] });
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

  async indexEntry(repoPath: string, path: string): Promise<{ mode: string; hash: string } | null> {
    const listed = await this.mustRun(
      `ls-files -s ${path}`,
      ["ls-files", "-s", "--", path],
      repoPath,
    );
    const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t/.exec(listed.stdout);
    return match?.[1] && match[2] ? { mode: match[1], hash: match[2] } : null;
  }

  async isWorktreeCleanPath(repoPath: string, path: string): Promise<boolean> {
    const result = await this.process.run(
      "git",
      ["diff", "--quiet", "--", path],
      this.opts(repoPath),
    );
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw this.failed(`diff --quiet ${path}`, repoPath, result.stderr);
  }

  async readBlob(
    repoPath: string,
    hash: string,
  ): Promise<{ content: string | null; bytes: number }> {
    const stage = await this.readStage(repoPath, { hash, mode: "100644" });
    return { content: stage.content, bytes: stage.bytes };
  }

  async hashBlob(repoPath: string, content: string): Promise<string> {
    const result = await this.mustRun(
      "hash-object",
      ["hash-object", "-w", "--no-filters", "--stdin"],
      repoPath,
      { stdin: content },
    );
    return result.stdout.trim();
  }

  async setIndexEntry(repoPath: string, path: string, mode: string, hash: string): Promise<void> {
    await this.mustRun(
      `update-index ${path}`,
      ["update-index", "--add", "--cacheinfo", `${mode},${hash},${path}`],
      repoPath,
    );
    await this.mustRun(`checkout-index ${path}`, ["checkout-index", "-f", "--", path], repoPath);
  }

  async removeIndexEntry(repoPath: string, path: string): Promise<void> {
    await this.mustRun(
      `update-index --force-remove ${path}`,
      ["update-index", "--force-remove", "--", path],
      repoPath,
    );
  }

  private async readStage(
    repoPath: string,
    entry: { hash: string; mode: string } | undefined,
  ): Promise<ConflictStage> {
    if (entry === undefined) return { hash: null, content: null, bytes: 0, mode: null };
    const { hash, mode } = entry;
    const result = await this.process.runBinary(
      "git",
      ["cat-file", "-p", hash],
      this.opts(repoPath),
    );
    if (result.code !== 0) return { hash, content: null, bytes: 0, mode };
    // A NUL byte is the same heuristic git itself uses to call a blob binary.
    const binary = result.stdout.includes(0);
    // The size is the bytes git stored, which a decoded blob no longer measures.
    return {
      hash,
      content: binary ? null : result.stdout.toString("utf8"),
      bytes: result.stdout.length,
      mode,
    };
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

  async commitPaths(repoPath: string, message: string, paths: string[]): Promise<CommitReceipt> {
    if (
      paths.length === 0 ||
      paths.some(
        (path) =>
          path.length === 0 ||
          path.startsWith("-") ||
          path.includes("\0") ||
          !checkSafeRelativePath(path).ok,
      )
    ) {
      throw new Error("git commitPaths exige rutas relativas explícitas no vacías");
    }
    const before = await this.headSha(repoPath);
    await this.mustRun("add -- paths", ["add", "--", ...paths], repoPath);
    await this.mustRun(
      "commit --only -- paths",
      ["commit", "--only", "-m", message, "--", ...paths],
      repoPath,
    );
    const after = await this.headSha(repoPath);
    if (after === null || after === before)
      throw new Error(`git commitPaths no movió HEAD en ${repoPath}`);
    return {
      branch: (await this.currentBranch(repoPath)) ?? null,
      before,
      after,
      parents: await this.parentsOf(repoPath, after),
    };
  }

  async dirtyPaths(repoPath: string): Promise<DirtyPath[]> {
    const changes = await this.localChanges(repoPath);
    const byPath = new Map<string, string>();
    for (const change of changes) {
      const files = [change.path, ...(change.from === null ? [] : [change.from])];
      for (const path of files) {
        const absolute = resolve(repoPath, path);
        let bytes: Buffer | string = "deleted";
        try {
          const stats = await lstat(absolute);
          bytes = stats.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const digest = createHash("sha256")
          .update(change.code)
          .update("\0")
          .update(change.head_mode ?? "")
          .update("\0")
          .update(change.worktree_mode ?? "")
          .update("\0")
          .update(bytes)
          .digest("hex");
        byPath.set(path, digest);
      }
    }
    return [...byPath]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, digest]) => ({ path, digest }));
  }

  async commitInfo(
    repoPath: string,
    sha: string,
  ): Promise<{ message: string; paths: string[]; parents: string[] }> {
    const [message, changed, parents] = await Promise.all([
      this.mustRun("show --format=%B", ["show", "-s", "--format=%B", sha], repoPath),
      this.mustRun(
        "diff-tree --name-only",
        ["diff-tree", "--root", "--no-commit-id", "-r", "-z", "--name-only", sha],
        repoPath,
      ),
      this.parentsOf(repoPath, sha),
    ]);
    return {
      message: message.stdout.trimEnd(),
      paths: changed.stdout.split("\0").filter(Boolean).sort(),
      parents,
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

  async createBranch(
    repoPath: string,
    branch: string,
    startPoint: string,
    options: { track: boolean },
  ): Promise<void> {
    await this.mustRun(
      `branch ${branch}`,
      ["branch", options.track ? "--track" : "--no-track", branch, startPoint],
      repoPath,
    );
  }

  async localBranches(repoPath: string): Promise<string[]> {
    const result = await this.mustRun(
      "for-each-ref refs/heads",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      repoPath,
    );
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async upstreamBranch(repoPath: string, branch: string): Promise<string | null> {
    const result = await this.mustRun(
      "for-each-ref upstream",
      ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`],
      repoPath,
    );
    return result.stdout.trim() || null;
  }

  async originFetchRefspecs(repoPath: string): Promise<string[]> {
    const result = await this.process.run(
      "git",
      ["config", "--get-all", "remote.origin.fetch"],
      this.opts(repoPath),
    );
    // `config --get-all` exits 1 when the key is unset: no refspec, not a failure.
    if (result.code === 1) return [];
    if (result.code !== 0) throw this.failed("config remote.origin.fetch", repoPath, result.stderr);
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
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
  return (
    name
      .replace(/[~^].*$/, "") // drop ~N / ^N suffixes
      // keep the remote: `origin/feature/x` brought into `feature/x` is not the
      // branch bringing itself, which is what dropping it would say
      .replace(/^remotes\//, "")
      .replace(/^tags\//, "")
  );
}
