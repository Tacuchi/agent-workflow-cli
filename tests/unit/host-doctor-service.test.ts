import { describe, expect, it } from "vitest";
import { runHostDoctor } from "../../src/application/host-doctor-service.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { MemFs } from "../helpers/mem-fs.js";

function buildScenario(opts: {
  jqInPath: boolean;
  plugins: Array<{ marketplace: string; pluginDir: string; name: string }>;
}): { fs: MemFs; env: FakeEnv; proc: FakeProcess } {
  const home = "/home/u";
  const marketplacesRoot = `${home}/.claude/plugins/marketplaces`;
  // Lenient: the old fake returned [] / a canned file-stat for unseeded paths.
  const fs = new MemFs({ lenient: true });

  for (const p of opts.plugins) {
    const pluginDirPath = `${marketplacesRoot}/${p.marketplace}/plugins/${p.pluginDir}`;
    fs.dir(pluginDirPath);
    fs.file(`${pluginDirPath}/.claude-plugin/plugin.json`, JSON.stringify({ name: p.name }));
  }

  return {
    fs,
    env: new FakeEnv(home, "/cwd"),
    proc: new FakeProcess({
      which: (cmd) => (cmd === "jq" && opts.jqInPath ? "/usr/bin/jq" : undefined),
    }),
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
    const fs = new MemFs({ lenient: true }); // empty
    const env = new FakeEnv("/nonexistent", "/cwd");
    const proc = new FakeProcess();
    const r = await runHostDoctor(fs, env, proc);
    expect(r.status).toBe("ok");
    expect(r.findings).toHaveLength(0);
  });
});
