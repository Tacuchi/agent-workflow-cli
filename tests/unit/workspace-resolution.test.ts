import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { registerHub } from "../../src/application/hub-registry.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { resolveWorkspaceDirectory } from "../../src/runtime/workspace-resolution.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const git = promisify(execFile);
const fs = new NodeFileSystem();
let temp: string | null = null;
afterEach(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
  temp = null;
});

it("desde una fuente resuelve al único hub, se niega con dos y --workspace no sube", async () => {
  temp = await mkdtemp(join(tmpdir(), "aw-resolve-"));
  const home = join(temp, "home");
  const source = join(temp, "source");
  await mkdir(home);
  await mkdir(source);
  await git("git", ["init", "-q", source]);
  const namespace = normalizeNamespace("workflow");
  const directory = {
    root: source,
    namespace,
    namespaceSource: "default" as const,
    materialized: false,
  };
  const hubA = join(temp, "hub-a");
  const hubB = join(temp, "hub-b");
  const hubs = [hubA, hubB];
  for (const hub of hubs) {
    await mkdir(join(hub, ".workflow", "sessions"), { recursive: true });
    await writeFile(join(hub, ".workflow", "workline.json"), '{"namespace":"workflow"}');
    await writeFile(
      join(hub, "AGENTS.md"),
      `<!-- WORKFLOW-HUB-START -->\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| src | ${source} | main |\n<!-- WORKFLOW-HUB-END -->`,
    );
  }
  await registerHub(fs, new PathsService(namespace, home, hubA), hubA);
  expect((await resolveWorkspaceDirectory(fs, directory, source, home)).root).toBe(
    await realpath(hubA),
  );
  await expect(
    resolveWorkspaceDirectory(fs, directory, source, home, join(hubA, "docs")),
  ).rejects.toMatchObject({ code: "HUB_INVALID" });
  await registerHub(fs, new PathsService(namespace, home, hubB), hubB);
  await expect(resolveWorkspaceDirectory(fs, directory, source, home)).rejects.toMatchObject({
    code: "HUB_AMBIGUOUS",
    roots: await Promise.all(hubs.map((hub) => realpath(hub))),
  });
  expect((await resolveWorkspaceDirectory(fs, directory, source, home, hubB)).root).toBe(
    await realpath(hubB),
  );
});
