import { describe, expect, it } from "vitest";
import { runHostDoctor } from "../../src/application/host-doctor-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import type { ProcessPort, RunResult } from "../../src/ports/process.js";

class FakeFs implements FileSystemPort {
  constructor(
    private files: Map<string, string> = new Map(),
    private dirs: Map<string, DirEntry[]> = new Map(),
  ) {}
  async readText(p: string) {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async writeText(): Promise<void> {}
  async writeTextExclusive(): Promise<{ created: boolean }> {
    return { created: true };
  }
  async remove(): Promise<void> {}
  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p);
  }
  async list(p: string): Promise<DirEntry[]> {
    return this.dirs.get(p) ?? [];
  }
  async mkdirp(): Promise<void> {}
  async stat(): Promise<FileStat> {
    return { mtime: new Date(0), size: 0, type: "file" };
  }
}

class FakeEnv implements EnvPort {
  constructor(private home: string) {}
  get(): string | undefined {
    return undefined;
  }
  homeDir(): string {
    return this.home;
  }
  cwd(): string {
    return "/cwd";
  }
}

class FakeProcess implements ProcessPort {
  constructor(private jqPath: string | undefined) {}
  async run(): Promise<RunResult> {
    return { code: 0, stdout: "", stderr: "" };
  }
  async which(cmd: string): Promise<string | undefined> {
    if (cmd === "jq") return this.jqPath;
    return undefined;
  }

  async spawnDetached() {
    throw new Error("spawnDetached not implemented in this fake");
  }
  async killTree(): Promise<void> {}
  async isAlive() {
    return false;
  }
}

function buildScenario(opts: {
  jqInPath: boolean;
  plugins: Array<{ marketplace: string; pluginDir: string; name: string }>;
}): { fs: FakeFs; env: FakeEnv; proc: FakeProcess } {
  const home = "/home/u";
  const marketplacesRoot = `${home}/.claude/plugins/marketplaces`;
  const files = new Map<string, string>();
  const dirs = new Map<string, DirEntry[]>();

  const marketplaceEntries: DirEntry[] = [];
  for (const p of opts.plugins) {
    const mpPath = `${marketplacesRoot}/${p.marketplace}`;
    marketplaceEntries.push({ name: p.marketplace, path: mpPath, type: "dir" });
    const pluginsDir = `${mpPath}/plugins`;
    dirs.set(pluginsDir, [
      { name: p.pluginDir, path: `${pluginsDir}/${p.pluginDir}`, type: "dir" },
    ]);
    const pluginJson = `${pluginsDir}/${p.pluginDir}/.claude-plugin/plugin.json`;
    files.set(pluginJson, JSON.stringify({ name: p.name }));
  }
  dirs.set(marketplacesRoot, marketplaceEntries);

  return {
    fs: new FakeFs(files, dirs),
    env: new FakeEnv(home),
    proc: new FakeProcess(opts.jqInPath ? "/usr/bin/jq" : undefined),
  };
}

describe("runHostDoctor", () => {
  it("reports ok when no jq-requiring plugins are installed", async () => {
    const { fs, env, proc } = buildScenario({ jqInPath: false, plugins: [] });
    const r = await runHostDoctor(fs, env, proc);
    expect(r.status).toBe("ok");
    expect(r.findings).toHaveLength(0);
  });

  it("reports warn when warp is installed AND jq is missing", async () => {
    const { fs, env, proc } = buildScenario({
      jqInPath: false,
      plugins: [{ marketplace: "claude-code-warp", pluginDir: "warp", name: "warp" }],
    });
    const r = await runHostDoctor(fs, env, proc);
    expect(r.status).toBe("warn");
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    if (!f) throw new Error("expected one finding");
    expect(f.severity).toBe("warn");
    expect(f.dependency).toBe("jq");
    expect(f.required_by).toContain("warp");
    expect(f.install_hint.darwin).toMatch(/brew install jq/);
    expect(f.install_hint.linux).toMatch(/apt install jq/);
    expect(f.install_hint.win32).toMatch(/choco install jq|scoop install jq/);
  });

  it("reports ok when warp is installed AND jq is present", async () => {
    const { fs, env, proc } = buildScenario({
      jqInPath: true,
      plugins: [{ marketplace: "claude-code-warp", pluginDir: "warp", name: "warp" }],
    });
    const r = await runHostDoctor(fs, env, proc);
    expect(r.status).toBe("ok");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.severity).toBe("ok");
  });

  it("matches by marketplace name when plugin name is uncommon", async () => {
    // plugin.json has name="something-else", but marketplace dir is claude-code-warp
    const { fs, env, proc } = buildScenario({
      jqInPath: false,
      plugins: [{ marketplace: "claude-code-warp", pluginDir: "warp", name: "something-else" }],
    });
    const r = await runHostDoctor(fs, env, proc);
    expect(r.status).toBe("warn");
    expect(r.findings[0]?.required_by).toContain("something-else");
  });

  it("does not flag unrelated plugins", async () => {
    const { fs, env, proc } = buildScenario({
      jqInPath: false,
      plugins: [
        { marketplace: "qtc-marketplace", pluginDir: "qtc", name: "qtc" },
        { marketplace: "qtc-marketplace", pluginDir: "agent-workflow", name: "agent-workflow" },
      ],
    });
    const r = await runHostDoctor(fs, env, proc);
    expect(r.status).toBe("ok");
    expect(r.findings).toHaveLength(0);
  });

  it("survives missing marketplaces root (fresh install)", async () => {
    const fs = new FakeFs(); // empty
    const env = new FakeEnv("/nonexistent");
    const proc = new FakeProcess(undefined);
    const r = await runHostDoctor(fs, env, proc);
    expect(r.status).toBe("ok");
    expect(r.findings).toHaveLength(0);
  });
});
