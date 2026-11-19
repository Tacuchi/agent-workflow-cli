import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const entry = resolve("dist/cli/main.js");
const roots: string[] = [];

function fixture(): { cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "aw-hook-entry-"));
  roots.push(root);
  const cwd = join(root, "project", "nested");
  // The child resolves its cwd (macOS /var → /private/var); HOME must name the same path.
  const home = join(realpathSync(root), "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home);
  return { cwd, home };
}

function run(cwd: string, home: string, args: string[], payload?: unknown) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    input: payload === undefined ? "" : JSON.stringify(payload),
    env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" },
  });
}

function errorCode(stdout: string): string | undefined {
  try {
    return (JSON.parse(stdout) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SQL_CALL = { tool_name: "mcp__db__execute_sql", tool_input: { sql: "DELETE FROM data" } };

describe("entrada delgada del dist construido", () => {
  it("un hook que un host anterior sigue llamando responde como un comando desconocido", () => {
    const { cwd, home } = fixture();
    const hub = join(cwd, "..", "hub");
    mkdirSync(hub);
    expect(run(hub, home, ["hub-init", "--json"]).status).toBe(0);
    const places = { "en un hub": hub, "fuera de un hub": cwd, "en $HOME": home };
    for (const [place, where] of Object.entries(places)) {
      const unknown = run(where, home, ["nopecmd"]);
      for (const args of [
        ["hook", "sql-mutation-guard"],
        ["hook", "--namespace", "workflow", "sql-mutation-guard"],
        ["hook", "pre-compact"],
        ["hook"],
      ]) {
        const result = run(where, home, args, SQL_CALL);
        expect([place, args, result.status, errorCode(result.stdout)]).toEqual([
          place,
          args,
          unknown.status,
          errorCode(unknown.stdout),
        ]);
        expect(result.status).toBe(1);
      }
    }
  });

  it("no materializa un proyecto ni crea configuración de usuario sin marcador", () => {
    const { cwd, home } = fixture();
    for (const args of [["checkpoint-write"], ["self", "namespace", "--pin", "workflow"]]) {
      const result = run(cwd, home, args);
      expect([args, result.status, result.stdout, result.stderr]).toEqual([args, 0, "", ""]);
    }
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(join(cwd, ".workflow"))).toBe(false);
  });
});
