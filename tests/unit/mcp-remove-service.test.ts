import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMcpRemove } from "../../src/application/mcp-remove-service.js";
import { runMcpSetup } from "../../src/application/mcp-setup-service.js";
import { knownLegacyMcpEntries, mcpEntryShapeForHost } from "../../src/domain/mcp-entry.js";
import { FakeEnv } from "../helpers/fake-env.js";

const ALPHA = { name: "alpha", dsnVar: "ALPHA_DATABASE_URL" };

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
      connections: [ALPHA],
      scope: "workspace",
      workspace,
    });
    if ("ok" in setup) throw new Error("setup refused");

    const result = runMcpRemove(env, {
      hosts: ["claude", "codex"],
      connections: [ALPHA],
      scope: "workspace",
      workspace,
    });
    if ("ok" in result) throw new Error("remove refused");
    expect(result.removed).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.reload_required).toEqual([
      expect.objectContaining({
        host: "claude",
        instance: "alpha",
        reload_required: true,
        next_step: expect.stringContaining("Reconnect"),
      }),
      expect.objectContaining({
        host: "codex",
        instance: "alpha",
        reload_required: true,
        next_step: expect.stringContaining("Restart"),
      }),
    ]);
  });

  it("es idempotente cuando la entrada no existe", () => {
    const result = runMcpRemove(env, {
      hosts: ["claude"],
      connections: [ALPHA],
      scope: "workspace",
      workspace,
    });
    if ("ok" in result) throw new Error("remove refused");
    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.reload_required).toBeUndefined();
  });

  it("una entrada homónima ajena queda como conflicto y no se borra", () => {
    const file = join(workspace, ".mcp.json");
    const foreign = `${JSON.stringify(
      { mcpServers: { alpha: { command: "node", args: ["foreign.js"], env: {} } } },
      null,
      2,
    )}\n`;
    writeFileSync(file, foreign);

    const result = runMcpRemove(env, {
      hosts: ["claude"],
      connections: [ALPHA],
      scope: "workspace",
      workspace,
    });

    if ("ok" in result) throw new Error("remove refused");
    expect(result.removed).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.action).toBe("conflict");
    expect(readFileSync(file, "utf-8")).toBe(foreign);
  });

  it("retira una forma DBHub legacy exacta publicada, sin ampliar la propiedad", () => {
    const legacy = knownLegacyMcpEntries(ALPHA.name, ALPHA.dsnVar)[0];
    if (legacy === undefined) throw new Error("expected published legacy descriptor");
    const file = join(workspace, ".mcp.json");
    writeFileSync(
      file,
      `${JSON.stringify(
        { mcpServers: { alpha: mcpEntryShapeForHost("claude", legacy) } },
        null,
        2,
      )}\n`,
    );

    const result = runMcpRemove(env, {
      hosts: ["claude"],
      connections: [ALPHA],
      scope: "workspace",
      workspace,
    });

    if ("ok" in result) throw new Error("remove refused");
    expect(result.removed).toHaveLength(1);
    expect(result.conflicts).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf-8")).mcpServers).toBeUndefined();
  });

  it("retira la misma forma exacta de la ubicación histórica de Claude", () => {
    const legacy = knownLegacyMcpEntries(ALPHA.name, ALPHA.dsnVar)[0];
    if (legacy === undefined) throw new Error("expected published legacy descriptor");
    const legacyFile = join(workspace, ".claude", "settings.json");
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      legacyFile,
      `${JSON.stringify(
        { mcpServers: { alpha: mcpEntryShapeForHost("claude", legacy) } },
        null,
        2,
      )}\n`,
    );

    const result = runMcpRemove(env, {
      hosts: ["claude"],
      connections: [ALPHA],
      scope: "workspace",
      workspace,
    });

    if ("ok" in result) throw new Error("remove refused");
    expect(result.removed).toHaveLength(1);
    expect(result.conflicts).toEqual([]);
    expect(JSON.parse(readFileSync(legacyFile, "utf-8")).mcpServers).toBeUndefined();
  });

  it("scope=global sin --force ni --dry-run retorna refusal con exit 2", () => {
    const result = runMcpRemove(env, {
      hosts: ["claude"],
      connections: [ALPHA],
      scope: "global",
    });
    expect("ok" in result).toBe(true);
    if (!("ok" in result)) throw new Error("expected refusal");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("global_requires_force");
    expect(result.exitCode).toBe(2);
  });
});
