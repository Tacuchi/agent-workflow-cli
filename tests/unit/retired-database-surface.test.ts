import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const entry = resolve("dist/cli/main.js");
const roots: string[] = [];

function fixture(): { root: string; hub: string; home: string } {
  // The child resolves its cwd (macOS /var → /private/var); HOME must name the same path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aw-retired-db-")));
  roots.push(root);
  const hub = join(root, "hub");
  const home = join(root, "home");
  mkdirSync(hub);
  mkdirSync(home);
  return { root, hub, home };
}

function run(cwd: string, home: string, args: string[], input = "") {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    input,
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

describe("la superficie de base de datos ya no existe", () => {
  it("mcp, tool y hook responden como un comando desconocido, y self mcp como una acción desconocida", () => {
    const { hub, home } = fixture();
    expect(run(hub, home, ["hub-init", "--json"]).status).toBe(0);
    const unknown = run(hub, home, ["nopecmd", "--json"]);
    expect([unknown.status, errorCode(unknown.stdout)]).toEqual([1, "UNKNOWN_COMMAND"]);
    for (const args of [
      ["mcp", "list"],
      ["mcp", "serve"],
      ["tool", "call", "--connection", "x"],
      ["hook", "sql-mutation-guard"],
    ]) {
      const result = run(hub, home, [...args, "--json"]);
      expect([args, result.status, errorCode(result.stdout)]).toEqual([
        args,
        unknown.status,
        errorCode(unknown.stdout),
      ]);
    }
    const unknownAction = run(hub, home, ["self", "nope", "--json"]);
    const selfMcp = run(hub, home, ["self", "mcp", "--json"]);
    expect(unknownAction.status).toBe(1);
    expect([selfMcp.status, errorCode(selfMcp.stdout)]).toEqual([
      unknownAction.status,
      errorCode(unknownAction.stdout),
    ]);
  });

  it("export-scripts rechaza --catalog como opción desconocida", () => {
    const { hub, home } = fixture();
    expect(run(hub, home, ["hub-init", "--json"]).status).toBe(0);
    const result = run(hub, home, ["export-scripts", "prepare", "--catalog", "db", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("--catalog");
    expect(errorCode(result.stdout)).toBe("UNKNOWN_FLAG");
  });

  it("un host con el descriptor dbhub y el dsn.env anteriores recibe un comando desconocido y nada los toca", () => {
    const { root, home } = fixture();
    const dev = join(home, ".workflow", "dev");
    mkdirSync(dev, { recursive: true });
    const dsnFile = join(dev, "dsn.env");
    writeFileSync(dsnFile, "PRUEBA_DSN=mysql://usuario:clave@127.0.0.1:9/prueba\n", "utf8");
    const descriptor = join(home, ".claude.json");
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        mcpServers: { prueba: { command: "agent-workflow", args: ["mcp", "dbhub", "prueba"] } },
      })}\n`,
    );
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const before = { dsn: hash(dsnFile), descriptor: hash(descriptor) };

    const launched = run(root, home, ["mcp", "dbhub", "prueba"]);
    expect([launched.status, errorCode(launched.stdout)]).toEqual([1, "UNKNOWN_COMMAND"]);

    const doctor = run(root, home, ["doctor", "--json", "--detail"]);
    expect(doctor.stdout).not.toContain("dsn.env");
    expect(doctor.stdout).not.toMatch(/\bprueba\b/);
    expect({ dsn: hash(dsnFile), descriptor: hash(descriptor) }).toEqual(before);
  });

  it("doctor sobre una configuración limpia no tiene categorías de MCP ni de autenticación", () => {
    const { root, home } = fixture();
    const result = run(root, home, ["doctor", "--json", "--detail"]);
    const report = JSON.parse(result.stdout) as {
      coverage: { category: string }[];
      findings: { category: string; remediation: { action: { op: string } | null } }[];
    };
    const categories = new Set([
      ...report.coverage.map((row) => row.category),
      ...report.findings.map((finding) => finding.category),
    ]);
    expect(categories.has("mcps")).toBe(false);
    expect(categories.has("tools-auth")).toBe(false);
    const ops = report.findings.flatMap((finding) =>
      finding.remediation.action === null ? [] : [finding.remediation.action.op],
    );
    expect(ops.filter((op) => op.startsWith("mcp.") || op.startsWith("auth."))).toEqual([]);
  });
});
