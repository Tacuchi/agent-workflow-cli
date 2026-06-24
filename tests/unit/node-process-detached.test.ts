import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeProcess } from "../../src/adapters/node-process.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(50);
  }
  return pred();
}

describe("NodeProcess detached lifecycle", () => {
  let dir: string;
  let proc: NodeProcess;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "node-proc-detached-"));
    proc = new NodeProcess();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("spawns detached, writes to the log, reports alive, and killTree stops it", async () => {
    const logPath = join(dir, "run.log");
    const { pid } = await proc.spawnDetached(
      process.execPath,
      ["-e", "console.log('started'); setInterval(() => {}, 1000);"],
      { cwd: dir, logPath },
    );

    expect(pid).toBeGreaterThan(0);
    expect(await proc.isAlive(pid)).toBe(true);

    // Output is redirected to the log.
    const logged = await waitUntil(async () => {
      try {
        return readFileSync(logPath, "utf-8").includes("started");
      } catch {
        return false;
      }
    }, 3000);
    expect(logged).toBe(true);

    await proc.killTree(pid);
    const dead = await waitUntil(async () => !(await proc.isAlive(pid)), 5000);
    expect(dead).toBe(true);
  }, 15000);

  it("isAlive is false for an obviously dead pid", async () => {
    // PID 1 is init/launchd (not killable by us); a huge pid is virtually never live.
    expect(await proc.isAlive(2147483646)).toBe(false);
    expect(await proc.isAlive(0)).toBe(false);
    expect(await proc.isAlive(-5)).toBe(false);
  });

  it("killTree on a non-existent pid resolves quietly", async () => {
    await expect(proc.killTree(2147483646)).resolves.toBeUndefined();
  });
});
