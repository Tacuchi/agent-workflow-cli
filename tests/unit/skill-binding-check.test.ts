import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { resolveSkills } from "../../src/application/skills-resolver-service.js";
import { skillsCommand } from "../../src/cli/commands/skills.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { HumanRenderContext } from "../../src/cli/registry.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

it("un binding legacy avisa sin escanear, reescribir ni dar crédito a una instalación ajena", async () => {
  root = mkdtempSync(join(tmpdir(), "binding-legacy-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const paths = new PathsService(normalizeNamespace("workflow"), home, cwd);
  mkdirSync(join(home, ".workflow"), { recursive: true });
  mkdirSync(join(cwd, ".workflow"), { recursive: true });
  const old = '[skills]\ndesign = "acme/figma-spec"\nsql = "off"\n[docs]\nspecs = "docs/specs"\n';
  writeFileSync(paths.userSkillsToml(), old);
  writeFileSync(paths.cwdSkillsToml(), '[skills]\ndesign = "off"\n');
  const without = await resolveSkills(new NodeFileSystem(), paths);
  const foreign = join(home, ".agents", "skills", "figma-spec");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "SKILL.md"), "---\nname: figma-spec\ndescription: foreign\n---\n");
  const withForeign = await resolveSkills(new NodeFileSystem(), paths);
  expect(withForeign).toEqual(without);
  expect(withForeign.skills.design.enabled).toBe(false);
  expect(withForeign.warnings).toEqual(
    expect.arrayContaining([expect.stringContaining("binding externo no aplicable")]),
  );
  expect(readFileSync(paths.userSkillsToml(), "utf8")).toBe(old);
});

it("aw skills --detail muestra sólo floor y operaciones propios con HOME sin terceros", async () => {
  root = mkdtempSync(join(tmpdir(), "skills-detail-own-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const fs = new NodeFileSystem();
  const paths = new PathsService(normalizeNamespace("workflow"), home, cwd);
  const ctx = { fs, paths, env: new FakeEnv(home, cwd) } as CliContext;
  const args = { flags: new Set(), values: new Map() } as unknown as ParsedArgs;
  const result = await skillsCommand.execute(args, ctx);
  expect(result.ok).toBe(true);
  expect(result.data?.capabilities[0]).toMatchObject({
    capability: "design",
    floor: { builtin: true, running: true },
    state: "ready",
  });
  expect(result.data?.capabilities[0]?.operations.map((op) => op.operation)).toEqual([
    "create",
    "update",
    "validate",
    "render",
    "record",
  ]);
  expect(JSON.stringify(result.data)).not.toMatch(/improvements|bindingChecks|installed-inventory/);
  const human = skillsCommand.renderHuman?.(result, { detail: true } as HumanRenderContext);
  expect(human).toContain("floor propio");
  expect(human).toContain("validate");
});
