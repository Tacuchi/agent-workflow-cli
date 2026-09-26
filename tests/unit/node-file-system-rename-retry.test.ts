import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AC-04 of spec 052: a transient hold on the destination — an antivirus or an
 * indexer on Windows — does not make the atomic write fail.
 *
 * The real `rename` runs underneath; the mock only decides how many times it is
 * refused first, which is the one thing a test on a POSIX runner cannot provoke.
 */

const holds = vi.hoisted(() => ({ remaining: 0, code: "EPERM", calls: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      holds.calls += 1;
      if (holds.remaining > 0) {
        holds.remaining -= 1;
        throw Object.assign(new Error(`${holds.code}: operation not permitted, rename`), {
          code: holds.code,
        });
      }
      return real.rename(from, to);
    },
  };
});

const { NodeFileSystem } = await import("../../src/adapters/node-file-system.js");

describe("escritura atómica — un bloqueo transitorio del renombrado no hace fallar", () => {
  let dir: string;
  const fs = new NodeFileSystem();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-rename-retry-"));
    holds.calls = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    it(`un ${code} que cede antes del tope deja el archivo escrito`, async () => {
      Object.assign(holds, { remaining: 3, code });
      const target = join(dir, ".flow-run.json");
      await fs.writeText(target, "nuevo\n");
      expect(await readFile(target, "utf8")).toBe("nuevo\n");
      expect(holds.calls).toBe(4);
      expect(await readdir(dir)).toEqual([".flow-run.json"]);
    });
  }

  it("un bloqueo que no cede propaga el error original después del tope y limpia el temporal", async () => {
    Object.assign(holds, { remaining: Number.POSITIVE_INFINITY, code: "EPERM" });
    const target = join(dir, ".flow-run.json");
    const started = Date.now();
    await expect(fs.writeText(target, "nuevo\n")).rejects.toMatchObject({ code: "EPERM" });
    // It waited out the cap, and not much longer: a command that fails here
    // must still answer within a couple of seconds.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(Date.now() - started).toBeLessThan(5_000);
    // 10 + 20 + 40 + … up to 2 s: a bounded number of tries, not a spin.
    expect(holds.calls).toBeGreaterThan(1);
    expect(holds.calls).toBeLessThan(12);
    expect(await readdir(dir)).toEqual([]);
  });

  it("un error que no es un bloqueo no se reintenta", async () => {
    Object.assign(holds, { remaining: 1, code: "ENOENT" });
    await expect(fs.writeText(join(dir, "x.json"), "x")).rejects.toMatchObject({ code: "ENOENT" });
    expect(holds.calls).toBe(1);
  });
});
