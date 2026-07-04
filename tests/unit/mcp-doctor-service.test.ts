import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMcpDoctor } from "../../src/application/mcp-doctor-service.js";
import { runMcpSetup } from "../../src/application/mcp-setup-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

function writeDsn(paths: PathsService, lines: Record<string, string>): void {
  const file = paths.userDsnFile();
  mkdirSync(dirname(file), { recursive: true });
  const text = `${Object.entries(lines)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
  writeFileSync(file, text);
}

describe("runMcpDoctor", () => {
  let root: string;
  let env: FakeEnv;
  let paths: PathsService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-doctor-svc-"));
    env = new FakeEnv(root);
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("status=ok cuando DSN + entry MCP correctos", () => {
    writeDsn(paths, { DB_CERT_DSN: "postgres://x" });
    const setup = runMcpSetup(env, {
      hosts: ["claude"],
      instances: ["cert"],
      scope: "workspace",
      workspace: root,
    });
    if ("ok" in setup) throw new Error("setup refused");
    const result = runMcpDoctor(env, paths, {
      hosts: ["claude"],
      instances: ["cert"],
      scope: "workspace",
      workspace: root,
    });
    expect(result.summary.ok).toBe(1);
    expect(result.reports[0]?.status).toBe("ok");
  });

  it("status=missing-mcp cuando DSN existe pero entry no", () => {
    writeDsn(paths, { DB_CERT_DSN: "postgres://x" });
    const result = runMcpDoctor(env, paths, {
      hosts: ["claude"],
      instances: ["cert"],
      scope: "workspace",
      workspace: root,
    });
    expect(result.summary.missing_mcp).toBe(1);
    expect(result.reports[0]?.status).toBe("missing-mcp");
  });

  it("status=missing-dsn cuando ni DSN ni entry existen", () => {
    const result = runMcpDoctor(env, paths, {
      hosts: ["claude"],
      instances: ["cert"],
      scope: "workspace",
      workspace: root,
    });
    expect(result.summary.missing_dsn).toBe(1);
    expect(result.reports[0]?.status).toBe("missing-dsn");
  });

  it("status=dsn-mismatch cuando entry existe pero DSN no", () => {
    runMcpSetup(env, {
      hosts: ["claude"],
      instances: ["cert"],
      scope: "workspace",
      workspace: root,
    });
    const result = runMcpDoctor(env, paths, {
      hosts: ["claude"],
      instances: ["cert"],
      scope: "workspace",
      workspace: root,
    });
    expect(result.summary.dsn_mismatch).toBe(1);
    expect(result.reports[0]?.status).toBe("dsn-mismatch");
  });

  it("status=extra-entry cuando entry existe pero shape difiere", () => {
    writeDsn(paths, { DB_CERT_DSN: "postgres://x" });
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          cert: {
            command: "node",
            args: ["custom.js"],
            env: { CUSTOM: "true" },
          },
        },
      }),
    );
    const result = runMcpDoctor(env, paths, {
      hosts: ["claude"],
      instances: ["cert"],
      scope: "workspace",
      workspace: root,
    });
    expect(result.summary.extra).toBe(1);
    expect(result.reports[0]?.status).toBe("extra-entry");
  });
});
