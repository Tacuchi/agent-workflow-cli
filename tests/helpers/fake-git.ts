import type { DiffNumstatEntry, GitPort, MergeResult } from "../../src/ports/git.js";

/** A recorded GitPort call: method name + positional args. */
export interface GitCall {
  op: string;
  repo: string;
  arg?: string;
}

/**
 * Scripted merge outcome keyed by `fromBranch`. Absent ⇒ clean merge.
 * `conflicted` non-empty ⇒ the merge "conflicts" (ok=false) on every call
 * until {@link RecordingGitOptions.resolveAfterFirstConflict} clears it.
 */
export interface ScriptedMerge {
  conflicted: string[];
}

export interface RecordingGitOptions {
  /** Initial checked-out branch per repo (defaults to `main`). */
  currentBranch?: string;
  isRepo?: boolean;
  changed?: string[];
  /** Scripted conflicts keyed by the merged-in branch name. */
  conflicts?: Record<string, string[]>;
  /** When true, a conflicting merge resolves (becomes clean) on the next call. */
  resolveAfterFirstConflict?: boolean;
  /** When true, `isDirty` returns true for EVERY repo (uncommitted-changes precondition). */
  dirty?: boolean;
  /** Repos whose working tree is dirty. Lets a batch mix healthy and failing sources. */
  dirtyRepos?: string[];
  /**
   * Git op that throws when invoked. The precondition probes are included on
   * purpose: the real adapter's `isDirty`/`isMerging` reject when the path is
   * not a usable repo, and a batch must survive that.
   */
  throwOn?: "checkout" | "pull" | "push" | "merge" | "isDirty" | "isMerging";
  /** Repos whose precondition probes throw (path missing / not a git repo). */
  throwOnRepos?: string[];
  /** Start mid-merge (MERGE_HEAD present) without calling `merge()` first. */
  merging?: boolean;
  /** Conflicted files returned by `conflictedFiles()` while mid-merge. */
  conflicted?: string[];
  /** Incoming (theirs) branch name returned by `mergeOrigin()` while mid-merge. */
  mergeOrigin?: string;
}

/**
 * Reusable in-memory GitPort that records every call and tracks the checked-out
 * branch + mid-merge state, so service tests can assert the step sequence,
 * conflict-pause, and resume-from-mid-merge behaviour.
 *
 * State is kept PER REPO: sources are separate repositories with separate
 * `.git`, so a conflict left mid-merge in one must not make the next source
 * look mid-merge. Sharing it would fake a cascade that cannot happen — which
 * only stayed invisible while `--all` was fail-stop.
 */
export class RecordingGit implements GitPort {
  public readonly calls: GitCall[] = [];
  private readonly branches = new Map<string, string>();
  private readonly merging = new Map<string, boolean>();
  private readonly pendingConflicts = new Map<string, string[]>();
  private readonly conflicts: Record<string, string[]>;
  private readonly seenConflict = new Set<string>();
  /** Mid-merge state for repos not touched yet (from `merging`, cleared on resolve). */
  private mergingByDefault: boolean;

  constructor(private readonly opts: RecordingGitOptions = {}) {
    this.conflicts = opts.conflicts ?? {};
    this.mergingByDefault = opts.merging ?? false;
  }

  private branchOf(repo: string): string {
    return this.branches.get(repo) ?? this.opts.currentBranch ?? "main";
  }

  private isMergingIn(repo: string): boolean {
    return this.merging.get(repo) ?? this.mergingByDefault;
  }

  async isGitRepo(_repo: string): Promise<boolean> {
    return this.opts.isRepo ?? true;
  }

  async currentBranch(repo: string): Promise<string | undefined> {
    this.calls.push({ op: "currentBranch", repo });
    return this.branchOf(repo);
  }

  async isDirty(repo: string): Promise<boolean> {
    this.maybeThrowForRepo("isDirty", repo);
    if (this.opts.dirtyRepos?.includes(repo)) return true;
    return this.opts.dirty ?? false;
  }

  /** Mirrors the real adapter: the probe rejects for an unusable repo path. */
  private maybeThrowForRepo(op: RecordingGitOptions["throwOn"], repo: string): void {
    if (this.opts.throwOnRepos?.includes(repo)) {
      throw new Error(`git ${op} failed in ${repo}: not a git repository`);
    }
    this.maybeThrow(op);
  }

  async changedFiles(_repo: string): Promise<string[]> {
    return this.opts.changed ?? [];
  }

  async diffNumstat(_repo: string): Promise<DiffNumstatEntry[]> {
    return [];
  }

  private maybeThrow(op: RecordingGitOptions["throwOn"]): void {
    if (this.opts.throwOn === op) throw new Error(`git ${op} failed (scripted)`);
  }

  async checkout(repo: string, branch: string): Promise<void> {
    this.calls.push({ op: "checkout", repo, arg: branch });
    this.maybeThrow("checkout");
    this.branches.set(repo, branch);
  }

  async pull(repo: string): Promise<void> {
    this.calls.push({ op: "pull", repo, arg: this.branchOf(repo) });
    this.maybeThrow("pull");
  }

  async merge(repo: string, fromBranch: string): Promise<MergeResult> {
    this.calls.push({ op: "merge", repo, arg: fromBranch });
    this.maybeThrow("merge");
    const scripted = this.conflicts[fromBranch];
    if (scripted && scripted.length > 0) {
      const key = `${repo}\0${fromBranch}`;
      if (this.seenConflict.has(key) && this.opts.resolveAfterFirstConflict) {
        // Conflict resolved by the user; merge now completes cleanly.
        this.merging.set(repo, false);
        this.pendingConflicts.set(repo, []);
        return { ok: true, conflicted: [] };
      }
      this.seenConflict.add(key);
      this.merging.set(repo, true);
      this.pendingConflicts.set(repo, scripted);
      return { ok: false, conflicted: scripted };
    }
    return { ok: true, conflicted: [] };
  }

  async push(repo: string, branch: string): Promise<void> {
    this.calls.push({ op: "push", repo, arg: branch });
    this.maybeThrow("push");
  }

  async isMerging(repo: string): Promise<boolean> {
    this.calls.push({ op: "isMerging", repo });
    this.maybeThrowForRepo("isMerging", repo);
    return this.isMergingIn(repo);
  }

  async conflictedFiles(repo: string): Promise<string[]> {
    this.calls.push({ op: "conflictedFiles", repo });
    return this.pendingConflicts.get(repo) ?? this.opts.conflicted ?? [];
  }

  async mergeOrigin(repo: string): Promise<string | undefined> {
    this.calls.push({ op: "mergeOrigin", repo });
    return this.isMergingIn(repo) ? this.opts.mergeOrigin : undefined;
  }

  /** Helper for tests that drive resume: clear the mid-merge state everywhere. */
  resolveMerge(): void {
    this.merging.clear();
    this.pendingConflicts.clear();
    this.mergingByDefault = false;
  }
}
