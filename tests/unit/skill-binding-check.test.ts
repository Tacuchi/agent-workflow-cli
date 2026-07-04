import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  checkInstalledBindings,
  resolveSkills,
} from "../../src/application/skills-resolver-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

describe("checkInstalledBindings (advisory binding validation)", () => {
  let home: string;
  let cwd: string;
  let paths: PathsService;
  let env: FakeEnv;
  const fs = new NodeFileSystem();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bind-home-"));
    cwd = mkdtempSync(join(tmpdir(), "bind-cwd-"));
    paths = new PathsService(normalizeNamespace("workflow"), home, cwd);
    env = new FakeEnv(home, cwd);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function writeWorkspaceToml(toml: string): void {
    mkdirSync(join(cwd, ".workflow"), { recursive: true });
    writeFileSync(paths.cwdSkillsToml(), toml);
  }
  function installSkill(root: string, name: string, fmName = name): void {
    const dir = join(cwd, root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${fmName}\ndescription: x\n---\n`);
  }

  it("does not warn or check when no role is bound (all defaults)", async () => {
    const resolution = await resolveSkills(fs, paths);
    const { checks, warnings } = await checkInstalledBindings(fs, env, resolution);
    expect(checks).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("no warning when the bound skill is installed under a standard root", async () => {
    writeWorkspaceToml('[skills]\nui-design = "figma-spec"\n');
    installSkill(".claude/skills", "figma-spec");
    const resolution = await resolveSkills(fs, paths);
    const { checks, warnings } = await checkInstalledBindings(fs, env, resolution);
    expect(checks.find((c) => c.role === "ui-design")?.installed).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("warns when the bound skill is not installed anywhere", async () => {
    writeWorkspaceToml('[skills]\nui-design = "ghost-skill"\n');
    const resolution = await resolveSkills(fs, paths);
    const { checks, warnings } = await checkInstalledBindings(fs, env, resolution);
    expect(checks.find((c) => c.role === "ui-design")?.installed).toBe(false);
    expect(warnings.some((w) => w.includes("ghost-skill"))).toBe(true);
  });

  it("does not warn for a built-in default name even when explicitly bound", async () => {
    writeWorkspaceToml('[skills]\nsql = "sql"\n');
    const resolution = await resolveSkills(fs, paths);
    const { checks, warnings } = await checkInstalledBindings(fs, env, resolution);
    expect(checks.find((c) => c.role === "sql")?.installed).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("matches the last path segment for owner/skill-style bindings", async () => {
    writeWorkspaceToml('[skills]\nui-design = "acme/figma-spec"\n');
    installSkill(".agents/skills", "figma-spec");
    const resolution = await resolveSkills(fs, paths);
    const { warnings } = await checkInstalledBindings(fs, env, resolution);
    expect(warnings).toEqual([]);
  });

  it("does not warn for a role disabled with off", async () => {
    writeWorkspaceToml('[skills]\nresearch = "off"\n');
    const resolution = await resolveSkills(fs, paths);
    const { checks, warnings } = await checkInstalledBindings(fs, env, resolution);
    expect(checks.find((c) => c.role === "research")).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});
