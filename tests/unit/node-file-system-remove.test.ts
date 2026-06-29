import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";

describe("NodeFileSystem.remove", () => {
  const fs = new NodeFileSystem();
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-rm-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("removes a single file", async () => {
    const f = join(dir, "a.txt");
    await writeFile(f, "x");
    await fs.remove(f);
    expect(await fs.exists(f)).toBe(false);
  });

  it("removes a directory recursively, with its contents", async () => {
    const sub = join(dir, "tools", "core");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "launch.json"), "{}");
    await writeFile(join(sub, "run.sh"), "echo");
    await fs.remove(join(dir, "tools", "core"));
    expect(await fs.exists(join(dir, "tools", "core"))).toBe(false);
  });

  it("is idempotent: removing a missing file or directory does not throw", async () => {
    await fs.remove(join(dir, "nope"));
    await fs.remove(join(dir, "nope-dir", "deep"));
    expect(await fs.exists(join(dir, "nope"))).toBe(false);
  });
});
