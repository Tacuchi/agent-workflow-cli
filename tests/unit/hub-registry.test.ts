import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  declaringHubs,
  hubNames,
  hubState,
  hubsFile,
  isEphemeralRoot,
  listRegisteredHubs,
  pruneHubs,
  readHubs,
  registerHub,
  registerScannedHubs,
  scanHubs,
  systemTempRoots,
} from "../../src/application/hub-registry.js";
import { PathsService } from "../../src/application/paths-service.js";
import { registerResolvedHub } from "../../src/runtime/hub-resolution.js";
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

describe("plan 088 F2 · estado, nombre, poda y raíces efímeras", () => {
  const namespace = normalizeNamespace("workflow");

  async function tree() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "aw-hubs-f2-")));
    roots.push(root);
    const home = join(root, "home");
    await mkdir(home);
    const hub = async (path: string) => {
      await mkdir(join(path, ".workflow"), { recursive: true });
      await writeFile(join(path, ".workflow", "workline.json"), '{"workline":1}');
      return path;
    };
    return { root, home, hub };
  }

  it("juzga ok, missing, not-a-hub y ephemeral, y nombra por carpeta", async () => {
    const { root, home, hub } = await tree();
    const ok = await hub(join(root, "stable", "alfa"));
    const ephemeral = await hub(join(root, "scratch", "beta"));
    const lost = await hub(join(root, "stable", "gamma"));
    const gone = await hub(join(root, "stable", "delta"));
    for (const path of [ok, ephemeral, lost, gone]) {
      await registerHub(fs, new PathsService(namespace, home, path), path);
    }
    await rm(join(lost, ".workflow", "workline.json"));
    await rm(gone, { recursive: true });
    const temp = [join(root, "scratch")];
    expect(await listRegisteredHubs(fs, home, "workflow", temp)).toEqual([
      { name: "alfa", root: ok, state: "ok" },
      { name: "beta", root: ephemeral, state: "ephemeral" },
      { name: "gamma", root: lost, state: "not-a-hub" },
      { name: "delta", root: gone, state: "missing" },
    ]);
    expect(await hubState(fs, ok, "workflow", [root])).toBe("ephemeral");
  });

  it("dos hubs con la misma carpeta se nombran <padre>/<carpeta>", () => {
    expect([...hubNames(["/a/uno/app", "/a/dos/app", "/a/otro"]).values()]).toEqual([
      "uno/app",
      "dos/app",
      "otro",
    ]);
  });

  it("prune quita las raíces borradas, sin marcador y efímeras, y conserva las sanas", async () => {
    const { root, home, hub } = await tree();
    const ok = await hub(join(root, "stable", "alfa"));
    const ephemeral = await hub(join(root, "scratch", "beta"));
    const lost = await hub(join(root, "stable", "gamma"));
    for (const path of [ok, ephemeral, lost]) {
      await registerHub(fs, new PathsService(namespace, home, path), path);
    }
    await rm(join(lost, ".workflow", "workline.json"));
    const removed = await pruneHubs(fs, home, "workflow", [join(root, "scratch")]);
    expect(removed.map((hub) => [hub.root, hub.state])).toEqual([
      [ephemeral, "ephemeral"],
      [lost, "not-a-hub"],
    ]);
    expect(await readHubs(hubsFile(home, "workflow"))).toEqual([ok]);
  });

  it("el registro implícito no agrega un hub bajo el temporal del sistema", async () => {
    const { root, home, hub } = await tree();
    const scratch = await hub(join(root, "copia"));
    expect(isEphemeralRoot(scratch, await systemTempRoots())).toBe(true);
    const warning = await registerResolvedHub(fs, home, {
      root: scratch,
      namespace,
    } as Parameters<typeof registerResolvedHub>[2]);
    expect(warning).toBeNull();
    expect(await readHubs(hubsFile(home, "workflow"))).toEqual([]);
  });

  it("scan propone hubs por marcador y por la vía legacy, rechaza un .workflow suelto y respeta el límite", async () => {
    const { root, home, hub } = await tree();
    const marked = await hub(join(root, "projects", "alfa"));
    const legacy = join(root, "projects", "legado");
    await mkdir(join(legacy, ".workflow", "sessions"), { recursive: true });
    await writeFile(join(legacy, ".workflow", "HISTORY.md"), "# Session History\n");
    const loose = join(root, "projects", "suelto");
    await mkdir(join(loose, ".workflow"), { recursive: true });
    await writeFile(join(loose, ".workflow", "HISTORY.md"), "# Session History\n");
    await hub(join(root, "projects", "app", "node_modules", "pkg"));
    await hub(join(root, "projects", "a", "b", "c", "lejos"));
    const known = await hub(join(root, "projects", "conocido"));
    await registerHub(fs, new PathsService(namespace, home, known), known);
    const before = await readFile(hubsFile(home, "workflow"), "utf8");

    const scan = await scanHubs(fs, home, "workflow", [join(root, "projects")]);
    expect(scan.found.sort()).toEqual([marked, legacy].sort());
    expect(scan.registered).toEqual([known]);
    expect(scan.skipped.map((skip) => skip.path)).toEqual([loose]);
    expect(await readFile(hubsFile(home, "workflow"), "utf8")).toBe(before);

    expect((await scanHubs(fs, home, "workflow", [])).registered).toEqual([known]);
    await registerScannedHubs(fs, home, "workflow", scan.found);
    expect((await readHubs(hubsFile(home, "workflow"))).sort()).toEqual(
      [known, marked, legacy].sort(),
    );
  });
});
