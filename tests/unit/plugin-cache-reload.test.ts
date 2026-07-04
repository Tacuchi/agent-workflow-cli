import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfReloadPluginCache } from "../../src/application/self/plugin-cache-reload.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
// Bare NodeFileSystem on purpose: these tests seed real cache dirs and need real listings.
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

function buildArgs(values: Record<string, string>, flags: string[] = []): ParsedArgs {
  return {
    rest: ["reload"],
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

async function seedClaudeCacheWithSkills(
  home: string,
  marketplace: string,
  plugin: string,
  version: string,
  skillNames: string[],
): Promise<string> {
  const skillsDir = join(
    home,
    ".claude",
    "plugins",
    "cache",
    marketplace,
    plugin,
    version,
    "skills",
  );
  await mkdir(skillsDir, { recursive: true });
  for (const sn of skillNames) {
    const skillDir = join(skillsDir, sn);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: ${sn}\ndescription: stub\n---\nbody\n`,
      "utf8",
    );
  }
  return skillsDir;
}

describe("selfReloadPluginCache", () => {
  let workdir: string;
  let home: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-reload-test-"));
    home = join(workdir, "home");
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("reload claude → cleared-only + hint para reiniciar host", async () => {
    const fs = new NodeFileSystem();
    const ctx = buildCtx(home, fs);
    await seedClaudeCacheWithSkills(home, "qtc-marketplace", "qtc", "2.3.0", ["rules"]);

    const result = await selfReloadPluginCache(buildArgs({ plugin: "qtc", target: "claude" }), ctx);

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("cleared-only");
    expect(result.data?.hint).toMatch(/Reiniciá Claude Code/i);
    expect(result.data?.reinstalled).toEqual([]);
  });

  it("reload claude sin cache → nothing + hint", async () => {
    const fs = new NodeFileSystem();
    const ctx = buildCtx(home, fs);

    const result = await selfReloadPluginCache(buildArgs({ plugin: "qtc", target: "claude" }), ctx);

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("nothing");
    expect(result.data?.hint).toMatch(/Reiniciá Claude Code/i);
  });

  it("reload warp con cache de claude disponible → clear + reinstall", async () => {
    const fs = new NodeFileSystem();
    const ctx = buildCtx(home, fs);
    await seedClaudeCacheWithSkills(home, "qtc-marketplace", "qtc", "2.3.0", ["rules", "session"]);
    // Pre-install some old skills in warp
    const oldWarpDir = join(home, ".warp", "skills", "qtc-old-skill");
    await mkdir(oldWarpDir, { recursive: true });
    await writeFile(join(oldWarpDir, "SKILL.md"), "---\nname: x\n---\n", "utf8");

    const result = await selfReloadPluginCache(buildArgs({ plugin: "qtc", target: "warp" }), ctx);

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("reloaded");
    expect(await fs.exists(oldWarpDir)).toBe(false); // old one deleted
    expect(await fs.exists(join(home, ".warp", "skills", "qtc-rules"))).toBe(true);
    expect(await fs.exists(join(home, ".warp", "skills", "qtc-session"))).toBe(true);
    expect(result.data?.reinstalled.length).toBe(2);
  });

  it("reload warp sin source disponible → error SOURCE_NOT_FOUND", async () => {
    const fs = new NodeFileSystem();
    const ctx = buildCtx(home, fs);

    const result = await selfReloadPluginCache(buildArgs({ plugin: "qtc", target: "warp" }), ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("SOURCE_NOT_FOUND");
  });

  it("reload warp con --from explícito usa ese path", async () => {
    const fs = new NodeFileSystem();
    const ctx = buildCtx(home, fs);
    const externalSkillsDir = join(workdir, "external-skills");
    await mkdir(join(externalSkillsDir, "myskill"), { recursive: true });
    await writeFile(
      join(externalSkillsDir, "myskill", "SKILL.md"),
      "---\nname: myskill\ndescription: x\n---\n",
      "utf8",
    );

    const result = await selfReloadPluginCache(
      buildArgs({ plugin: "qtc", target: "warp", from: externalSkillsDir }),
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("reloaded");
    expect(await fs.exists(join(home, ".warp", "skills", "qtc-myskill"))).toBe(true);
  });

  it("reload warp --dry-run no toca filesystem", async () => {
    const fs = new NodeFileSystem();
    const ctx = buildCtx(home, fs);
    await seedClaudeCacheWithSkills(home, "qtc-marketplace", "qtc", "2.3.0", ["rules"]);

    const result = await selfReloadPluginCache(
      buildArgs({ plugin: "qtc", target: "warp" }, ["--dry-run"]),
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("dry-run");
    expect(await fs.exists(join(home, ".warp", "skills", "qtc-rules"))).toBe(false);
  });
});
