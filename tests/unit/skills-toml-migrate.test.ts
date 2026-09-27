import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { applyDoctorBatch } from "../../src/application/doctor/apply.js";
import { prepareDoctorBatch } from "../../src/application/doctor/prepare.js";
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

it("doctor prepara y aplica con digest la migración sin perder el binding de git", async () => {
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
    const finding = report.findings.find((item) => item.resource.locator === path);
    expect(finding?.remediation.action?.op).toBe("skills.migrate-template");
    if (finding === undefined) throw new Error("skills.toml no fue detectado");
    const globalFinding = report.findings.find((item) => item.resource.locator === global);
    if (globalFinding === undefined) throw new Error("skills.toml global no fue detectado");
    const selected = [finding.id, globalFinding.id];
    const prepared = await prepareDoctorBatch(ctx, { select: selected }, deps);
    if (!prepared.ok || prepared.kind !== "sealed")
      throw new Error("prepare no selló la migración");
    expect(prepared.proposal.read_set.map((item) => item.id)).toContain(path);
    expect(prepared.proposal.read_set.map((item) => item.id)).toContain(global);
    const applied = await applyDoctorBatch(
      ctx,
      { select: selected, approval: prepared.proposal.digest },
      deps,
    );
    if (!applied.ok) throw new Error(applied.rejection.message);
    expect(applied.result.actions.map((action) => action.status)).toEqual(["applied", "applied"]);
    const text = await readFile(path, "utf8");
    expect(text).toContain('design = "design"');
    expect(text).toContain('overview = "w"');
    expect(text).toContain('git = "mi-skill" # propio');
    expect(text).not.toContain("[compaction]");
    const user = await readFile(global, "utf8");
    expect(user).toContain('overview = "w"');
    expect(user).toContain('git = "otro-binding"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
