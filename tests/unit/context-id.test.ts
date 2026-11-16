import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readHookStdin } from "../../src/cli/context-id.js";

describe("readHookStdin — bounded, so a hand-run command never hangs", () => {
  /** A pipe nobody ever writes to and nobody closes: an agent shell tool's fd 0. */
  function idleStdin(): Readable {
    return new PassThrough();
  }

  it("returns the payload when a hook actually writes one", async () => {
    const stdin = new PassThrough();
    stdin.end(JSON.stringify({ session_id: "conv-a" }));
    await expect(readHookStdin(stdin, 1000)).resolves.toContain("conv-a");
  });

  it("reads a multi-chunk payload to the end without truncating it", async () => {
    const stdin = new PassThrough();
    const payload = JSON.stringify({ session_id: "conv-a", filler: "x".repeat(4096) });
    stdin.write(payload.slice(0, 100));
    // The rest arrives well after the first-byte window: once data is known to
    // flow the read is unbounded, so this must NOT be cut short.
    setTimeout(() => stdin.end(payload.slice(100)), 260);
    await expect(readHookStdin(stdin, 40)).resolves.toBe(payload);
  });

  // The confirmed defect: the previous guard only covered `isTTY`, so any
  // non-TTY handle that stays open blocked until the caller timed out.
  it("gives up on an idle handle instead of blocking forever", async () => {
    const started = Date.now();
    await expect(readHookStdin(idleStdin(), 30)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("an immediately closed stdin (< /dev/null) is simply no payload", async () => {
    const stdin = new PassThrough();
    stdin.end();
    await expect(readHookStdin(stdin, 1000)).resolves.toBeUndefined();
  });

  it("a TTY is no payload without touching the stream at all", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true }) as unknown as Readable;
    await expect(readHookStdin(stdin, 1000)).resolves.toBeUndefined();
  });

  // The unit tests above pass whether or not the window timer is `unref`'d —
  // vitest keeps its own event loop alive, so they cannot see the real failure.
  // In the CLI an unref'd timer let the loop empty while this promise was still
  // pending: node exited 0 having written NOTHING (verified end-to-end with
  // `aw resume-summary < /dev/null`). So pin the property that actually matters.
  it("holds the event loop until the window elapses, so the CLI still emits", async () => {
    const timers: NodeJS.Timeout[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      const timer = realSetTimeout(fn, ms);
      timers.push(timer);
      return timer;
    }) as unknown as typeof globalThis.setTimeout);

    try {
      const pending = readHookStdin(new PassThrough(), 20);
      expect(timers.some((timer) => timer.hasRef())).toBe(true);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("every hook target reads stdin through the bounded window", () => {
  // `aw hook` used to read to EOF: run by hand from an agent's shell, whose fd 0
  // is an idle socket, it hung until the tool timed out. Every hook target has
  // to go through `readHookStdin`, never an unbounded read of `process.stdin`.
  it.each(["hook.ts"])("%s", (file) => {
    const source = readFileSync(join(__dirname, "../../src/cli/commands", file), "utf8");
    expect(source).toContain("readHookStdin(");
    expect(source).not.toMatch(/text\(process\.stdin\)/);
  });
});
