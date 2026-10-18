import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgv } from "../../src/cli/parser.js";
import { ORIGINAL, PLAN, compactionFixture, snapshot } from "../helpers/hub-compaction.js";

describe("hub compact CLI journey", () => {
  it("carries value flags through argv and runs inventory, approval, inspect, restore and repetition", async () => {
    const f = await compactionFixture();
    const home = await mkdtemp(join(tmpdir(), "aw-compaction-home-"));
    const cli = resolve(__dirname, "../../dist/cli/main.js");
    const invoke = (args: string[], input?: unknown) =>
      JSON.parse(
        execFileSync(process.execPath, [cli, "--hub", f.root, "hub-compact", ...args, "--json"], {
          encoding: "utf8",
          env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" },
          ...(input !== undefined ? { input: JSON.stringify(input) } : {}),
        }),
      );
    try {
      const parsed = parseArgv(["hub-compact", "apply", "--input-json", "-", "--approval", "seal"]);
      expect(parsed.rest).toEqual(["apply"]);
      expect(parsed.values.get("input-json")).toBe("-");
      expect(parsed.values.get("approval")).toBe("seal");
      const original = await readFile(join(f.root, ORIGINAL));
      const before = await snapshot(f.root);
      const inventory = invoke(["inventory"]);
      expect(await snapshot(f.root)).toEqual(before);
      const input = {
        version: 1,
        inventory_fingerprint: inventory.fingerprint,
        claims: [
          {
            topic: "History",
            kind: "pending-work",
            text: "Read evidence when needed",
            references: [PLAN],
          },
        ],
        selection: [ORIGINAL],
      };
      const proposal = invoke(["prepare", "--input-json", "-"], input);
      expect(await snapshot(f.root)).toEqual(before);
      expect(proposal.local.digest).toMatch(/^[a-f0-9]{64}$/);
      const applied = invoke(
        ["apply", "--input-json", "-", "--approval", proposal.local.digest],
        input,
      );
      expect(applied.status).toBe("complete");
      expect(applied.context.tokens).toBeNull();
      const compacted = await snapshot(f.root);
      const added = Object.keys(compacted).filter((path) => !(path in before));
      expect(
        added.every(
          (path) => path === "docs/context/hub.md" || path.startsWith(`${proposal.catalog}/`),
        ),
      ).toBe(true);
      const inspected = invoke(["inspect", proposal.id, "--path", ORIGINAL]);
      expect(inspected.originals[0].content_base64).toBe(original.toString("base64"));
      const restoration = invoke(["restore", proposal.id, "--path", ORIGINAL]);
      expect(await snapshot(f.root)).toEqual(compacted);
      invoke(["restore", proposal.id, "--path", ORIGINAL, "--approval", restoration.digest]);
      expect(await readFile(join(f.root, ORIGINAL))).toEqual(original);
      expect(
        invoke(["apply", "--input-json", "-", "--approval", proposal.local.digest], input)
          .already_applied,
      ).toBe(true);
      expect(invoke(["inventory"]).fingerprint).not.toBe(inventory.fingerprint);
    } finally {
      await f.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });
});
