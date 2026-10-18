import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inventoryHub } from "../../src/application/hub-compaction/inventory.js";
import { preservedBaseline, sealCustody } from "../../src/domain/session/custody.js";
import { ORIGINAL, PLAN, SESSION, compactionFixture, snapshot } from "../helpers/hub-compaction.js";

describe("hub compaction inventory", () => {
  let fixture: Awaited<ReturnType<typeof compactionFixture>>;
  beforeEach(async () => {
    fixture = await compactionFixture();
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  it("inventories exact bytes without writes or consuming correlatives", async () => {
    const before = await snapshot(fixture.root);
    const inventory = await inventoryHub(fixture.deps);
    expect(await snapshot(fixture.root)).toEqual(before);
    expect(inventory.entries.find((e) => e.path === ORIGINAL)?.disposition).toBe("eligible");
    expect(inventory.entries.find((e) => e.path === PLAN)?.disposition).toBe("protected");
    expect(inventory.entries.find((e) => e.path.endsWith(".custody.json"))?.disposition).toBe(
      "protected",
    );
    expect(inventory.context.tokens).toBeNull();
    expect(inventory.fingerprint).toBe((await inventoryHub(fixture.deps)).fingerprint);
  });

  it("does not confuse closure with converged work or missing custody", async () => {
    await fixture.write(PLAN, "# Plan 001\n> Estado: open\n## Tasks\n- [ ] T1\n");
    expect(
      (await inventoryHub(fixture.deps)).entries.find((e) => e.path === ORIGINAL)?.disposition,
    ).toBe("protected");
    await rm(join(fixture.root, SESSION, ".custody.json"));
    expect(
      (await inventoryHub(fixture.deps)).entries.find((e) => e.path === ORIGINAL)?.disposition,
    ).toBe("protected");
  });

  it("protects evidence with manual references or live consumers", async () => {
    await fixture.write("docs/research/notes.md", `See ${ORIGINAL}`);
    const entry = (await inventoryHub(fixture.deps)).entries.find((e) => e.path === ORIGINAL);
    expect(entry?.disposition).toBe("protected");
    expect(entry?.reason).toContain("Referencia manual");
  });

  it("protects a converged closed session when another live session shares its provenance", async () => {
    const folder = ".workflow/sessions/002-live-plan-exec";
    await fixture.write(`${folder}/SESSION.md`, "# Session\n## Objective\nContinue shared work\n");
    await fixture.write(
      `${folder}/.custody.json`,
      JSON.stringify(
        sealCustody({
          subject: { kind: "session", key: "002-live-plan-exec" },
          subjectPath: join(fixture.root, folder),
          parents: [{ kind: "plan", key: "001" }],
          created: "2026-10-18",
          artifacts: [
            {
              path: PLAN,
              role: "input",
              before: preservedBaseline(await fixture.deps.fs.readText(join(fixture.root, PLAN))),
            },
          ],
        }),
      ),
    );
    expect(
      (await inventoryHub(fixture.deps)).entries.find((e) => e.path === ORIGINAL)?.disposition,
    ).toBe("protected");
  });

  it("excludes sensitive configuration, nested repositories and symlinks", async () => {
    await fixture.write(".env", "PRIVATE_FIXTURE=do-not-read");
    await fixture.write("source/.git/HEAD", "ref: refs/heads/main");
    await fixture.write("source/other.txt", "external repository");
    await symlink("/etc", join(fixture.root, "external"));
    const before = await snapshot(fixture.root);
    const inventory = await inventoryHub(fixture.deps);
    for (const path of [".env", "source", "external"]) {
      const entry = inventory.entries.find((e) => e.path === path);
      expect(entry?.disposition).toBe("excluded");
      expect(entry?.sha256).toBeNull();
    }
    expect(await snapshot(fixture.root)).toEqual(before);
  });
});
