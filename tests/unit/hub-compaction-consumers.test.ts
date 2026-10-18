import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCompaction } from "../../src/application/hub-compaction/apply.js";
import { readSessionArtifacts } from "../../src/application/release-data/artifacts.js";
import { listSessionsForRelease } from "../../src/application/release-data/sessions.js";
import { runSessionLoad } from "../../src/application/session-load-service.js";
import {
  ORIGINAL,
  SESSION,
  compactionFixture,
  prepareFixture,
  snapshot,
} from "../helpers/hub-compaction.js";

describe("consumers of compacted session evidence", () => {
  it("preserves session identity, state and canonical corpus, exposing archived original queries without writes", async () => {
    const f = await compactionFixture();
    try {
      await f.write(`${SESSION}/CONCLUSIONS.md`, "# Conclusions\nDemonstrated result\n");
      await f.write(`${SESSION}/SCRIPTS.sql`, "SELECT 'fixture';\n");
      const before = await readSessionArtifacts(f.deps.fs, f.deps.paths, "001");
      const sessionsBefore = await listSessionsForRelease(f.deps.fs, f.root, f.deps.paths);
      const p = await prepareFixture(f);
      await applyCompaction(f.deps, p.request, p.local.digest);
      const tree = await snapshot(f.root);
      const after = await readSessionArtifacts(f.deps.fs, f.deps.paths, "001");
      expect(after.conclusiones).toEqual(before.conclusiones);
      expect(after.scripts).toEqual(before.scripts);
      expect(after.state).toBe(before.state);
      expect(after.archived_originals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ORIGINAL, state: "archived", integrity: "unchecked" }),
        ]),
      );
      const sessionsAfter = await listSessionsForRelease(f.deps.fs, f.root, f.deps.paths);
      expect(sessionsAfter.map((s) => [s.folder, s.code, s.state])).toEqual(
        sessionsBefore.map((s) => [s.folder, s.code, s.state]),
      );
      const loaded = await runSessionLoad(f.deps.fs, f.deps.env, f.deps.paths, { code: "001" });
      expect(loaded).toHaveProperty("archived_originals");
      expect(await f.deps.fs.exists(join(f.root, ORIGINAL))).toBe(false);
      expect(await snapshot(f.root)).toEqual(tree);
    } finally {
      await f.cleanup();
    }
  });
});
