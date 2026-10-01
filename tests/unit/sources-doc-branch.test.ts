import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { appendDocBranch } from "../../src/application/doc-branch-ledger.js";
import { PathsService } from "../../src/application/paths-service.js";
import { renderHubBlock } from "../../src/application/render/hub-block.js";
import { runSources } from "../../src/application/sources-service.js";
import { sealCustody } from "../../src/domain/session/custody.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

describe("aw sources por rama esperada", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("dos fuentes distintas están consistentes si cada una coincide con su esperada", async () => {
    root = mkdtempSync(join(tmpdir(), "sources-doc-"));
    const fs = new NodeFileSystem();
    const git = new GitCliAdapter(new NodeProcess());
    const paths = new PathsService(normalizeNamespace("workflow"), root, root);
    const sources = ["uno", "dos"].map((alias) => {
      const repo = join(root, alias);
      mkdirSync(repo);
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      return { alias, path: repo, main_branch: "main" };
    });
    const [first, second] = sources;
    if (!first || !second) throw new Error("fixture incompleta");
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: first.path });
    for (const source of sources) {
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: source.path });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: source.path });
      writeFileSync(join(source.path, "README"), "fixture\n");
      execFileSync("git", ["add", "README"], { cwd: source.path });
      execFileSync("git", ["commit", "-qm", "base"], { cwd: source.path });
    }
    mkdirSync(paths.cwdSessionsDir(), { recursive: true });
    const session = "103-plan-plan-exec";
    const dir = join(paths.cwdSessionsDir(), session);
    mkdirSync(dir);
    writeFileSync(join(dir, "SESSION.md"), "# SESSION\n");
    writeFileSync(
      join(dir, ".custody.json"),
      JSON.stringify(
        sealCustody({
          subject: { kind: "session", key: session },
          subjectPath: dir,
          created: "2026-09-27",
          parents: [{ kind: "plan", key: "067" }],
        }),
      ),
    );
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    writeFileSync(join(root, "docs", "plans", "067-plan-fixture.md"), "# Plan\n");
    writeFileSync(
      join(root, "CLAUDE.md"),
      renderHubBlock({
        proyecto: "Test",
        fuentes: sources,
        stack: {},
        lastActivity: "2026-09-27",
        workingBranches: { uno: "main", dos: "main" },
        qaBranches: {},
        markers: paths.blockMarkers(),
      }),
    );
    execFileSync("git", ["branch", "feature/plan", "main"], { cwd: first.path });
    execFileSync("git", ["checkout", "-q", "feature/plan"], { cwd: first.path });
    await appendDocBranch(fs, paths, {
      version: 1,
      at: new Date().toISOString(),
      doc: { kind: "plan", key: "067" },
      source: "uno",
      branch: "feature/plan",
      by: session,
      outcome: "existing",
    });
    const deps = [fs, new FakeEnv(root), git, paths] as const;
    const matching = await runSources(...deps, { sessionCode: "103", verbose: true });
    expect(matching.cross_source_consistent).toBe(true);
    expect(
      matching.sources.map((s) => [s.expected_work_branch, s.expected_origin, s.match]),
    ).toEqual([
      ["feature/plan", "own", true],
      ["main", "registered", true],
    ]);
    execFileSync("git", ["checkout", "-q", "main"], { cwd: first.path });
    const divergent = await runSources(...deps, { sessionCode: "103" });
    expect(divergent.cross_source_consistent).toBe(false);
    expect(divergent.divergent_sources.map((s) => s.alias)).toEqual(["uno"]);
    await fs.appendText(join(paths.cwdRoot(), "doc-branches.jsonl"), "{broken\n");
    const corrupt = await runSources(...deps, { sessionCode: "103" });
    expect(corrupt.doc_branch_unreadable).toBe(1);
    expect(corrupt.divergent_sources.map((s) => s.alias)).toEqual(["uno"]);
  });
});
