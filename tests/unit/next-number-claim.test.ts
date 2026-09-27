import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  applyRecovery,
  previewRecovery,
  scanSlots,
} from "../../src/application/claims-recovery.js";
import { runNextNumber } from "../../src/application/dev-only-services.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * The correlative mint under concurrency (C4).
 *
 * The old mint read the maximum and returned max+1, and whoever asked wrote the
 * file afterwards — outside any critical section. Two flows reading the same
 * directory in the same instant therefore both received `021`, and the second
 * write silently replaced the first document.
 */
describe("runNextNumber --claim", () => {
  let workspace: string;
  let env: FakeEnv;
  let paths: PathsService;
  let fs: NodeFileSystem;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "next-number-"));
    env = new FakeEnv(workspace, workspace);
    paths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);
    fs = new NodeFileSystem();
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("hands eight concurrent claims eight distinct numbers and eight distinct files", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        runNextNumber(fs, env, paths, {
          directory: "docs/plans",
          claim: { name: `plan-${i}.md`, owner: `20${i}-flujo-plan-new` },
        }),
      ),
    );

    const numbers = results.map((r) => r.next);
    expect(new Set(numbers).size).toBe(8);
    const claimed = results.map((r) => r.claimed_path);
    expect(claimed.every((p) => p !== null)).toBe(true);
    expect(new Set(claimed).size).toBe(8);

    // Every claim is a possession, not a prediction: the file is on disk.
    const onDisk = readdirSync(join(workspace, "docs", "plans")).sort();
    expect(onDisk).toHaveLength(8);
    expect(new Set(onDisk.map((n) => n.slice(0, 3))).size).toBe(8);
  });

  it("skips a number another document already holds under a different slug", async () => {
    mkdirSync(join(workspace, "docs", "specs"), { recursive: true });
    writeFileSync(join(workspace, "docs", "specs", "001-spec-uno.md"), "x");
    writeFileSync(join(workspace, "docs", "specs", "002-spec-dos.md"), "x");

    const claimed = await runNextNumber(fs, env, paths, {
      directory: "docs/specs",
      claim: { name: "spec-tres.md", owner: "201-tres-spec-new" },
    });

    expect(claimed.next).toBe("003");
    expect(claimed.claimed_path).toContain("003-spec-tres.md");
  });

  it("leaves the pure query exactly as it was: no claim, nothing written", async () => {
    const consulted = await runNextNumber(fs, env, paths, { directory: "docs/plans" });

    expect(consulted.next).toBe("001");
    expect(consulted.claimed_path).toBeNull();
    expect(readdirSync(join(workspace, "docs", "plans"))).toEqual([]);
  });

  it("refuses a claim that is a path instead of a name", async () => {
    // The claim becomes a real write: a separator would mint outside the
    // directory the caller named, and the caller is a command-line argument.
    await expect(
      runNextNumber(fs, env, paths, {
        directory: "docs/plans",
        claim: { name: "../fuera.md", owner: "201-x-plan-new" },
      }),
    ).rejects.toThrow(/separadores de ruta/);
    expect(existsSync(join(workspace, "docs", "fuera.md"))).toBe(false);
  });

  it("never creates the directory in dry-run", async () => {
    const consulted = await runNextNumber(fs, env, paths, {
      directory: "docs/reports",
      dryRun: true,
    });

    expect(consulted.created).toBe(false);
    expect(consulted.claimed_path).toBeNull();
    expect(() => readdirSync(join(workspace, "docs", "reports"))).toThrow();
  });

  it("reserva carpetas con marcador propio, reentra y permite recuperarlas", async () => {
    const claim = {
      name: "export-scripts-2026-09-27",
      owner: "operation-abc",
      folder: true,
      material: "digest-1",
    };
    const first = await runNextNumber(fs, env, paths, { directory: "docs/scripts", claim });
    const second = await runNextNumber(fs, env, paths, { directory: "docs/scripts", claim });
    expect(second.next).toBe(first.next);
    expect(second.claim_reused).toBe(true);
    expect(readdirSync(join(first.claimed_path as string))).toEqual([".aw-reservation"]);

    const slot = "docs/scripts/001-export-scripts-2026-09-27";
    expect((await scanSlots(fs, paths)).slots.map((entry) => entry.path)).toContain(slot);
    const preview = await previewRecovery(fs, paths, slot);
    if (!("proposal" in preview)) throw new Error(preview.error);
    const recovered = await applyRecovery(fs, paths, {
      target: slot,
      approval: preview.proposal.digest,
    });
    expect("applied" in recovered).toBe(true);
    expect(existsSync(first.claimed_path as string)).toBe(false);
  });
});
