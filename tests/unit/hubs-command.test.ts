import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { worklineMarkerContent } from "../../src/runtime/workline-marker.js";

/** `aw hubs` through the binary (plan 088 F2). Run after `npm run build`. */

const CLI = resolve(__dirname, "..", "..", "dist", "cli", "main.js");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aw-hubs-cmd-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".workflow"), { recursive: true });
  const hub = (name: string) => {
    const path = join(root, "projects", name);
    mkdirSync(join(path, ".workflow", "sessions"), { recursive: true });
    writeFileSync(join(path, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
    return path;
  };
  const register = (...paths: string[]) =>
    writeFileSync(
      join(home, ".workflow", "hubs.json"),
      `${JSON.stringify({ version: 1, roots: paths }, null, 2)}\n`,
    );
  const registry = () => readFileSync(join(home, ".workflow", "hubs.json"), "utf8");
  const aw = (cwd: string, ...args: string[]) => {
    const run = spawnSync(process.execPath, [CLI, "hubs", ...args, "--format", "json"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, AW_NAMESPACE: "workflow" },
    });
    expect(run.status, run.stderr || run.stdout).toBe(0);
    return JSON.parse(run.stdout);
  };
  return { root, home, hub, register, registry, aw };
}

describe("aw hubs", () => {
  it("lista desde $HOME cada raíz con su nombre y su estado, sin escribir", () => {
    const { root, home, hub, register, registry, aw } = fixture();
    const alive = hub("alfa");
    const gone = join(root, "projects", "borrado");
    register(alive, gone);
    const before = registry();
    expect(aw(home)).toEqual({
      action: "list",
      hubs: [
        { name: "alfa", root: alive, state: "ephemeral" },
        { name: "borrado", root: gone, state: "missing" },
      ],
    });
    expect(registry()).toBe(before);
    expect(() => readFileSync(join(home, ".workflow", "workline.json"))).toThrow();
  });

  it("scan sólo propone, y con --apply registra por la escritura del registro", () => {
    const { root, home, hub, register, registry, aw } = fixture();
    const known = hub("conocido");
    const fresh = hub("nuevo");
    register(known);
    const before = registry();
    const proposed = aw(home, "scan", join(root, "projects"));
    expect(proposed).toMatchObject({ applied: false, found: [fresh], registered: [known] });
    expect(registry()).toBe(before);
    expect(aw(home, "scan", join(root, "projects"), "--apply")).toMatchObject({ applied: true });
    expect(JSON.parse(registry()).roots).toEqual([known, fresh]);
  });

  it("prune quita las raíces borradas y las efímeras y devuelve cada una con su estado", () => {
    const { root, home, hub, register, registry, aw } = fixture();
    const scratch = hub("copia");
    const gone = join(root, "projects", "borrado");
    register(scratch, gone);
    expect(aw(home, "prune").removed).toEqual([
      { name: "copia", root: scratch, state: "ephemeral" },
      { name: "borrado", root: gone, state: "missing" },
    ]);
    expect(JSON.parse(registry()).roots).toEqual([]);
  });
});
