import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";

describe("NodeFileSystem.writeTextExclusive — atomic claim primitive", () => {
  let dir: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-exclusive-"));
    fs = new NodeFileSystem();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates file when path is fresh — { created: true }", async () => {
    const path = join(dir, "claim");
    const result = await fs.writeTextExclusive(path, "first");
    expect(result.created).toBe(true);
    expect(await readFile(path, "utf8")).toBe("first");
  });

  it("returns { created: false } when path already exists; does NOT overwrite", async () => {
    const path = join(dir, "claim");
    await fs.writeTextExclusive(path, "first");
    const second = await fs.writeTextExclusive(path, "second");
    expect(second.created).toBe(false);
    expect(await readFile(path, "utf8")).toBe("first");
  });

  it("5 parallel calls to the same path → exactly 1 created, 4 not created", async () => {
    const path = join(dir, "race");
    const calls = [1, 2, 3, 4, 5].map((n) => fs.writeTextExclusive(path, `pid-${n}`));
    const results = await Promise.all(calls);
    const created = results.filter((r) => r.created).length;
    const notCreated = results.filter((r) => !r.created).length;
    expect(created).toBe(1);
    expect(notCreated).toBe(4);
  });

  it("publica bytes PDF/PPTX sin decodificar y no sobrescribe el destino", async () => {
    const path = join(dir, "archivo.pdf");
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);
    expect(await fs.publishBytesExclusive(path, bytes)).toEqual({ created: true });
    expect(await fs.publishBytesExclusive(path, new Uint8Array([0x50, 0x4b, 0xfe]))).toEqual({
      created: false,
    });
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
  });
});

describe("NodeFileSystem.remove — idempotent unlink", () => {
  let dir: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-remove-"));
    fs = new NodeFileSystem();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("removes an existing file", async () => {
    const path = join(dir, "f");
    await fs.writeText(path, "x");
    await fs.remove(path);
    expect(await fs.exists(path)).toBe(false);
  });

  it("is silent on ENOENT (idempotent)", async () => {
    const path = join(dir, "missing");
    await expect(fs.remove(path)).resolves.toBeUndefined();
  });
});
