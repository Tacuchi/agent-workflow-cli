import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const entry = resolve("dist/cli/main.js");
const roots: string[] = [];

function fixture(): { cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "aw-hook-entry-"));
  roots.push(root);
  const cwd = join(root, "project", "nested");
  const home = join(root, "home");
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("entrada delgada del dist construido", () => {
  it("los hooks Git retirados no tienen alias ejecutable ni materializan un host", () => {
    const { cwd, home } = fixture();
    for (const hook of ["git-commit-advisor", "branch-check", "turn-start"]) {
      const result = run(cwd, home, ["hook", hook]);
      expect(result.status, hook).toBe(1);
      expect(result.stdout, hook).toContain("unknown subcommand");
    }
    expect(readdirSync(home)).toEqual([]);
  });

  it("no materializa un proyecto ni crea configuración de usuario sin marcador", () => {
    const { cwd, home } = fixture();
    for (const args of [
      ["checkpoint-write"],
      ["hook", "pre-compact"],
      ["hook", "post-compact"],
      ["hook", "session-end"],
      ["self", "namespace", "--pin", "workflow"],
    ]) {
      const result = run(cwd, home, args);
      expect([args, result.status, result.stdout, result.stderr]).toEqual([args, 0, "", ""]);
    }
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(join(cwd, ".workflow"))).toBe(false);
  });

  it("mantiene la guarda SQL activa sin marcador", () => {
    const { cwd, home } = fixture();
    const config = join(home, ".workflow", "agent-workflow");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, "runtime.json"),
      JSON.stringify({
        packageName: "@tacuchi/agent-workflow-cli",
        binName: "agent-workflow",
        mcpGuards: {
          sqlMutation: { toolPattern: "^mcp__.+__execute_sql$", serverPattern: "^mcp__(.+?)__" },
        },
      }),
    );
    const result = run(cwd, home, ["hook", "sql-mutation-guard"], {
      tool_name: "mcp__unknown__execute_sql",
      tool_input: { sql: "DELETE FROM data" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("DELETE");
  });
});
