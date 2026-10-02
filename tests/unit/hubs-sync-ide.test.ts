import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runHubsSync } from "../../src/application/hubs-sync-service.js";
import { worklineMarkerContent } from "../../src/runtime/workline-marker.js";

/** `aw hubs sync --ide` over a temporary HOME (plan 089 F1). */

const CLI = resolve(__dirname, "..", "..", "dist", "cli", "main.js");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aw-hubs-sync-ide-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".workflow"), { recursive: true });
  const hub = (path: string, fuentes?: string[]) => {
    mkdirSync(join(path, ".workflow", "sessions"), { recursive: true });
    writeFileSync(join(path, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
    if (fuentes !== undefined) {
      writeFileSync(
        join(path, "AGENTS.md"),
        `<!-- WORKFLOW-HUB-START -->\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n${fuentes.join("\n")}\n<!-- WORKFLOW-HUB-END -->\n`,
      );
    }
    return path;
  };
  const register = (...paths: string[]) =>
    writeFileSync(
      join(home, ".workflow", "hubs.json"),
      JSON.stringify({ version: 1, roots: paths }),
    );
  // The fixture lives under the system temp folder; no temp roots keeps its hubs `ok`.
  const sync = (dryRun = false) =>
    runHubsSync(
      { fs: new NodeFileSystem(), home, namespace: "workflow", tempRoots: [] },
      { ide: true, herdr: false, dryRun },
    );
  return { root, home, hub, register, sync };
}

const workspace = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("aw hubs sync --ide", () => {
  it("escribe el hub y sus fuentes, relativas bajo un padre común y absolutas si sólo comparten $HOME", async () => {
    const { home, hub, register, sync } = fixture();
    const near = join(home, "git", "cli");
    mkdirSync(near, { recursive: true });
    const far = join(home, "far");
    mkdirSync(far, { recursive: true });
    const main = hub(join(home, "git", "lab", "alfa"), [
      `| cli | ${near} | main |`,
      `| far | ${far} | main |`,
      "| self | . | main |",
      "| ausente | (local) | main |",
    ]);
    const bare = hub(join(home, "beta"));
    register(main, bare);

    const out = await sync();

    expect(out.ide?.hubs).toEqual([
      {
        name: "alfa",
        root: main,
        action: "created",
        file: join(main, "alfa.code-workspace"),
        omitted_sources: [{ alias: "ausente", reason: "sin ruta local" }],
      },
      { name: "beta", root: bare, action: "created", file: join(bare, "beta.code-workspace") },
    ]);
    expect(workspace(join(main, "alfa.code-workspace")).folders).toEqual([
      { name: "alfa", path: "." },
      { name: "cli", path: join("..", "..", "cli") },
      { name: "far", path: far },
    ]);
    expect(workspace(join(bare, "beta.code-workspace")).folders).toEqual([
      { name: "beta", path: "." },
    ]);
  });

  it("conserva settings propios, no toca un archivo ilegible y un segundo sync deja los mismos bytes", async () => {
    const { root, hub, register, sync } = fixture();
    const kept = hub(join(root, "kept"), []);
    const broken = hub(join(root, "broken"), []);
    register(kept, broken);
    const keptFile = join(kept, "kept.code-workspace");
    writeFileSync(
      keptFile,
      JSON.stringify({ folders: [{ path: "old" }], settings: { "editor.tabSize": 4 } }),
    );
    const brokenFile = join(broken, "broken.code-workspace");
    writeFileSync(brokenFile, "{ // a comment\n");

    const first = await sync();
    expect(first.ide?.hubs.map((hub) => hub.action)).toEqual(["updated", "skipped"]);
    expect(first.ide?.hubs[1]?.reason).toMatch(/JSON/);
    expect(workspace(keptFile)).toEqual({
      folders: [{ name: "kept", path: "." }],
      settings: { "editor.tabSize": 4 },
    });
    expect(readFileSync(brokenFile, "utf8")).toBe("{ // a comment\n");

    const bytes = readFileSync(keptFile, "utf8");
    const second = await sync();
    expect(second.ide?.hubs.map((hub) => hub.action)).toEqual(["unchanged", "skipped"]);
    expect(readFileSync(keptFile, "utf8")).toBe(bytes);
  });

  it("ignora el archivo en el .gitignore sólo si el hub está en git", async () => {
    const { root, hub, register, sync } = fixture();
    const tracked = hub(join(root, "tracked"), []);
    const loose = hub(join(root, "loose"), []);
    expect(spawnSync("git", ["init", "-q", tracked]).status).toBe(0);
    register(tracked, loose);

    await sync();
    await sync();

    const ignore = readFileSync(join(tracked, ".gitignore"), "utf8");
    expect(ignore.split("\n").filter((line) => line === "/tracked.code-workspace")).toHaveLength(1);
    const status = spawnSync(
      "git",
      ["-C", tracked, "status", "--porcelain", "--untracked-files=all"],
      {
        encoding: "utf8",
      },
    );
    expect(status.stdout).not.toContain("tracked.code-workspace");
    expect(existsSync(join(loose, ".gitignore"))).toBe(false);
  });

  it("--dry-run no escribe nada y un hub que no está ok se salta con su estado", async () => {
    const { root, hub, register, sync } = fixture();
    const alive = hub(join(root, "alive"), []);
    expect(spawnSync("git", ["init", "-q", alive]).status).toBe(0);
    const gone = join(root, "gone");
    register(alive, gone);

    const out = await sync(true);

    expect(out).toEqual({
      dry_run: true,
      herdr: null,
      ide: {
        hubs: [
          {
            name: "alive",
            root: alive,
            action: "created",
            file: join(alive, "alive.code-workspace"),
          },
          {
            name: "gone",
            root: gone,
            action: "skipped",
            file: join(gone, "gone.code-workspace"),
            reason: "missing",
          },
        ],
      },
    });
    expect(existsSync(join(alive, "alive.code-workspace"))).toBe(false);
    expect(existsSync(join(alive, ".gitignore"))).toBe(false);
  });

  it("sin destino falla con el uso, y por el binario un hub efímero se salta", () => {
    const { root, home, hub, register } = fixture();
    const scratch = hub(join(root, "scratch"), []);
    register(scratch);
    const aw = (...args: string[]) =>
      spawnSync(process.execPath, [CLI, "hubs", "sync", ...args, "--format", "json"], {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home, AW_NAMESPACE: "workflow" },
      });

    const bare = aw();
    expect(bare.status).not.toBe(0);
    expect(JSON.parse(bare.stdout).error.code).toBe("INVALID_INPUT");

    const run = aw("--ide");
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).ide.hubs).toEqual([
      expect.objectContaining({ name: "scratch", action: "skipped", reason: "ephemeral" }),
    ]);
    expect(existsSync(join(scratch, "scratch.code-workspace"))).toBe(false);
  });
});
