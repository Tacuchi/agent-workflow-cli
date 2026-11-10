import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCompaction } from "../../src/application/hub-compaction/apply.js";
import { inspectCompaction } from "../../src/application/hub-compaction/inspect.js";
import { applyRestore, prepareRestore } from "../../src/application/hub-compaction/restore.js";
import {
  ORIGINAL,
  compactionFixture,
  prepareFixture,
  snapshot,
} from "../helpers/hub-compaction.js";

describe("recoverable hub archives", () => {
  let f: Awaited<ReturnType<typeof compactionFixture>>;
  beforeEach(async () => {
    f = await compactionFixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await f.cleanup();
  });

  it("round-trips the bytes of every archived document of docs/", async () => {
    const binary = "docs/plans/003-plan-otro.md";
    await f.write(
      binary,
      `# Plan 003 — otro\n> Standalone: fixture\n> Estado: abandoned\n\n## Tasks\n- [ ] T1\n${"ñ·€ ".repeat(3000)}\n`,
    );
    const originals = await snapshot(f.root);
    const p = await prepareFixture(f, [ORIGINAL, binary]);
    const applied = await applyCompaction(f.deps, p.request, p.local.digest);
    expect(applied.status).toBe("complete");
    expect(await f.deps.fs.exists(join(f.root, ORIGINAL))).toBe(false);
    const inspected = await inspectCompaction(f.deps, p.id, binary);
    expect(inspected.originals[0]?.integrity).toBe("verified");
    expect(inspected.originals[0]).toHaveProperty("content_base64", originals[binary]);
    const restore = await prepareRestore(f.deps, p.id);
    await applyRestore(f.deps, p.id, restore.digest);
    const after = await snapshot(f.root);
    for (const path of [ORIGINAL, binary]) expect(after[path]).toBe(originals[path]);
    expect((await applyRestore(f.deps, p.id, restore.digest)).already_applied).toBe(true);
    expect((await applyCompaction(f.deps, p.request, p.local.digest)).already_applied).toBe(true);
    expect(applied.storage.catalog_bytes).toBeGreaterThan(0);
    expect(applied.storage.net_saved_bytes).toBe(
      applied.storage.removed_bytes -
        applied.storage.catalog_bytes -
        applied.storage.view_bytes +
        applied.storage.previous_view_bytes,
    );
  });

  it("requires the exact approval and refuses stale sources before writing", async () => {
    const p = await prepareFixture(f);
    const before = await snapshot(f.root);
    await expect(applyCompaction(f.deps, p.request, "")).rejects.toThrow(/aprobar/);
    await expect(applyCompaction(f.deps, p.request, "wrong")).rejects.toThrow(/digest/);
    expect(await snapshot(f.root)).toEqual(before);
    await f.write(ORIGINAL, "later content");
    const stale = await snapshot(f.root);
    await expect(applyCompaction(f.deps, p.request, p.local.digest)).rejects.toThrow(/inventario/);
    expect(await snapshot(f.root)).toEqual(stale);
  });

  it("keeps originals when compression runs out of space and recovers the same approved operation", async () => {
    const p = await prepareFixture(f);
    const expected = await readFile(join(f.root, ORIGINAL));
    vi.spyOn(f.deps.archive, "compress").mockRejectedValueOnce(
      Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }),
    );
    await expect(applyCompaction(f.deps, p.request, p.local.digest)).rejects.toThrow("ENOSPC");
    expect(await readFile(join(f.root, ORIGINAL))).toEqual(expected);
    expect((await inspectCompaction(f.deps, p.id)).complete).toBe(false);
    expect((await applyCompaction(f.deps, p.request, p.local.digest)).status).toBe("complete");
  });

  it.each(["after-view", "before-retirement", "after-retirement"])(
    "recovers %s without repeating completed effects",
    async (stage) => {
      const p = await prepareFixture(f);
      let injected = false;
      const write = f.deps.fs.writeText.bind(f.deps.fs);
      const rename = f.deps.fs.rename.bind(f.deps.fs);
      const remove = f.deps.fs.remove.bind(f.deps.fs);
      vi.spyOn(f.deps.fs, "writeText").mockImplementation(async (path, content) => {
        if (
          stage === "after-view" &&
          !injected &&
          path.endsWith("manifest.json") &&
          JSON.parse(content).view_published === true
        ) {
          injected = true;
          throw new Error("interrupted after view");
        }
        await write(path, content);
      });
      vi.spyOn(f.deps.fs, "rename").mockImplementation(async (from, to) => {
        if (stage === "before-retirement" && !injected && from.endsWith("001-plan-history.md")) {
          injected = true;
          throw new Error("interrupted before retirement");
        }
        await rename(from, to);
      });
      vi.spyOn(f.deps.fs, "remove").mockImplementation(async (path) => {
        await remove(path);
        if (stage === "after-retirement" && !injected && path.includes("/recovery/")) {
          injected = true;
          throw new Error("interrupted after retirement");
        }
      });
      await expect(applyCompaction(f.deps, p.request, p.local.digest)).rejects.toThrow(
        /interrupted/,
      );
      expect(injected).toBe(true);
      expect((await inspectCompaction(f.deps, p.id)).complete).toBe(false);
      const result = await applyCompaction(f.deps, p.request, p.local.digest);
      expect(result.status).toBe("complete");
      expect(result.entries[0]?.state).toBe("archived");
      expect((await inspectCompaction(f.deps, p.id)).integrity).toBe("verified");
    },
  );

  it("reports corrupt or absent gzip explicitly and never overwrites later originals", async () => {
    const p = await prepareFixture(f);
    await applyCompaction(f.deps, p.request, p.local.digest);
    const restore = await prepareRestore(f.deps, p.id);
    await f.write(ORIGINAL, "later original");
    const before = await snapshot(f.root);
    await expect(applyRestore(f.deps, p.id, restore.digest)).rejects.toThrow();
    expect(await snapshot(f.root)).toEqual(before);
    await rm(join(f.root, ORIGINAL));
    const archive = p.originals[0]?.archive;
    if (!archive) throw new Error("fixture archive absent");
    await writeFile(join(f.root, archive), "corrupt gzip");
    expect((await inspectCompaction(f.deps, p.id)).integrity).toBe("unavailable-or-corrupt");
    await expect(prepareRestore(f.deps, p.id)).rejects.toThrow();
    await expect(applyCompaction(f.deps, p.request, p.local.digest)).rejects.toThrow();
    await rm(join(f.root, archive));
    expect((await inspectCompaction(f.deps, p.id)).originals[0]?.integrity).toBe("missing");
  });

  it("preserves a concurrent change in the recovery area and exposes its location", async () => {
    const p = await prepareFixture(f);
    const rename = f.deps.fs.rename.bind(f.deps.fs);
    vi.spyOn(f.deps.fs, "rename").mockImplementationOnce(async (from, to) => {
      await writeFile(from, "concurrent bytes");
      await rename(from, to);
    });
    await expect(applyCompaction(f.deps, p.request, p.local.digest)).rejects.toThrow(
      /Cambio concurrente conservado/,
    );
    const inspected = await inspectCompaction(f.deps, p.id);
    const recovery = inspected.originals[0]?.recovery_path;
    expect(recovery).toBeTruthy();
    if (recovery) expect(await readFile(recovery, "utf8")).toBe("concurrent bytes");
    expect(inspected.complete).toBe(false);
  });

  it("refuses catalog symlinks and incompatible manifests without touching originals", async () => {
    const p = await prepareFixture(f);
    await f.deps.fs.mkdirp(join(f.root, ".workflow/compactions"));
    await symlink("/etc", join(f.root, p.catalog));
    await expect(applyCompaction(f.deps, p.request, p.local.digest)).rejects.toThrow(
      /Enlace protegido/,
    );
    expect(await f.deps.fs.exists(join(f.root, ORIGINAL))).toBe(true);
  });

  it("resumes an interrupted restore after exclusive publication without a second overwrite", async () => {
    const p = await prepareFixture(f);
    await applyCompaction(f.deps, p.request, p.local.digest);
    const restore = await prepareRestore(f.deps, p.id);
    const publish = f.deps.archive.restore.bind(f.deps.archive);
    vi.spyOn(f.deps.archive, "restore").mockImplementationOnce(async (...args) => {
      await publish(...args);
      throw new Error("interrupted restoration receipt");
    });
    await expect(applyRestore(f.deps, p.id, restore.digest)).rejects.toThrow(
      /interrupted restoration/,
    );
    const before = await readFile(join(f.root, ORIGINAL));
    expect((await applyRestore(f.deps, p.id, restore.digest)).status).toBe("complete");
    expect(await readFile(join(f.root, ORIGINAL))).toEqual(before);
  });
});
