import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfClearPluginCache } from "../../src/application/self/plugin-cache-clear.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
// Bare NodeFileSystem on purpose: these tests seed real cache dirs and need real listings.
import { NodeFileSystem } from "../helpers/real-fs.js";

function buildArgs(values: Record<string, string>, flags: string[] = []): ParsedArgs {
  return {
    rest: ["clear"],
    plugin: {},
    flags: new Set(flags),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildCtx(home: string, fs: FileSystemPort): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const paths = new PathsService(ns, home, home);
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs,
    env: new FakeEnv(home),
    process: new FakeProcess(),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths,
  };
}

async function seedClaudeCache(home: string, marketplace: string, plugin: string, version: string) {
  const versionDir = join(home, ".claude", "plugins", "cache", marketplace, plugin, version);
  await mkdir(join(versionDir, "skills"), { recursive: true });
  await writeFile(
    join(versionDir, "skills", "SKILL.md"),
    `---\nname: ${plugin}\n---\nbody\n`,
    "utf8",
  );
  return join(home, ".claude", "plugins", "cache", marketplace, plugin);
}

async function seedClaudeInstalledPlugins(
  home: string,
  entries: Record<string, unknown>,
): Promise<string> {
  const installedPath = join(home, ".claude", "plugins", "installed_plugins.json");
  await mkdir(join(home, ".claude", "plugins"), { recursive: true });
  await writeFile(
    installedPath,
    `${JSON.stringify({ version: 2, plugins: entries }, null, 2)}\n`,
    "utf8",
  );
  return installedPath;
}

async function seedWarpSkill(home: string, dirName: string): Promise<string> {
  const path = join(home, ".warp", "skills", dirName);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), "---\nname: x\n---\n", "utf8");
  return path;
}

describe("selfClearPluginCache", () => {
  let workdir: string;
  let home: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-clear-test-"));
    home = join(workdir, "home");
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("rejects missing --plugin", async () => {
    const fs = new NodeFileSystem();
    const ctx = buildCtx(home, fs);
    const result = await selfClearPluginCache(buildArgs({ target: "claude" }), ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("rejects invalid --target", async () => {
    const fs = new NodeFileSystem();
    const ctx = buildCtx(home, fs);
    const result = await selfClearPluginCache(buildArgs({ plugin: "qtc", target: "linux" }), ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("claude target with no cache → status nothing", async () => {
    const fs = new NodeFileSystem();
    const ctx = buildCtx(home, fs);
    const result = await selfClearPluginCache(buildArgs({ plugin: "qtc", target: "claude" }), ctx);
    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("nothing");
    expect(result.data?.removed).toEqual([]);
  });

  it("claude target removes cache dirs + installed_plugins entry", async () => {
    const fs = new NodeFileSystem();
    const ctx = buildCtx(home, fs);
    const cacheDir = await seedClaudeCache(home, "qtc-marketplace", "qtc", "2.3.0");
    const installedPath = await seedClaudeInstalledPlugins(home, {
      "qtc@qtc-marketplace": [{ version: "2.3.0" }],
      "other@other-marketplace": [{ version: "1.0.0" }],
    });

    const result = await selfClearPluginCache(buildArgs({ plugin: "qtc", target: "claude" }), ctx);

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("removed");
    expect(await fs.exists(cacheDir)).toBe(false);

    const updated = JSON.parse(await fs.readText(installedPath)) as {
      plugins: Record<string, unknown>;
    };
    expect(updated.plugins).not.toHaveProperty("qtc@qtc-marketplace");
    expect(updated.plugins).toHaveProperty("other@other-marketplace");
  });

  it("--dry-run does not touch filesystem but reports planned removals", async () => {
    const fs = new NodeFileSystem();
    const ctx = buildCtx(home, fs);
    const cacheDir = await seedClaudeCache(home, "qtc-marketplace", "qtc", "2.3.0");
    await seedClaudeInstalledPlugins(home, { "qtc@qtc-marketplace": [{}] });

    const result = await selfClearPluginCache(
      buildArgs({ plugin: "qtc", target: "claude" }, ["--dry-run"]),
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("dry-run");
    expect(result.data?.removed.length).toBeGreaterThan(0);
    expect(await fs.exists(cacheDir)).toBe(true);
  });

  it("warp target removes skill dirs that match the namespace prefix", async () => {
    const fs = new NodeFileSystem();
    const ctx = buildCtx(home, fs);
    const qtcSession = await seedWarpSkill(home, "qtc-session");
    const qtcRules = await seedWarpSkill(home, "qtc-rules");
    const otherSkill = await seedWarpSkill(home, "other-skill");

    const result = await selfClearPluginCache(buildArgs({ plugin: "qtc", target: "warp" }), ctx);

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("removed");
    expect(result.data?.removed.length).toBe(2);
    expect(await fs.exists(qtcSession)).toBe(false);
    expect(await fs.exists(qtcRules)).toBe(false);
    expect(await fs.exists(otherSkill)).toBe(true);
  });

  it("warp target with no matching skills → status nothing", async () => {
    const fs = new NodeFileSystem();
    const ctx = buildCtx(home, fs);
    await seedWarpSkill(home, "other-skill");

    const result = await selfClearPluginCache(buildArgs({ plugin: "qtc", target: "warp" }), ctx);

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("nothing");
  });

  it("codex target removes cache + installed_plugins entry (sibling of claude)", async () => {
    const fs = new NodeFileSystem();
    const ctx = buildCtx(home, fs);
    const codexCacheDir = join(home, ".codex", "plugins", "cache", "qtc-marketplace", "qtc");
    await mkdir(join(codexCacheDir, "2.3.0", "skills"), { recursive: true });
    const installedPath = join(home, ".codex", "plugins", "installed_plugins.json");
    await writeFile(
      installedPath,
      JSON.stringify({ plugins: { "qtc@qtc-marketplace": [{}] } }, null, 2),
      "utf8",
    );

    const result = await selfClearPluginCache(buildArgs({ plugin: "qtc", target: "codex" }), ctx);

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("removed");
    expect(await fs.exists(codexCacheDir)).toBe(false);

    const updated = JSON.parse(await fs.readText(installedPath)) as {
      plugins: Record<string, unknown>;
    };
    expect(updated.plugins).not.toHaveProperty("qtc@qtc-marketplace");
  });
});
