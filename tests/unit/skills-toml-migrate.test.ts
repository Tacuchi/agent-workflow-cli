import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { skillsProvider } from "../../src/application/doctor/provider-skills.js";
import { runDoctor } from "../../src/application/doctor/report.js";
import { migrateSkillsToml } from "../../src/application/doctor/skills-toml-migrate.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";

it("migra tres generaciones de plantilla sin perder binding ni comentarios elegidos por la persona", () => {
  const legacy = `# reglas de mi equipo
[skills]
# ui-design = "manual" (comentado, no tocar)
ui-design = "ui-spec" # viejo
overview = "workflow"
git = "mi-skill" # mi binding
coding-standards = "standards"
writing = "write"
testing = "test"
tools = "misc"

[compaction]
mode = "antiguo"

[otra]
valor = "se conserva"
`;
  const current = migrateSkillsToml(legacy);
  expect(current.changed).toBe(true);
  expect(current.text).toContain('design = "design" # viejo');
  expect(current.text).toContain('overview = "w"');
  expect(current.text).toContain('git = "mi-skill" # mi binding');
  expect(current.text).toContain('# ui-design = "manual" (comentado, no tocar)');
  expect(current.text).toContain('valor = "se conserva"');
  expect(current.text).not.toContain("[compaction]");
  for (const role of ["coding-standards", "writing", "testing", "tools"])
    expect(current.text).not.toContain(`${role} =`);
  expect(migrateSkillsToml(current.text)).toEqual({ text: current.text, changed: false });
});

it("no pisa un design propio al retirar ui-design de una plantilla vieja", () => {
  const legacy = '[skills]\ndesign = "mi-design" # mío\nui-design = "ui-spec"\n';
  expect(migrateSkillsToml(legacy).text).toBe('[skills]\ndesign = "mi-design" # mío\n');
});

it("un design de otra tabla no borra el binding ui-design que debe migrarse", () => {
  const old = '[skills]\nui-design = "mi-skill"\n\n[otra]\ndesign = "dato ajeno"\n';
  expect(migrateSkillsToml(old).text).toBe(
    '[skills]\ndesign = "mi-skill"\n\n[otra]\ndesign = "dato ajeno"\n',
  );
});

it("doctor no propone migrar skills.toml históricos ni altera sus bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-doctor-skills-toml-"));
  try {
    const fs = new NodeFileSystem();
    const home = join(root, "home");
    const paths = new PathsService(normalizeNamespace("agent-workflow"), home, root);
    const path = paths.cwdSkillsToml();
    const global = paths.userSkillsToml();
    await fs.mkdirp(dirname(path));
    await fs.mkdirp(dirname(global));
    await fs.writeText(
      path,
      '[skills]\nui-design = "ui-spec"\noverview = "workflow"\ngit = "mi-skill" # propio\n\n[compaction]\nmode = "antiguo"\n',
    );
    await fs.writeText(global, '[skills]\noverview = "workflow"\ngit = "otro-binding"\n');
    const ctx = {
      fs,
      paths,
      env: new FakeEnv(home, root),
      process: new FakeProcess(),
    } as CliContext;
    const deps = { providers: [skillsProvider] };
    const report = await runDoctor(ctx, {}, deps);
    const notices = report.findings.filter((item) => item.category === "skills");
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((item) => item.resource.kind === "binding")).toBe(true);
    expect(notices.every((item) => item.remediation.action === null)).toBe(true);
    const text = await readFile(path, "utf8");
    expect(text).toContain('ui-design = "ui-spec"');
    expect(text).toContain('overview = "workflow"');
    expect(text).toContain('git = "mi-skill" # propio');
    expect(text).toContain("[compaction]");
    const user = await readFile(global, "utf8");
    expect(user).toContain('overview = "workflow"');
    expect(user).toContain('git = "otro-binding"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
