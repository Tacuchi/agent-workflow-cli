// Spec 066, AC-14 y D12: `hub-compact` opera sólo sobre specs y planes de docs/;
// no lee ni escribe sesiones. El hub de prueba deja `.workflow/sessions/`
// ilegible y el inventario no la abre.

import { chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inventoryHub } from "../../src/application/hub-compaction/inventory.js";
import { LIVE, ORIGINAL, compactionFixture, snapshot } from "../helpers/hub-compaction.js";

describe("hub-compact sólo sobre docs/", () => {
  let f: Awaited<ReturnType<typeof compactionFixture>>;
  beforeEach(async () => {
    f = await compactionFixture();
    await f.write(".workflow/sessions/001-viejo-plan-exec/SESSION.md", "# Session\n");
    await chmod(join(f.root, ".workflow/sessions"), 0o000);
  });
  afterEach(async () => {
    await chmod(join(f.root, ".workflow/sessions"), 0o755);
    await f.cleanup();
  });

  it("inventaría sólo docs/, sin escribir y sin abrir la carpeta de sesiones", async () => {
    const before = await snapshot(f.root, "docs");
    const inventory = await inventoryHub(f.deps);
    expect(await snapshot(f.root, "docs")).toEqual(before);
    expect(inventory.entries.every((entry) => entry.path.startsWith("docs/"))).toBe(true);
    expect(inventory.entries.find((e) => e.path === ORIGINAL)?.disposition).toBe("eligible");
    expect(inventory.entries.find((e) => e.path === LIVE)?.disposition).toBe("protected");
    expect(inventory.fingerprint).toBe((await inventoryHub(f.deps)).fingerprint);
  });

  it("un plan abandoned es historia; uno ready no", async () => {
    const abandoned = "docs/plans/003-plan-descartado.md";
    await f.write(
      abandoned,
      "# Plan 003\n> Standalone: x\n> Estado: abandoned\n\n## Tasks\n- [ ] T1\n",
    );
    const entries = (await inventoryHub(f.deps)).entries;
    expect(entries.find((e) => e.path === abandoned)?.disposition).toBe("eligible");
    expect(entries.find((e) => e.path === LIVE)?.disposition).toBe("protected");
  });

  it("una spec es historia sólo cuando todos sus planes lo son", async () => {
    const spec = "docs/specs/004-spec-cupones.md";
    await f.write(spec, "---\nstatus: ready-for-plan\n---\n\n# Spec 004 — cupones\n");
    const done = "docs/plans/005-plan-cupones.md";
    await f.write(
      done,
      `# Plan 005\n> Derived from ${spec}\n> Estado: done\n\n## Tasks\n- [x] T1\n`,
    );
    expect((await inventoryHub(f.deps)).entries.find((e) => e.path === spec)?.disposition).toBe(
      "eligible",
    );
    await f.write(
      "docs/plans/006-plan-cupones-app.md",
      `# Plan 006\n> Derived from ${spec}\n> Estado: ready\n\n## Tasks\n- [ ] T1\n`,
    );
    const entry = (await inventoryHub(f.deps)).entries.find((e) => e.path === spec);
    expect(entry?.disposition).toBe("protected");
  });

  it("un documento vivo que nombra la historia la mantiene en sitio", async () => {
    await f.write("docs/research/notas.md", `Ver ${ORIGINAL}`);
    const entry = (await inventoryHub(f.deps)).entries.find((e) => e.path === ORIGINAL);
    expect(entry?.disposition).toBe("protected");
    expect(entry?.reason).toContain("Referencia manual");
  });

  it("excluye configuración sensible y enlaces dentro de docs/", async () => {
    await f.write("docs/.env", "PRIVATE_FIXTURE=do-not-read");
    await symlink("/etc", join(f.root, "docs/externo"));
    const inventory = await inventoryHub(f.deps);
    for (const path of ["docs/.env", "docs/externo"]) {
      const entry = inventory.entries.find((e) => e.path === path);
      expect(entry?.disposition).toBe("excluded");
      expect(entry?.sha256).toBeNull();
    }
  });
});
