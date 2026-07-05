import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runGenerateLaunch } from "../../src/application/generate-launch-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runWorkspaceInit } from "../../src/application/workspace-init-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

describe("runGenerateLaunch", () => {
  let root: string;
  let workspace: string;
  let env: FakeEnv;
  let paths: PathsService;
  let fs: NodeFileSystem;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gen-launch-"));
    workspace = join(root, "ws");
    mkdirSync(workspace, { recursive: true });
    env = new FakeEnv(workspace, workspace);
    paths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);
    fs = new NodeFileSystem();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Create a real source dir with the given files; returns its absolute path. */
  function makeSource(name: string, files: Record<string, string>): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);
    return dir;
  }

  /** Declare `sources` in the WORKSPACE block via the real init. */
  async function initWorkspace(sources: { alias: string; path: string }[]): Promise<void> {
    const res = await runWorkspaceInit(fs, env, paths, {
      sources,
      workspace,
      lastActivity: "2026-01-01 00:00",
    });
    if ("error" in res) throw new Error(`init failed: ${res.error}`);
  }

  const launchJson = (alias: string): string =>
    join(workspace, ".workflow", "launch", alias, "launch.json");
  const runShPath = (alias: string): string =>
    join(workspace, ".workflow", "launch", alias, "run.sh");

  it("errors when no sources are declared", async () => {
    const res = await runGenerateLaunch(fs, env, paths, {});
    expect("error" in res && res.error).toBe("no_sources_declared");
  });

  it("generates the artifacts for a launchable npm source", async () => {
    const app = makeSource("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
    await initWorkspace([{ alias: "app", path: app }]);

    const res = await runGenerateLaunch(fs, env, paths, {});
    if ("error" in res) throw new Error(res.error);
    expect(res.ok).toBe(true);
    expect(res.dry_run).toBe(false);
    expect(res.sources).toHaveLength(1);
    expect(res.sources[0]?.alias).toBe("app");
    expect(res.sources[0]?.launchable).toBe(true);
    expect(res.sources[0]?.outcomes.launchJson).toBe("created");
    expect(existsSync(launchJson("app"))).toBe(true);
  });

  it("marks a source with no runnable entry (only a build script) as not launchable", async () => {
    const svc = makeSource("svc", {
      "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    });
    await initWorkspace([{ alias: "svc", path: svc }]);

    const res = await runGenerateLaunch(fs, env, paths, {});
    if ("error" in res) throw new Error(res.error);
    expect(res.sources[0]?.launchable).toBe(false);
  });

  it("a CLI source (bin + build script) IS launchable — the run-locally case", async () => {
    const cli = makeSource("cli", {
      "package.json": JSON.stringify({
        bin: { mytool: "dist/main.js" },
        scripts: { build: "tsc" },
      }),
    });
    await initWorkspace([{ alias: "cli", path: cli }]);

    const res = await runGenerateLaunch(fs, env, paths, {});
    if ("error" in res) throw new Error(res.error);
    expect(res.sources[0]?.launchable).toBe(true);
    // The summary exposes the detected command (build && run).
    expect(res.sources[0]?.run).toBe("npm run build && node dist/main.js");
    // The generated run.sh builds first, then runs the entry.
    const runSh = readFileSync(runShPath("cli"), "utf-8");
    expect(runSh).toContain("npm run build");
    expect(runSh).toContain("exec node dist/main.js");
  });

  it("filters by --source and reports unknown aliases", async () => {
    const app = makeSource("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
    const api = makeSource("api", {
      "package.json": JSON.stringify({ scripts: { start: "node ." } }),
    });
    await initWorkspace([
      { alias: "app", path: app },
      { alias: "api", path: api },
    ]);

    const res = await runGenerateLaunch(fs, env, paths, { aliases: ["api", "ghost"] });
    if ("error" in res) throw new Error(res.error);
    expect(res.sources.map((s) => s.alias)).toEqual(["api"]);
    expect(res.unknown_aliases).toEqual(["ghost"]);
    expect(existsSync(launchJson("app"))).toBe(false); // not selected → untouched
  });

  it("errors when every --source alias is unknown", async () => {
    const app = makeSource("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
    await initWorkspace([{ alias: "app", path: app }]);

    const res = await runGenerateLaunch(fs, env, paths, { aliases: ["ghost"] });
    expect("error" in res && res.error).toBe("no_matching_sources");
  });

  it("dry-run classifies without writing anything", async () => {
    const app = makeSource("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
    await initWorkspace([{ alias: "app", path: app }]);

    const res = await runGenerateLaunch(fs, env, paths, { dryRun: true });
    if ("error" in res) throw new Error(res.error);
    expect(res.dry_run).toBe(true);
    expect(res.sources[0]?.outcomes.launchJson).toBe("created");
    expect(existsSync(launchJson("app"))).toBe(false);
  });

  it("skips and reports a declared source whose path is missing", async () => {
    const gone = makeSource("gone", {
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    });
    await initWorkspace([{ alias: "gone", path: gone }]);
    rmSync(gone, { recursive: true, force: true });

    const res = await runGenerateLaunch(fs, env, paths, {});
    if ("error" in res) throw new Error(res.error);
    expect(res.missing_sources).toEqual(["gone"]);
    expect(res.sources).toHaveLength(0);
  });

  it("force overwrites a hand-edited script", async () => {
    const app = makeSource("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
    await initWorkspace([{ alias: "app", path: app }]);
    await runGenerateLaunch(fs, env, paths, {});
    writeFileSync(runShPath("app"), `${readFileSync(runShPath("app"), "utf-8")}\n# tweak\n`);

    const res = await runGenerateLaunch(fs, env, paths, { force: true });
    if ("error" in res) throw new Error(res.error);
    expect(res.sources[0]?.outcomes.runSh).toBe("overwritten");
    expect(readFileSync(runShPath("app"), "utf-8")).not.toContain("# tweak");
  });
});
