import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";

describe("NodeFileSystem.appendText", () => {
  const fs = new NodeFileSystem();
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-append-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the file (and parent dirs) on first append", async () => {
    const f = join(dir, "logs", "day.log");
    await fs.appendText(f, "line 1\n");
    expect(await readFile(f, "utf8")).toBe("line 1\n");
  });

  it("appends to existing content without truncating", async () => {
    const f = join(dir, "day.log");
    await fs.appendText(f, "line 1\n");
    await fs.appendText(f, "line 2\n");
    expect(await readFile(f, "utf8")).toBe("line 1\nline 2\n");
  });
});
