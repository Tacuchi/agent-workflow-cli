import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMcpRemove } from "../../src/application/mcp-remove-service.js";
import { runMcpSetup } from "../../src/application/mcp-setup-service.js";
import { FakeEnv } from "../helpers/fake-env.js";

describe("runMcpRemove", () => {
  let workspace: string;
  let env: FakeEnv;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "mcp-remove-svc-"));
    // Sandboxed under the test workspace: global-scope paths never leave tmp.
    env = new FakeEnv(join(workspace, "home"), workspace);
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("remueve entradas existentes por host e instancia", () => {
    const setup = runMcpSetup(env, {
      hosts: ["claude", "codex"],
      instances: ["cert"],
      scope: "workspace",
      workspace,
    });
    if ("ok" in setup) throw new Error("setup refused");

    const result = runMcpRemove(env, {
      hosts: ["claude", "codex"],
      instances: ["cert"],
      scope: "workspace",
      workspace,
    });
    if ("ok" in result) throw new Error("remove refused");
    expect(result.removed).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  it("es idempotente cuando la entrada no existe", () => {
    const result = runMcpRemove(env, {
      hosts: ["claude"],
      instances: ["cert"],
      scope: "workspace",
      workspace,
    });
    if ("ok" in result) throw new Error("remove refused");
    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  it("scope=global sin --force ni --dry-run retorna refusal con exit 2", () => {
    const result = runMcpRemove(env, {
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
});
