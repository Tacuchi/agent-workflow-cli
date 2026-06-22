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
  /** When true, `isDirty` returns true (uncommitted-changes precondition). */
  dirty?: boolean;
  /** Git op name (`checkout`/`pull`/`push`/`merge`) that throws when invoked. */
  throwOn?: "checkout" | "pull" | "push" | "merge";
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
 */
export class RecordingGit implements GitPort {
  public readonly calls: GitCall[] = [];
  private branch: string;
  private merging: boolean;
  private pendingConflict: string[];
  private readonly conflicts: Record<string, string[]>;
  private readonly seenConflict = new Set<string>();

  constructor(private readonly opts: RecordingGitOptions = {}) {
    this.branch = opts.currentBranch ?? "main";
    this.conflicts = opts.conflicts ?? {};
    this.merging = opts.merging ?? false;
    this.pendingConflict = opts.conflicted ?? [];
  }

  async isGitRepo(_repo: string): Promise<boolean> {
    return this.opts.isRepo ?? true;
  }

  async currentBranch(repo: string): Promise<string | undefined> {
    this.calls.push({ op: "currentBranch", repo });
    return this.branch;
  }

  async isDirty(_repo: string): Promise<boolean> {
    return this.opts.dirty ?? false;
  }

  async changedFiles(_repo: string): Promise<string[]> {
    return this.opts.changed ?? [];
  }

  async log(_args: string[], _repo: string): Promise<string> {
    return "";
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
    this.branch = branch;
  }

  async pull(repo: string): Promise<void> {
    this.calls.push({ op: "pull", repo, arg: this.branch });
    this.maybeThrow("pull");
  }

  async merge(repo: string, fromBranch: string): Promise<MergeResult> {
    this.calls.push({ op: "merge", repo, arg: fromBranch });
    this.maybeThrow("merge");
    const scripted = this.conflicts[fromBranch];
    if (scripted && scripted.length > 0) {
      const alreadySeen = this.seenConflict.has(fromBranch);
      if (alreadySeen && this.opts.resolveAfterFirstConflict) {
        // Conflict resolved by the user; merge now completes cleanly.
        this.merging = false;
        this.pendingConflict = [];
        return { ok: true, conflicted: [] };
      }
      this.seenConflict.add(fromBranch);
      this.merging = true;
      this.pendingConflict = scripted;
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
    return this.merging;
  }

  async conflictedFiles(repo: string): Promise<string[]> {
    this.calls.push({ op: "conflictedFiles", repo });
    return this.pendingConflict;
  }

  async mergeOrigin(repo: string): Promise<string | undefined> {
    this.calls.push({ op: "mergeOrigin", repo });
    return this.merging ? this.opts.mergeOrigin : undefined;
  }

  /** Helper for tests that drive resume: clear the mid-merge state. */
  resolveMerge(): void {
    this.merging = false;
    this.pendingConflict = [];
  }
}
