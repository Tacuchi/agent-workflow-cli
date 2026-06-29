import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { runPluginDoctor } from "../../src/application/plugin-doctor-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";

class FakeEnv implements EnvPort {
  get() {
    return undefined;
  }
  homeDir() {
    return "/home/u";
  }
  cwd() {
    return "/cwd";
  }
}

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
  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p);
  }
  async list(p: string): Promise<DirEntry[]> {
    const v = this.dirs.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async mkdirp(): Promise<void> {}
  async stat(): Promise<FileStat> {
    throw new Error("nyi");
  }
}

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");
const runtime: ResolvedRuntime = {
  packageName: "@tacuchi/agent-workflow-cli",
  binName: "agent-workflow",
  source: "default",
};

const validHooksJson = JSON.stringify({
  hooks: {
    SessionStart: [],
    PreToolUse: [],
  },
});

function manifestJson(name: string, version: string, contractVersion = "6.4"): string {
  return JSON.stringify({ name, version, contractVersion });
}

function skillFrontmatter(name: string, version = "1.0.0"): string {
  return `---
name: ${name}
description: Test skill ${name}.
metadata:
  version: ${version}
---

# ${name}

Test content.
`;
}

function singleSkillFs(dir: string, skillMd: string, pluginRoot = "/cwd/p"): FakeFs {
  return new FakeFs(
    new Map([[`${pluginRoot}/skills/${dir}/SKILL.md`, skillMd]]),
    new Map([
      [pluginRoot, []],
      [`${pluginRoot}/skills`, [{ name: dir, path: `${pluginRoot}/skills/${dir}`, type: "dir" }]],
      [`${pluginRoot}/skills/${dir}`, []],
    ]),
  );
}

function warns(data: { findings: { level: string; msg: string }[] }, needle: string): boolean {
  return data.findings.some((f) => f.level === "warn" && f.msg.includes(needle));
}

describe("runPluginDoctor — plugin name from manifest (B-17 fix)", () => {
  it("derives plugin name from manifest.name", async () => {
    const pluginRoot = "/cwd/acme-plugin";
    const fs = new FakeFs(
      new Map([
        [`${pluginRoot}/.claude-plugin/plugin.json`, manifestJson("acme", "1.0.0")],
        [`${pluginRoot}/.codex-plugin/plugin.json`, manifestJson("acme", "1.0.0")],
        [`${pluginRoot}/hooks/hooks.json`, validHooksJson],
        [`${pluginRoot}/codex-hooks/hooks.json`, validHooksJson],
      ]),
      new Map([[pluginRoot, []]]),
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(data.plugin).toBe("acme");
    expect(data.plugin_version).toBe("1.0.0");
  });

  it("falls back to basename(pluginRoot) when manifest is missing (H-04)", async () => {
    const pluginRoot = "/cwd/no-manifest-plugin";
    const fs = new FakeFs(new Map(), new Map([[pluginRoot, []]]));
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(data.plugin).toBe("no-manifest-plugin"); // basename of pluginRoot
    expect(data.plugin_version).toBe("unknown");
  });

  it("falls back to `${ns}-${flow}` when basename is empty (e.g., pluginRoot='/')", async () => {
    const pluginRoot = "/";
    const fs = new FakeFs(new Map(), new Map([[pluginRoot, []]]));
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(data.plugin).toBe("workflow-core");
  });

  it("respects explicit input.pluginName over manifest", async () => {
    const pluginRoot = "/cwd/acme-plugin";
    const fs = new FakeFs(
      new Map([
        [`${pluginRoot}/.claude-plugin/plugin.json`, manifestJson("acme", "1.0.0")],
        [`${pluginRoot}/.codex-plugin/plugin.json`, manifestJson("acme", "1.0.0")],
      ]),
      new Map([[pluginRoot, []]]),
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
      pluginName: "explicit-override",
    });
    expect(data.plugin).toBe("explicit-override");
  });
});

describe("runPluginDoctor — skills frontmatter", () => {
  it("reports skills_count=0 and no findings when no skills/ dir", async () => {
    const pluginRoot = "/cwd/empty-plugin";
    const fs = new FakeFs(new Map(), new Map([[pluginRoot, []]]));
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(data.skills_count).toBe(0);
    expect(data.skills).toEqual([]);
  });

  it("reports skills with valid frontmatter", async () => {
    const pluginRoot = "/cwd/p";
    const fs = new FakeFs(
      new Map([
        [`${pluginRoot}/skills/foo/SKILL.md`, skillFrontmatter("foo", "1.0.0")],
        [`${pluginRoot}/skills/bar/SKILL.md`, skillFrontmatter("bar", "2.1.0")],
      ]),
      new Map([
        [pluginRoot, []],
        [
          `${pluginRoot}/skills`,
          [
            { name: "foo", path: `${pluginRoot}/skills/foo`, type: "dir" },
            { name: "bar", path: `${pluginRoot}/skills/bar`, type: "dir" },
          ],
        ],
        [`${pluginRoot}/skills/foo`, []],
        [`${pluginRoot}/skills/bar`, []],
      ]),
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(data.skills_count).toBe(2);
    expect(data.skills.find((s) => s.dir === "foo")?.name).toBe("foo");
    expect(data.skills.find((s) => s.dir === "bar")?.version).toBe("2.1.0");
    const errors = data.findings.filter((f) => f.level === "error");
    expect(errors.filter((f) => f.file.includes("SKILL.md"))).toHaveLength(0);
  });

  it("emits error finding when skill missing 'name' in frontmatter", async () => {
    const pluginRoot = "/cwd/p";
    const fs = new FakeFs(
      new Map([
        [
          `${pluginRoot}/skills/broken/SKILL.md`,
          "---\ndescription: missing name field\nversion: 1.0.0\n---\n",
        ],
      ]),
      new Map([
        [pluginRoot, []],
        [
          `${pluginRoot}/skills`,
          [{ name: "broken", path: `${pluginRoot}/skills/broken`, type: "dir" }],
        ],
        [`${pluginRoot}/skills/broken`, []],
      ]),
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(data.findings.some((f) => f.level === "error" && f.msg.includes("name"))).toBe(true);
  });

  it("emits warn finding when skill version is not semver", async () => {
    const pluginRoot = "/cwd/p";
    const fs = new FakeFs(
      new Map([
        [
          `${pluginRoot}/skills/badver/SKILL.md`,
          "---\nname: badver\ndescription: bad ver\nversion: not-semver\n---\n",
        ],
      ]),
      new Map([
        [pluginRoot, []],
        [
          `${pluginRoot}/skills`,
          [{ name: "badver", path: `${pluginRoot}/skills/badver`, type: "dir" }],
        ],
        [`${pluginRoot}/skills/badver`, []],
      ]),
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(
      data.findings.some((f) => f.level === "warn" && f.msg.includes("not semver-compatible")),
    ).toBe(true);
  });

  it("emits warn finding when skill name differs from directory", async () => {
    const pluginRoot = "/cwd/p";
    const fs = new FakeFs(
      new Map([
        [
          `${pluginRoot}/skills/dirname/SKILL.md`,
          "---\nname: different-name\ndescription: x\nversion: 1.0.0\n---\n",
        ],
      ]),
      new Map([
        [pluginRoot, []],
        [
          `${pluginRoot}/skills`,
          [{ name: "dirname", path: `${pluginRoot}/skills/dirname`, type: "dir" }],
        ],
        [`${pluginRoot}/skills/dirname`, []],
      ]),
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(
      data.findings.some((f) => f.level === "warn" && f.msg.includes("differs from directory")),
    ).toBe(true);
  });
});

describe("runPluginDoctor — Agent Skills standard limits", () => {
  it("warns when description exceeds the 1024-char standard cap", async () => {
    const longDesc = `Use when ${"x".repeat(1100)}`;
    const fs = singleSkillFs(
      "big",
      `---\nname: big\ndescription: ${longDesc}\nmetadata:\n  version: 1.0.0\n---\n`,
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot: "/cwd/p",
    });
    expect(warns(data, "caps it at 1024")).toBe(true);
  });

  it("does not warn on a description at/under the 1024-char cap", async () => {
    const okDesc = `Use when ${"x".repeat(900)}`;
    const fs = singleSkillFs(
      "okdesc",
      `---\nname: okdesc\ndescription: ${okDesc}\nmetadata:\n  version: 1.0.0\n---\n`,
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot: "/cwd/p",
    });
    expect(warns(data, "caps it at 1024")).toBe(false);
  });

  it("warns when name exceeds 64 chars", async () => {
    const longName = "a".repeat(70);
    const fs = singleSkillFs(
      longName,
      `---\nname: ${longName}\ndescription: x\nmetadata:\n  version: 1.0.0\n---\n`,
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot: "/cwd/p",
    });
    expect(warns(data, "caps it at 64")).toBe(true);
  });

  it("warns when name is not lowercase-hyphen (uppercase / underscore)", async () => {
    const fs = singleSkillFs(
      "Bad_Name",
      "---\nname: Bad_Name\ndescription: x\nmetadata:\n  version: 1.0.0\n---\n",
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot: "/cwd/p",
    });
    expect(warns(data, "not lowercase alphanumeric")).toBe(true);
  });

  it("warns on an unknown top-level frontmatter key", async () => {
    const fs = singleSkillFs(
      "extrakey",
      "---\nname: extrakey\ndescription: x\nauthor: someone\nmetadata:\n  version: 1.0.0\n---\n",
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot: "/cwd/p",
    });
    expect(warns(data, "unknown top-level frontmatter key 'author'")).toBe(true);
  });

  it("does not warn 'unknown key' for standard optional fields (license, compatibility, allowed-tools)", async () => {
    const fs = singleSkillFs(
      "rich",
      "---\nname: rich\ndescription: x\nlicense: MIT\ncompatibility: Requires git\nallowed-tools: Read\nmetadata:\n  version: 1.0.0\n---\n",
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot: "/cwd/p",
    });
    expect(warns(data, "unknown top-level frontmatter key")).toBe(false);
  });
});

describe("runPluginDoctor — version under metadata (Agent Skills standard)", () => {
  it("reads version from metadata.version without a missing-version warning", async () => {
    const fs = singleSkillFs(
      "metaver",
      "---\nname: metaver\ndescription: x\nmetadata:\n  version: 1.2.3\n---\n",
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot: "/cwd/p",
    });
    expect(data.skills.find((s) => s.dir === "metaver")?.version).toBe("1.2.3");
    expect(warns(data, "missing version")).toBe(false);
    expect(warns(data, "move it to metadata.version")).toBe(false);
  });

  it("warns to migrate a legacy top-level version to metadata.version", async () => {
    const fs = singleSkillFs(
      "legacyver",
      "---\nname: legacyver\ndescription: x\nversion: 1.0.0\n---\n",
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot: "/cwd/p",
    });
    expect(warns(data, "move it to metadata.version")).toBe(true);
    // still resolves the version via the legacy fallback (no missing-version warn)
    expect(warns(data, "missing version")).toBe(false);
  });

  it("does not warn when version is absent (version is optional per the standard)", async () => {
    const fs = singleSkillFs("noversion", "---\nname: noversion\ndescription: x\n---\n");
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot: "/cwd/p",
    });
    expect(warns(data, "missing version")).toBe(false);
    expect(warns(data, "not semver")).toBe(false);
    expect(data.skills.find((s) => s.dir === "noversion")?.version).toBeNull();
  });
});

describe("runPluginDoctor — manifest version drift", () => {
  it("emits error when claude vs codex manifests have different versions", async () => {
    const pluginRoot = "/cwd/p";
    const fs = new FakeFs(
      new Map([
        [`${pluginRoot}/.claude-plugin/plugin.json`, manifestJson("acme", "1.0.0")],
        [`${pluginRoot}/.codex-plugin/plugin.json`, manifestJson("acme", "1.0.1")],
      ]),
      new Map([[pluginRoot, []]]),
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(data.findings.some((f) => f.level === "error" && f.msg.includes("version drift"))).toBe(
      true,
    );
  });

  it("does not emit drift error when both manifests match", async () => {
    const pluginRoot = "/cwd/p";
    const fs = new FakeFs(
      new Map([
        [`${pluginRoot}/.claude-plugin/plugin.json`, manifestJson("acme", "1.0.0")],
        [`${pluginRoot}/.codex-plugin/plugin.json`, manifestJson("acme", "1.0.0")],
      ]),
      new Map([[pluginRoot, []]]),
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(data.findings.some((f) => f.msg.includes("version drift"))).toBe(false);
  });

  it("emits warn for missing manifest", async () => {
    const pluginRoot = "/cwd/p";
    const fs = new FakeFs(
      new Map([[`${pluginRoot}/.claude-plugin/plugin.json`, manifestJson("acme", "1.0.0")]]),
      new Map([[pluginRoot, []]]),
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(
      data.findings.some((f) => f.level === "warn" && f.file === ".codex-plugin/plugin.json"),
    ).toBe(true);
  });
});

describe("runPluginDoctor — hooks JSON", () => {
  it("reports hook keys when JSON is valid", async () => {
    const pluginRoot = "/cwd/p";
    const fs = new FakeFs(
      new Map([[`${pluginRoot}/hooks/hooks.json`, validHooksJson]]),
      new Map([[pluginRoot, []]]),
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(data.hooks["hooks/hooks.json"]).toEqual(["PreToolUse", "SessionStart"]);
  });

  it("emits error when hooks JSON is malformed", async () => {
    const pluginRoot = "/cwd/p";
    const fs = new FakeFs(
      new Map([[`${pluginRoot}/hooks/hooks.json`, "{not valid json"]]),
      new Map([[pluginRoot, []]]),
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(
      data.findings.some(
        (f) =>
          f.level === "error" && f.file === "hooks/hooks.json" && f.msg.includes("invalid JSON"),
      ),
    ).toBe(true);
    expect(data.hooks["hooks/hooks.json"]).toBeNull();
  });

  it("emits warn when hooks file is missing", async () => {
    const pluginRoot = "/cwd/p";
    const fs = new FakeFs(new Map(), new Map([[pluginRoot, []]]));
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(
      data.findings.some(
        (f) => f.level === "warn" && f.file === "hooks/hooks.json" && f.msg.includes("missing"),
      ),
    ).toBe(true);
  });
});

describe("runPluginDoctor — overall status", () => {
  it("returns DoctorOutput.status field as 'ok' | 'warn' | 'error'", async () => {
    const pluginRoot = "/cwd/p";
    const fs = new FakeFs(new Map(), new Map([[pluginRoot, []]]));
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(["ok", "warn", "error"]).toContain(data.status);
  });
});
