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

  describe("plan 088 F7 · la guarda es el primer posicional de hook (N7)", () => {
    function guarded(): { cwd: string; home: string } {
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
      return { cwd, home };
    }
    const call = (sql: string) => ({ tool_name: "mcp__x__execute_sql", tool_input: { sql } });

    it("con flags antes del nombre, bloquea una mutación y deja pasar una lectura", () => {
      const { cwd, home } = guarded();
      const args = ["hook", "--namespace", "workflow", "sql-mutation-guard"];
      const blocked = run(cwd, home, args, call("DELETE FROM data"));
      expect([blocked.status, blocked.stderr]).toEqual([2, expect.stringContaining("DELETE")]);
      expect(run(cwd, home, args, call("SELECT 1")).status).toBe(0);
    });

    it.each([[["hook", "sql-mutation-guard"]], [["--json", "hook", "sql-mutation-guard"]]])(
      "si el CLI completo no carga, %j sale con 2",
      (args) => {
        const { cwd, home } = guarded();
        const loader = resolve("tests/helpers/deny-full-cli-loader.mjs");
        const result = spawnSync(
          process.execPath,
          ["--no-warnings", "--experimental-loader", loader, entry, ...args],
          {
            cwd,
            encoding: "utf8",
            input: JSON.stringify(call("DELETE FROM data")),
            env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" },
          },
        );
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("la guarda SQL no pudo evaluar la llamada");
      },
    );

    it("'hook' como valor de un flag previo no corre el destino", () => {
      const { cwd, home } = guarded();
      const args = ["--hub", "hook", "hook", "sql-mutation-guard"];
      expect(run(cwd, home, args, call("DELETE FROM t")).status).toBe(2);
    });

    it("un flag sin su valor no saca a la guarda de la falla cerrada", () => {
      const { cwd, home } = guarded();
      const result = run(
        cwd,
        home,
        ["hook", "sql-mutation-guard", "--compat"],
        call("DELETE FROM t"),
      );
      expect(result.status).toBe(2);
    });

    it("un hook de ciclo de vida con un flag sin valor sigue mudo fuera de un hub", () => {
      const { cwd, home } = fixture();
      const result = run(cwd, home, ["hook", "pre-compact", "--compat"]);
      expect([result.status, result.stdout, result.stderr]).toEqual([0, "", ""]);
    });
  });
});
