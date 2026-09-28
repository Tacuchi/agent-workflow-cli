import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { skillsProvider } from "../../src/application/doctor/provider-skills.js";
import { runDoctor } from "../../src/application/doctor/report.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";

it("doctor advierte bindings históricos sin ofrecer migración ni tocar sus archivos", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-doctor-legacy-binding-"));
  try {
    const fs = new NodeFileSystem();
    const home = join(root, "home");
    const paths = new PathsService(normalizeNamespace("workflow"), home, root);
    const workspaceFile = paths.cwdSkillsToml();
    const globalFile = paths.userSkillsToml();
    await fs.mkdirp(dirname(workspaceFile));
    await fs.mkdirp(dirname(globalFile));
    const workspace =
      '[skills]\ndesign = "vendor/design"\ngit = "mi-skill"\n[docs]\nspecs = "docs/specs"\n';
    const global = '[skills]\noverview = "vendor/w"\n';
    await fs.writeText(workspaceFile, workspace);
    await fs.writeText(globalFile, global);
    const ctx = {
      fs,
      paths,
      env: new FakeEnv(home, root),
      process: new FakeProcess(),
    } as CliContext;
    const report = await runDoctor(ctx, {}, { providers: [skillsProvider] });
    const notices = report.findings.filter((item) => item.category === "skills");
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((item) => item.resource.kind === "binding")).toBe(true);
    expect(notices.every((item) => item.remediation.action === null)).toBe(true);
    expect(await readFile(workspaceFile, "utf8")).toBe(workspace);
    expect(await readFile(globalFile, "utf8")).toBe(global);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
