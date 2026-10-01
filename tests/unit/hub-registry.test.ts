import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  declaringHubs,
  hubsFile,
  readHubs,
  registerHub,
} from "../../src/application/hub-registry.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const git = promisify(execFile);
const fs = new NodeFileSystem();
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("registro de hubs por checkout", () => {
  it("consulta dos hubs sin escribir en la fuente y conserva el registro si es ilegible", async () => {
    const root = await mkdtemp(join(tmpdir(), "aw-hubs-"));
    roots.push(root);
    const home = join(root, "home");
    const repo = join(root, "source");
    await mkdir(home);
    await mkdir(repo);
    await git("git", ["init", "-q", repo]);
    for (const [name, branch] of [
      ["hub-a", "develop"],
      ["hub-b", "review"],
    ]) {
      const hub = join(root, name);
      await mkdir(join(hub, ".workflow"), { recursive: true });
      await writeFile(join(hub, ".workflow", "workline.json"), '{"namespace":"workflow"}');
      await writeFile(
        join(hub, "AGENTS.md"),
        `<!-- WORKFLOW-HUB-START -->\n## Fuentes\n| Alias | Path | Rama principal | Rama de trabajo |\n|---|---|---|---|\n| src | ${repo} | main | ${branch} |\n## Status\n- Ramas de trabajo actuales:\n  - src: ${branch}\n<!-- WORKFLOW-HUB-END -->`,
      );
      await registerHub(fs, new PathsService(normalizeNamespace("workflow"), home, hub), hub);
    }
    const before = await git("git", ["-C", repo, "status", "--porcelain"]);
    expect(await declaringHubs(fs, home, "workflow", repo)).toMatchObject([
      { alias: "src", workingBranch: "develop" },
      { alias: "src", workingBranch: "review" },
    ]);
    expect((await git("git", ["-C", repo, "status", "--porcelain"])).stdout).toBe(before.stdout);
    expect(await readHubs(hubsFile(home, "workflow"))).toHaveLength(2);
    await writeFile(hubsFile(home, "workflow"), "broken");
    await expect(readHubs(hubsFile(home, "workflow"))).rejects.toThrow("ilegible");
    expect(await readFile(hubsFile(home, "workflow"), "utf8")).toBe("broken");
  });

  it("recupera un candado vencido y poda hubs borrados en la siguiente escritura", async () => {
    const root = await mkdtemp(join(tmpdir(), "aw-hubs-stale-"));
    roots.push(root);
    const home = join(root, "home");
    const a = join(root, "hub-a");
    const b = join(root, "hub-b");
    await mkdir(join(home, ".workflow"), { recursive: true });
    await mkdir(a);
    await mkdir(b);
    const file = hubsFile(home, "workflow");
    await writeFile(
      `${file}.lock`,
      JSON.stringify({ pid: 999999, ts: "2000-01-01T00:00:00.000Z" }),
    );
    const namespace = normalizeNamespace("workflow");
    await registerHub(fs, new PathsService(namespace, home, a), a);
    expect(await readHubs(file)).toEqual([await realpath(a)]);
    await rm(a, { recursive: true });
    await registerHub(fs, new PathsService(namespace, home, b), b);
    expect(await readHubs(file)).toEqual([await realpath(b)]);
  });
});
