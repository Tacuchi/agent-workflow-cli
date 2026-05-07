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

function manifestJson(name: string, version: string, qtcContractVersion = "6.4"): string {
  return JSON.stringify({ name, version, qtcContractVersion });
}

function skillFrontmatter(name: string, version = "1.0.0"): string {
  return `---
name: ${name}
description: Test skill ${name}.
version: ${version}
---

# ${name}

Test content.
`;
}

describe("runPluginDoctor — plugin name from manifest (B-17 fix)", () => {
  it("derives plugin name from manifest.name (e.g., 'qtc')", async () => {
    const pluginRoot = "/cwd/qtc-plugin";
    const fs = new FakeFs(
      new Map([
        [`${pluginRoot}/.claude-plugin/plugin.json`, manifestJson("qtc", "1.0.0")],
        [`${pluginRoot}/.codex-plugin/plugin.json`, manifestJson("qtc", "1.0.0")],
        [`${pluginRoot}/hooks/hooks.json`, validHooksJson],
        [`${pluginRoot}/codex-hooks/hooks.json`, validHooksJson],
      ]),
      new Map([[pluginRoot, []]]),
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(data.plugin).toBe("qtc");
    expect(data.plugin_version).toBe("1.0.0");
  });

  it("falls back to `${ns}-${flow}` when manifest is missing", async () => {
    const pluginRoot = "/cwd/no-manifest-plugin";
    const fs = new FakeFs(new Map(), new Map([[pluginRoot, []]]));
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    expect(data.plugin).toBe("workflow-core"); // ns=workflow, flow=core (default)
    expect(data.plugin_version).toBe("unknown");
  });

  it("respects explicit input.pluginName over manifest", async () => {
    const pluginRoot = "/cwd/qtc-plugin";
    const fs = new FakeFs(
      new Map([
        [`${pluginRoot}/.claude-plugin/plugin.json`, manifestJson("qtc", "1.0.0")],
        [`${pluginRoot}/.codex-plugin/plugin.json`, manifestJson("qtc", "1.0.0")],
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

describe("runPluginDoctor — manifest version drift", () => {
  it("emits error when claude vs codex manifests have different versions", async () => {
    const pluginRoot = "/cwd/p";
    const fs = new FakeFs(
      new Map([
        [`${pluginRoot}/.claude-plugin/plugin.json`, manifestJson("qtc", "1.0.0")],
        [`${pluginRoot}/.codex-plugin/plugin.json`, manifestJson("qtc", "1.0.1")],
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
        [`${pluginRoot}/.claude-plugin/plugin.json`, manifestJson("qtc", "1.0.0")],
        [`${pluginRoot}/.codex-plugin/plugin.json`, manifestJson("qtc", "1.0.0")],
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
      new Map([[`${pluginRoot}/.claude-plugin/plugin.json`, manifestJson("qtc", "1.0.0")]]),
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

describe("runPluginDoctor — qtcContractVersion gate", () => {
  it("skips legacy checks when qtcContractVersion >= 6.3 (single-path)", async () => {
    const pluginRoot = "/cwd/p";
    const fs = new FakeFs(
      new Map([
        [`${pluginRoot}/.claude-plugin/plugin.json`, manifestJson("qtc", "1.0.0", "6.4")],
        [`${pluginRoot}/.codex-plugin/plugin.json`, manifestJson("qtc", "1.0.0", "6.4")],
      ]),
      new Map([[pluginRoot, []]]),
    );
    const { data } = await runPluginDoctor(fs, new FakeEnv(), paths, runtime, {
      pluginRoot,
    });
    // installed_marker / qtc_core_installed should be null (skipped).
    expect(data.installed_marker).toBeNull();
    expect(data.qtc_core_installed).toBeNull();
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
