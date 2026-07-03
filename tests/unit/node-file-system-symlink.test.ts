import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";

describe("NodeFileSystem — symlink/lstat (T3.1)", () => {
  let root: string;
  const fs = new NodeFileSystem();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-fs-symlink-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("symlink enlaza un directorio: leer a través del link ve el contenido real", async () => {
    const target = join(root, "canonical");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "hola", "utf8");

    const link = join(root, "replica");
    await fs.symlink(target, link);

    expect(await readFile(join(link, "SKILL.md"), "utf8")).toBe("hola");
  });

  it("lstat distingue link de dir real y devuelve null si no existe", async () => {
    const target = join(root, "canonical");
    await mkdir(target, { recursive: true });
    const link = join(root, "replica");
    await fs.symlink(target, link);

    expect(await fs.lstat(join(root, "nope"))).toBeNull();
    expect(await fs.lstat(target)).toEqual({ type: "dir", isSymlink: false });
    expect((await fs.lstat(link))?.isSymlink).toBe(true);
  });

  it("remove sobre un link borra el link, nunca el target", async () => {
    const target = join(root, "canonical");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "hola", "utf8");
    const link = join(root, "replica");
    await fs.symlink(target, link);

    await fs.remove(link);

    expect(await fs.lstat(link)).toBeNull();
    expect(existsSync(join(target, "SKILL.md"))).toBe(true);
  });

  it("symlink falla si el path ya existe (el caller decide el fallback)", async () => {
    const target = join(root, "canonical");
    await mkdir(target, { recursive: true });
    const link = join(root, "replica");
    await mkdir(link, { recursive: true });

    await expect(fs.symlink(target, link)).rejects.toThrow();
  });
});
