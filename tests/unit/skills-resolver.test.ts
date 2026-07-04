import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { resolveSkills } from "../../src/application/skills-resolver-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("resolveSkills (skills.toml cascade)", () => {
  let home: string;
  let cwd: string;
  let paths: PathsService;
  const fs = new NodeFileSystem();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skills-home-"));
    cwd = mkdtempSync(join(tmpdir(), "skills-cwd-"));
    paths = new PathsService(normalizeNamespace("workflow"), home, cwd);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function writeGlobal(toml: string): void {
    mkdirSync(join(home, ".workflow"), { recursive: true });
    writeFileSync(paths.userSkillsToml(), toml);
  }
  function writeWorkspace(toml: string): void {
    mkdirSync(join(cwd, ".workflow"), { recursive: true });
    writeFileSync(paths.cwdSkillsToml(), toml);
  }

  it("sin skills.toml → todos los built-in default", async () => {
    const { skills, sources, warnings } = await resolveSkills(fs, paths);
    expect(sources).toEqual({ global: false, workspace: false });
    expect(warnings).toEqual([]);
    expect(skills["ui-design"]).toEqual({
      role: "ui-design",
      skill: "ui-spec",
      source: "default",
      enabled: true,
    });
    expect(skills.overview.skill).toBe("w");
    expect(skills.sql).toEqual({ role: "sql", skill: "sql", source: "default", enabled: true });
    expect(skills.git.skill).toBe("git");
  });

  it("las convenciones genéricas NO son roles (las auto-descubre el host, no el workflow)", async () => {
    // coding-standards/testing/writing salieron del sistema de roles: el workflow es
    // indiferente y el host las auto-aplica si están instaladas. Nombrarlas en skills.toml
    // → rol desconocido (warning), no rompe la resolución.
    writeWorkspace('[skills]\ncoding-standards = "x"\ntesting = "y"\nsql = "ws-sql"\n');
    const { skills, warnings } = await resolveSkills(fs, paths);
    expect(warnings.some((w) => w.includes("coding-standards"))).toBe(true);
    expect(warnings.some((w) => w.includes("testing"))).toBe(true);
    expect(Object.keys(skills)).not.toContain("coding-standards");
    expect(skills.sql.skill).toBe("ws-sql");
  });

  it("workspace bindea un rol a una skill de tercero", async () => {
    writeWorkspace('[skills]\nui-design = "acme/figma-spec"\n');
    const { skills, sources } = await resolveSkills(fs, paths);
    expect(sources.workspace).toBe(true);
    expect(skills["ui-design"]).toEqual({
      role: "ui-design",
      skill: "acme/figma-spec",
      source: "workspace",
      enabled: true,
    });
    // los demás siguen en default
    expect(skills.sql.source).toBe("default");
  });

  it("workspace pisa a global (cascada)", async () => {
    writeGlobal('[skills]\nsql = "global-sql"\ngit = "global-git"\n');
    writeWorkspace('[skills]\nsql = "ws-sql"\n');
    const { skills, sources } = await resolveSkills(fs, paths);
    expect(sources).toEqual({ global: true, workspace: true });
    expect(skills.sql).toEqual({
      role: "sql",
      skill: "ws-sql",
      source: "workspace",
      enabled: true,
    });
    // git solo en global
    expect(skills.git).toEqual({
      role: "git",
      skill: "global-git",
      source: "global",
      enabled: true,
    });
  });

  it('"off" desactiva la capacidad', async () => {
    writeWorkspace('[skills]\nresearch = "off"\n');
    const { skills } = await resolveSkills(fs, paths);
    expect(skills.research).toEqual({
      role: "research",
      skill: null,
      source: "workspace",
      enabled: false,
    });
  });

  it("`tools` ya NO es un rol (se removió la capability)", async () => {
    const { skills } = await resolveSkills(fs, paths);
    expect(Object.keys(skills)).not.toContain("tools");
    // Nombrarlo en skills.toml → rol desconocido (warning), no rompe la resolución.
    writeWorkspace('[skills]\ntools = "off"\nsql = "ws-sql"\n');
    const res = await resolveSkills(fs, paths);
    expect(res.warnings.some((w) => w.includes("tools"))).toBe(true);
    expect(Object.keys(res.skills)).not.toContain("tools");
    expect(res.skills.sql.skill).toBe("ws-sql");
  });

  it("rol desconocido → warning e ignorado", async () => {
    writeWorkspace('[skills]\nfrobnicate = "x"\nsql = "ws-sql"\n');
    const { skills, warnings } = await resolveSkills(fs, paths);
    expect(warnings.some((w) => w.includes("frobnicate"))).toBe(true);
    expect(skills.sql.skill).toBe("ws-sql");
    // ningún rol espurio aparece
    expect(Object.keys(skills)).not.toContain("frobnicate");
  });

  it("toml malformado → warning, no crashea, mantiene defaults", async () => {
    writeWorkspace("[skills]\nthis is not = = valid toml\n");
    const { skills, warnings } = await resolveSkills(fs, paths);
    expect(warnings.some((w) => w.includes("parse error"))).toBe(true);
    expect(skills.sql.source).toBe("default");
  });
});
