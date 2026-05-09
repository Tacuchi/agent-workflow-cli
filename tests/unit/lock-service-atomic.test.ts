import { describe, expect, it } from "vitest";
import { LockBusyError, acquireLock } from "../../src/application/lock-service.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";

/**
 * AtomicFakeFs simulates a race in writeTextExclusive: the first call returns
 * { created: false } (as if another process beat us to the create), and from
 * then on it behaves normally.
 */
class AtomicFakeFs implements FileSystemPort {
  files = new Map<string, string>();
  dirs = new Map<string, DirEntry[]>();
  exclusiveCallCount = 0;
  /** Set to a content string to seed the file as if held by another process. */
  preSeeded?: string;

  async readText(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async writeText(p: string, content: string): Promise<void> {
    this.files.set(p, content);
  }
  async writeTextExclusive(p: string, content: string): Promise<{ created: boolean }> {
    this.exclusiveCallCount++;
    if (this.preSeeded !== undefined && this.exclusiveCallCount === 1) {
      // Simulate another process beating us in the atomic claim.
      this.files.set(p, this.preSeeded);
      this.preSeeded = undefined;
      return { created: false };
    }
    if (this.files.has(p)) return { created: false };
    this.files.set(p, content);
    return { created: true };
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
  }
  async exists(p: string): Promise<boolean> {
    return this.files.has(p) || this.dirs.has(p);
  }
  async list(p: string): Promise<DirEntry[]> {
    const v = this.dirs.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async mkdirp(p: string): Promise<void> {
    if (!this.dirs.has(p)) this.dirs.set(p, []);
  }
  async stat(p: string): Promise<FileStat> {
    if (this.files.has(p)) return { mtime: new Date(0), size: 0, type: "file" };
    if (this.dirs.has(p)) return { mtime: new Date(0), size: 0, type: "dir" };
    throw new Error(`ENOENT: ${p}`);
  }
}

const LOCK_PATH = "/cwd/.workflow/.lock";

describe("acquireLock — atomic race semantics (R2 atomic claim fix)", () => {
  it("uses writeTextExclusive (not exists+writeText) for the claim primitive", async () => {
    const fs = new AtomicFakeFs();
    await acquireLock(LOCK_PATH, fs, { pid: 100, now: () => 1700000000000 });
    expect(fs.exclusiveCallCount).toBe(1);
  });

  it("when EEXIST race fires with active holder → LockBusyError (no double-claim)", async () => {
    const fs = new AtomicFakeFs();
    // Seed the lock as if another process just won the race with a fresh claim.
    fs.preSeeded = JSON.stringify({
      pid: 999,
      ts: new Date(1700000000000).toISOString(),
    });
    await expect(
      acquireLock(LOCK_PATH, fs, { pid: 100, now: () => 1700000001000 }),
    ).rejects.toThrow(LockBusyError);
    expect(fs.exclusiveCallCount).toBe(1);
    // Existing holder content preserved (not overwritten)
    const raw = fs.files.get(LOCK_PATH) ?? "";
    expect(JSON.parse(raw).pid).toBe(999);
  });

  it("when EEXIST race fires with stale holder → reclaims after retry", async () => {
    const fs = new AtomicFakeFs();
    // Seed with stale lock (10 minutes old).
    fs.preSeeded = JSON.stringify({
      pid: 999,
      ts: new Date(1700000000000 - 10 * 60 * 1000).toISOString(),
    });
    const handle = await acquireLock(LOCK_PATH, fs, { pid: 100, now: () => 1700000000000 });
    expect(handle.pid).toBe(100);
    expect(fs.exclusiveCallCount).toBeGreaterThanOrEqual(2);
    // Final content should be ours (pid 100).
    const raw = fs.files.get(LOCK_PATH) ?? "";
    expect(JSON.parse(raw).pid).toBe(100);
  });

  it("when EEXIST race fires with release marker (empty) → reclaims after retry", async () => {
    const fs = new AtomicFakeFs();
    fs.preSeeded = ""; // release marker
    const handle = await acquireLock(LOCK_PATH, fs, { pid: 100, now: () => 1700000000000 });
    expect(handle.pid).toBe(100);
    const raw = fs.files.get(LOCK_PATH) ?? "";
    expect(JSON.parse(raw).pid).toBe(100);
  });
});
