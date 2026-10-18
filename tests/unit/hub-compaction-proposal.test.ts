import { describe, expect, it } from "vitest";
import { inventoryHub } from "../../src/application/hub-compaction/inventory.js";
import { prepareCompaction } from "../../src/application/hub-compaction/proposal.js";
import { ORIGINAL, PLAN, compactionFixture, snapshot } from "../helpers/hub-compaction.js";

describe("hub compaction proposal", () => {
  it("seals exact view bytes and effects without writing; equivalent sets have the same digest", async () => {
    const f = await compactionFixture();
    try {
      const inventory = await inventoryHub(f.deps);
      const input = {
        version: 1,
        inventory_fingerprint: inventory.fingerprint,
        selection: [ORIGINAL],
        claims: [
          {
            topic: "Recovery",
            kind: "hypothesis",
            text: "Pending verification",
            references: [ORIGINAL, PLAN],
          },
          {
            topic: "Discrepancy",
            kind: "contradiction",
            text: "Both readings remain",
            references: [ORIGINAL, PLAN],
          },
        ],
      };
      const before = await snapshot(f.root);
      const proposal = await prepareCompaction(f.deps, input);
      const equivalent = await prepareCompaction(f.deps, {
        ...input,
        claims: [...input.claims]
          .reverse()
          .map((c) => ({ ...c, references: [...c.references].reverse() })),
      });
      expect(proposal.local.digest).toBe(equivalent.local.digest);
      expect(proposal.view).toContain("hypothesis");
      expect(proposal.view).toContain("contradiction");
      expect(proposal.view).toContain(ORIGINAL);
      expect(proposal.local.preview.map((e) => e.path)).toContain("docs/context/hub.md");
      expect(await snapshot(f.root)).toEqual(before);
      await f.write(ORIGINAL, "changed");
      await expect(prepareCompaction(f.deps, input)).rejects.toThrow(/Cambió el inventario/);
    } finally {
      await f.cleanup();
    }
  });

  it("rejects protected selection, absent references, untyped assertions and scope expansion", async () => {
    const f = await compactionFixture();
    try {
      const inventory = await inventoryHub(f.deps);
      const input = {
        version: 1,
        inventory_fingerprint: inventory.fingerprint,
        selection: [],
        claims: [{ topic: "History", kind: "fact", text: "Evidence retained", references: [PLAN] }],
      };
      await expect(prepareCompaction(f.deps, { ...input, selection: [PLAN] })).rejects.toThrow(
        /protegido/,
      );
      await expect(prepareCompaction(f.deps, { ...input, extra: "outside" })).rejects.toThrow(
        /fuera del contrato/,
      );
      await expect(
        prepareCompaction(f.deps, { ...input, selection: ["../outside"] }),
      ).rejects.toThrow(/Ruta relativa/);
      await expect(
        prepareCompaction(f.deps, {
          ...input,
          claims: [{ ...input.claims[0], references: ["docs/missing.md"] }],
        }),
      ).rejects.toThrow(/Referencia ausente/);
      await expect(
        prepareCompaction(f.deps, { ...input, claims: [{ ...input.claims[0], kind: "certain" }] }),
      ).rejects.toThrow(/desconocido/);
      const a = await prepareCompaction(f.deps, input);
      const b = await prepareCompaction(f.deps, {
        ...input,
        claims: [{ ...input.claims[0], text: "Other wording" }],
      });
      expect(a.local.digest).not.toBe(b.local.digest);
    } finally {
      await f.cleanup();
    }
  });
});
