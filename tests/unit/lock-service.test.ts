import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCK_TTL_MS,
  LockBusyError,
  acquireLock,
  isExpired,
  parseLock,
} from "../../src/application/lock-service.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";

class FakeFs implements FileSystemPort {
  files = new Map<string, string>();
  dirs = new Map<string, DirEntry[]>();

  async readText(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async writeText(p: string, content: string): Promise<void> {
    this.files.set(p, content);
  }
  async writeTextExclusive(p: string, content: string): Promise<{ created: boolean }> {
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

describe("acquireLock — happy path", () => {
  it("claims an empty path, writes JSON {pid, ts}, returns handle", async () => {
    const fs = new FakeFs();
    const now = () => 1700000000000;
    const handle = await acquireLock(LOCK_PATH, fs, { pid: 42, now });

    expect(handle.path).toBe(LOCK_PATH);
    expect(handle.pid).toBe(42);
    expect(handle.ts).toBe(1700000000000);

    const raw = fs.files.get(LOCK_PATH) ?? "";
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(42);
    expect(parsed.ts).toBe(new Date(1700000000000).toISOString());
  });

  it("uses default TTL of 5 minutes when ttlMs not provided", () => {
    expect(DEFAULT_LOCK_TTL_MS).toBe(5 * 60 * 1000);
  });
});

describe("acquireLock — concurrent acquire", () => {
  it("fails with LockBusyError if a fresh lock exists", async () => {
    const fs = new FakeFs();
    const now1 = () => 1700000000000;
    await acquireLock(LOCK_PATH, fs, { pid: 100, now: now1 });

    const now2 = () => 1700000010000;
    await expect(acquireLock(LOCK_PATH, fs, { pid: 200, now: now2 })).rejects.toThrow(
      LockBusyError,
    );
  });

  it("LockBusyError exposes holder pid and timestamp", async () => {
    const fs = new FakeFs();
    await acquireLock(LOCK_PATH, fs, { pid: 100, now: () => 1700000000000 });

    try {
      await acquireLock(LOCK_PATH, fs, { pid: 200, now: () => 1700000010000 });
      expect.fail("expected LockBusyError");
    } catch (err) {
      expect(err).toBeInstanceOf(LockBusyError);
      expect((err as LockBusyError).holder.pid).toBe(100);
      expect((err as LockBusyError).holder.ts).toBe(new Date(1700000000000).toISOString());
    }
  });
});

describe("acquireLock — stale lock steal", () => {
  it("steals a lock older than TTL", async () => {
    const fs = new FakeFs();
    await acquireLock(LOCK_PATH, fs, { pid: 100, now: () => 1700000000000 });

    const sixMinutesLater = 1700000000000 + 6 * 60 * 1000;
    const handle = await acquireLock(LOCK_PATH, fs, {
      pid: 200,
      now: () => sixMinutesLater,
    });

    expect(handle.pid).toBe(200);
    const raw = fs.files.get(LOCK_PATH) ?? "";
    expect(JSON.parse(raw).pid).toBe(200);
  });

  it("does not steal a lock at exactly TTL boundary", async () => {
    const fs = new FakeFs();
    await acquireLock(LOCK_PATH, fs, { pid: 100, now: () => 1700000000000 });

    const exactlyTtl = 1700000000000 + DEFAULT_LOCK_TTL_MS;
    await expect(acquireLock(LOCK_PATH, fs, { pid: 200, now: () => exactlyTtl })).rejects.toThrow(
      LockBusyError,
    );
  });
});

describe("acquireLock — corrupt lock", () => {
  it("steals lock with malformed JSON", async () => {
    const fs = new FakeFs();
    fs.files.set(LOCK_PATH, "not valid json {");
    const handle = await acquireLock(LOCK_PATH, fs, {
      pid: 200,
      now: () => 1700000000000,
    });
    expect(handle.pid).toBe(200);
  });

  it("steals lock with empty content (release marker)", async () => {
    const fs = new FakeFs();
    fs.files.set(LOCK_PATH, "");
    const handle = await acquireLock(LOCK_PATH, fs, {
      pid: 200,
      now: () => 1700000000000,
    });
    expect(handle.pid).toBe(200);
  });

  it("steals lock with structurally invalid JSON (missing pid)", async () => {
    const fs = new FakeFs();
    fs.files.set(LOCK_PATH, JSON.stringify({ ts: new Date().toISOString() }));
    const handle = await acquireLock(LOCK_PATH, fs, {
      pid: 200,
      now: () => 1700000000000,
    });
    expect(handle.pid).toBe(200);
  });
});

describe("release", () => {
  it("writes empty marker enabling next acquire", async () => {
    const fs = new FakeFs();
    const handle = await acquireLock(LOCK_PATH, fs, {
      pid: 100,
      now: () => 1700000000000,
    });
    await handle.release();
    expect(fs.files.get(LOCK_PATH)).toBe("");

    const next = await acquireLock(LOCK_PATH, fs, {
      pid: 200,
      now: () => 1700000010000,
    });
    expect(next.pid).toBe(200);
  });

  it("is idempotent on double release", async () => {
    const fs = new FakeFs();
    const handle = await acquireLock(LOCK_PATH, fs, {
      pid: 100,
      now: () => 1700000000000,
    });
    await handle.release();
    await expect(handle.release()).resolves.toBeUndefined();
  });
});

describe("parseLock", () => {
  it("returns null for empty content", () => {
    expect(parseLock("")).toBeNull();
  });
  it("returns null for invalid JSON", () => {
    expect(parseLock("not valid")).toBeNull();
  });
  it("returns null when pid is missing", () => {
    expect(parseLock(JSON.stringify({ ts: "x" }))).toBeNull();
  });
  it("returns null when ts is missing", () => {
    expect(parseLock(JSON.stringify({ pid: 1 }))).toBeNull();
  });
  it("returns content when valid", () => {
    const result = parseLock(JSON.stringify({ pid: 42, ts: "2026-01-01T00:00:00.000Z" }));
    expect(result).toEqual({ pid: 42, ts: "2026-01-01T00:00:00.000Z" });
  });
});

describe("isExpired", () => {
  it("returns false for fresh lock", () => {
    const lock = { pid: 1, ts: new Date(1700000000000).toISOString() };
    expect(isExpired(lock, 1700000000000 + 1000, 5 * 60 * 1000)).toBe(false);
  });
  it("returns true for stale lock", () => {
    const lock = { pid: 1, ts: new Date(1700000000000).toISOString() };
    expect(isExpired(lock, 1700000000000 + 6 * 60 * 1000, 5 * 60 * 1000)).toBe(true);
  });
  it("returns false at exactly TTL", () => {
    const lock = { pid: 1, ts: new Date(1700000000000).toISOString() };
    expect(isExpired(lock, 1700000000000 + 5 * 60 * 1000, 5 * 60 * 1000)).toBe(false);
  });
  it("returns true for unparseable timestamp", () => {
    const lock = { pid: 1, ts: "not-a-date" };
    expect(isExpired(lock, 1700000000000, 5 * 60 * 1000)).toBe(true);
  });
});
