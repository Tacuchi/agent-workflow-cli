import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { resolveSkills } from "../../src/application/skills-resolver-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("cascada de capacidades propias", () => {
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
  function write(path: string, text: string): void {
    mkdirSync(join(path, ".workflow"), { recursive: true });
    writeFileSync(path === home ? paths.userSkillsToml() : paths.cwdSkillsToml(), text);
  }

  it("sin configuración sólo resuelve skills del bundle", async () => {
    const result = await resolveSkills(fs, paths);
    expect(result.sources).toEqual({ global: false, workspace: false });
    expect(result.warnings).toEqual([]);
    expect(result.skills).toEqual({
      overview: { role: "overview", skill: "w", source: "default", enabled: true },
    });
  });

  it("ignora el binding design retirado y conserva [docs] históricos byte-idénticos", async () => {
    const global = '[skills]\ndesign = "design"\n[docs]\nspecs = "docs/specs"\n';
    const local = '[skills]\ndesign = "off"\n';
    write(home, global);
    write(cwd, local);
    const result = await resolveSkills(fs, paths);
    expect(result.skills).toEqual({
      overview: { role: "overview", skill: "w", source: "default", enabled: true },
    });
    expect(result.sources).toEqual({ global: true, workspace: true });
    expect(readFileSync(paths.userSkillsToml(), "utf8")).toBe(global);
    expect(readFileSync(paths.cwdSkillsToml(), "utf8")).toBe(local);
  });

  it("ignora un binding design externo sin ofrecer una capacidad retirada", async () => {
    write(home, '[skills]\ndesign = "acme/figma-spec"\n');
    const result = await resolveSkills(fs, paths);
    expect(Object.keys(result.skills)).toEqual(["overview"]);
    expect(result.warnings).toEqual([]);
  });

  it("ignora roles históricos y errores de TOML sin romper el floor", async () => {
    write(home, '[skills]\nsql = "off"\ngit = "someone"\n');
    write(cwd, "[skills]\nnot valid = =\n");
    const result = await resolveSkills(fs, paths);
    expect(result.warnings.join(" ")).toMatch(/sql.*git.*parse error/);
    expect(Object.keys(result.skills)).toEqual(["overview"]);
  });
});
