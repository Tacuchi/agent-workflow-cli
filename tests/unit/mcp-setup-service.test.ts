import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMcpSetup } from "../../src/application/mcp-setup-service.js";
import { FakeEnv } from "../helpers/fake-env.js";

describe("runMcpSetup", () => {
  let workspace: string;
  let home: string;
  let env: FakeEnv;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "mcp-setup-svc-"));
    home = join(workspace, "home");
    env = new FakeEnv(home, workspace);
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("aplica las 4 combinaciones host×instance en una corrida", () => {
    const result = runMcpSetup(env, {
      hosts: ["claude", "codex"],
      instances: ["cert", "prod"],
      scope: "workspace",
      workspace,
    });
    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.applied).toHaveLength(4);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.dry_run).toBe(false);
    expect(result.scope).toBe("workspace");
  });

  it("idempotencia: segunda corrida marca todo como skipped", () => {
    runMcpSetup(env, {
      hosts: ["claude"],
      instances: ["cert"],
      scope: "workspace",
      workspace,
    });
    const second = runMcpSetup(env, {
      hosts: ["claude"],
      instances: ["cert"],
      scope: "workspace",
      workspace,
    });
    if ("ok" in second) throw new Error("did not expect refusal");
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toHaveLength(1);
  });

  it("dry-run no escribe", () => {
    const result = runMcpSetup(env, {
      hosts: ["claude", "codex"],
      instances: ["cert"],
      scope: "workspace",
      workspace,
      dryRun: true,
    });
    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.applied.every((r) => r.action === "dry-run")).toBe(true);
    expect(result.dry_run).toBe(true);
  });

  it("acepta conexiones custom y normaliza el nombre del server", () => {
    const result = runMcpSetup(env, {
      hosts: ["codex"],
      instances: ["reporting"],
      scope: "workspace",
      workspace,
    });
    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.name).toBe("reporting");
  });

  it("incluye DBHUB_DSN_VAR cuando la conexión usa una variable DSN custom", () => {
    const result = runMcpSetup(env, {
      hosts: ["claude"],
      instances: ["reporting"],
      scope: "workspace",
      workspace,
      dsnVars: { reporting: "REPORTING_DATABASE_URL" },
    });
    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.applied[0]?.name).toBe("reporting");
  });

  it("scope=global sin --force ni --dry-run retorna refusal con exit 2", () => {
    const result = runMcpSetup(env, {
      hosts: ["claude"],
      instances: ["cert"],
      scope: "global",
    });
    expect("ok" in result).toBe(true);
    if (!("ok" in result)) throw new Error("expected refusal");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("global_requires_force");
    expect(result.exitCode).toBe(2);
  });

  it("scope=global con --force escribe en el home inyectado (EnvPort), no en el real", () => {
    const result = runMcpSetup(env, {
      hosts: ["claude"],
      instances: ["cert"],
      scope: "global",
      force: true,
      workspace,
    });
    expect("ok" in result).toBe(false);
    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.scope_dir).toBe(home);
    expect(result.applied[0]?.target).toBe(join(home, ".claude.json"));
  });

  it("scope=global con --dry-run NO retorna refusal", () => {
    const result = runMcpSetup(env, {
      hosts: ["claude"],
      instances: ["cert"],
      scope: "global",
      dryRun: true,
      workspace,
    });
    expect("ok" in result).toBe(false);
  });
});
