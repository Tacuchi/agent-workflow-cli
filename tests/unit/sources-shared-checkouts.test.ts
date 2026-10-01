import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { registerHub } from "../../src/application/hub-registry.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSources } from "../../src/application/sources-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

it("aw sources informa el otro hub y avisa cuando el checkout usa la rama ajena", async () => {
  root = await mkdtemp(join(tmpdir(), "aw-shared-sources-"));
  const home = join(root, "home");
  const repo = join(root, "source");
  const a = join(root, "hub-a");
  const b = join(root, "hub-b");
  await mkdir(home);
  await mkdir(repo);
  await promisify(execFile)("git", ["init", "-q", "-b", "main", repo]);
  await promisify(execFile)("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  await promisify(execFile)("git", ["-C", repo, "config", "user.name", "T"]);
  await writeFile(join(repo, "README.md"), "fuente\n");
  await promisify(execFile)("git", ["-C", repo, "add", "README.md"]);
  await promisify(execFile)("git", ["-C", repo, "commit", "-qm", "base"]);
  const fs = new NodeFileSystem();
  const namespace = normalizeNamespace("workflow");
  for (const [hub, branch] of [
    [a, "dev"],
    [b, "main"],
  ]) {
    await mkdir(join(hub, ".workflow", "sessions"), { recursive: true });
    await writeFile(
      join(hub, ".workflow", "workline.json"),
      '{"workline":1,"namespace":"workflow"}',
    );
    await writeFile(
      join(hub, "AGENTS.md"),
      `<!-- WORKFLOW-PROJECT-START -->\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| src | ${repo} | main |\n## Status\n- Ramas de trabajo actuales:\n  - src: ${branch}\n<!-- WORKFLOW-PROJECT-END -->`,
    );
    await registerHub(fs, new PathsService(namespace, home, hub), hub);
  }
  const output = await runSources(
    fs,
    new FakeEnv(home, a),
    new GitCliAdapter(new NodeProcess()),
    new PathsService(namespace, home, a),
    {},
  );
  expect(output.sources[0]?.other_hubs).toMatchObject([{ working_branch: "main" }]);
  expect(output.sources[0]?.shared_branch_warning).toContain(
    "checkout está en la rama de trabajo de otro workspace",
  );
});
