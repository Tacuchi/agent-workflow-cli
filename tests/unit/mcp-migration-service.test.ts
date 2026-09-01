import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyMcpEntry } from "../../src/application/mcp-entry-classification.js";
import { readMcpEntry } from "../../src/application/mcp-host-reader.js";
import { runMcpMigration } from "../../src/application/mcp-migration-service.js";
import {
  type McpConnectionRef,
  buildMcpEntry,
  knownLegacyMcpEntries,
  mcpEntryShapeForHost,
} from "../../src/domain/mcp-entry.js";
import { worklineMcpEntry } from "../../src/domain/workline-mcp-entry.js";
import type { EnvPort } from "../../src/ports/env.js";

const CONNECTION: McpConnectionRef = {
  name: "alpha",
  dsnVar: "ALPHA_DATABASE_URL",
};

const WORKLINE_CONNECTION: McpConnectionRef = {
  name: "agent-workflow",
  dsnVar: "WORKLINE_DATABASE_URL",
};

function currentEntry(name: string, dsnVar: string) {
  return buildMcpEntry(name, dsnVar, {
    host: "claude",
    scope: "workspace",
    namespace: "tenant-a",
  });
}

function publishedLegacy(name: string, dsnVar: string) {
  const legacy = knownLegacyMcpEntries(name, dsnVar)[0];
  if (legacy === undefined) throw new Error("expected a published legacy descriptor");
  return legacy;
}

describe("runMcpMigration", () => {
  let workspace: string;
  let env: EnvPort;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "aw-mcp-migration-"));
    env = {
      get: () => undefined,
      homeDir: () => workspace,
      cwd: () => workspace,
    };
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function migrate(connections: readonly McpConnectionRef[] = [CONNECTION], apply = false) {
    return runMcpMigration(env, {
      scope: "workspace",
      workspace,
      hosts: ["claude"],
      connections,
      namespace: "tenant-a",
      ...(apply ? { apply: true } : {}),
    });
  }

  it("el preview de una entrada ausente propone instalar sin escribir nada", () => {
    const result = migrate();

    expect(result).toMatchObject({
      scope: "workspace",
      scope_dir: workspace,
      preview: true,
      summary: { missing: 1 },
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        host: "claude",
        instance: "alpha",
        state: "missing",
        action: "install",
      }),
    ]);
    expect(existsSync(join(workspace, ".mcp.json"))).toBe(false);
  });

  it("el preview reconoce únicamente la forma legacy Workline exacta", () => {
    const legacy = publishedLegacy(CONNECTION.name, CONNECTION.dsnVar);
    const target = join(workspace, ".mcp.json");
    const original = `${JSON.stringify(
      { mcpServers: { alpha: mcpEntryShapeForHost("claude", legacy) } },
      null,
      2,
    )}\n`;
    writeFileSync(target, original);

    const result = migrate();

    expect(result.summary).toMatchObject({ "known-legacy": 1 });
    expect(result.items[0]).toMatchObject({
      state: "known-legacy",
      action: "replace-known-legacy",
    });
    expect(readFileSync(target, "utf-8")).toBe(original);
  });

  it("migra el servidor legacy de elicitation sólo para la conexión DB homónima", () => {
    const legacy = worklineMcpEntry("claude");
    const target = join(workspace, ".mcp.json");
    const original = `${JSON.stringify(
      { mcpServers: { "agent-workflow": mcpEntryShapeForHost("claude", legacy) } },
      null,
      2,
    )}\n`;
    writeFileSync(target, original);

    const preview = migrate([WORKLINE_CONNECTION]);
    expect(preview.items[0]).toMatchObject({
      instance: "agent-workflow",
      state: "known-legacy",
      action: "replace-known-legacy",
      from: { command: "agent-workflow", args: ["mcp", "serve", "--host", "claude"] },
    });
    expect(readFileSync(target, "utf-8")).toBe(original);

    const applied = migrate([WORKLINE_CONNECTION], true);
    expect(applied.items[0]).toMatchObject({
      state: "known-legacy",
      action: "replace-known-legacy",
      write: expect.objectContaining({ action: "written" }),
      readback_state: "current",
    });
    const content = JSON.parse(readFileSync(target, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    const current = currentEntry(WORKLINE_CONNECTION.name, WORKLINE_CONNECTION.dsnVar);
    expect(content.mcpServers["agent-workflow"]).toEqual(mcpEntryShapeForHost("claude", current));
  });

  it("no migra una variante del servidor legacy de elicitation", () => {
    const legacy = worklineMcpEntry("claude");
    const target = join(workspace, ".mcp.json");
    const foreign = {
      ...mcpEntryShapeForHost("claude", legacy),
      args: ["mcp", "serve", "--host", "claude", "--extra"],
    };
    const original = `${JSON.stringify({ mcpServers: { "agent-workflow": foreign } }, null, 2)}\n`;
    writeFileSync(target, original);

    const result = migrate([WORKLINE_CONNECTION], true);

    expect(result.items[0]).toMatchObject({ state: "foreign", action: "blocked" });
    expect(readFileSync(target, "utf-8")).toBe(original);
  });

  it("el preview bloquea una entrada ajena y conserva sus bytes", () => {
    const target = join(workspace, ".mcp.json");
    const original = `${JSON.stringify(
      {
        mcpServers: {
          alpha: { command: "/usr/local/bin/foreign", args: ["serve"], env: {} },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(target, original);

    const result = migrate();

    expect(result.summary).toMatchObject({ foreign: 1 });
    expect(result.items[0]).toMatchObject({ state: "foreign", action: "blocked" });
    expect(readFileSync(target, "utf-8")).toBe(original);
  });

  it("el preview bloquea un contenedor malformado y no intenta repararlo", () => {
    const target = join(workspace, ".mcp.json");
    const original = "{ not valid json";
    writeFileSync(target, original);

    const result = migrate();

    expect(result.summary).toMatchObject({ malformed: 1 });
    expect(result.items[0]).toMatchObject({ state: "malformed", action: "blocked" });
    expect(readFileSync(target, "utf-8")).toBe(original);
  });

  it("apply, accesible desde el comando sólo con --force, escribe sólo lo migrable y relee current", () => {
    const beta: McpConnectionRef = { name: "beta", dsnVar: "BETA_DATABASE_URL" };
    const gamma: McpConnectionRef = { name: "gamma", dsnVar: "GAMMA_DATABASE_URL" };
    const legacy = publishedLegacy(CONNECTION.name, CONNECTION.dsnVar);
    const foreign = { command: "/usr/local/bin/foreign", args: ["serve"], env: {} };
    const target = join(workspace, ".mcp.json");
    writeFileSync(
      target,
      `${JSON.stringify(
        {
          mcpServers: {
            alpha: mcpEntryShapeForHost("claude", legacy),
            gamma: foreign,
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = migrate([CONNECTION, beta, gamma], true);

    expect(result.preview).toBe(false);
    expect(result.summary).toEqual({
      current: 0,
      "known-legacy": 1,
      foreign: 1,
      missing: 1,
      malformed: 0,
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        instance: "alpha",
        state: "known-legacy",
        action: "replace-known-legacy",
        write: expect.objectContaining({ action: "written" }),
        readback_state: "current",
      }),
      expect.objectContaining({
        instance: "beta",
        state: "missing",
        action: "install",
        write: expect.objectContaining({ action: "written" }),
        readback_state: "current",
      }),
      expect.objectContaining({ instance: "gamma", state: "foreign", action: "blocked" }),
    ]);

    const content = JSON.parse(readFileSync(target, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(content.mcpServers.gamma).toEqual(foreign);
    for (const connection of [CONNECTION, beta]) {
      const entry = currentEntry(connection.name, connection.dsnVar);
      const snapshot = readMcpEntry("claude", workspace, entry.name, "workspace");
      expect(classifyMcpEntry("claude", snapshot, entry, connection).state).toBe("current");
    }
  });

  it("apply no sobrescribe una entrada foreign aunque haya sido solicitado", () => {
    const target = join(workspace, ".mcp.json");
    const original = `${JSON.stringify(
      {
        mcpServers: {
          alpha: { command: "/usr/local/bin/foreign", args: ["serve"], env: {} },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(target, original);

    const result = migrate([CONNECTION], true);

    expect(result.preview).toBe(false);
    expect(result.items[0]).toMatchObject({ state: "foreign", action: "blocked" });
    expect(result.items[0]?.write).toBeUndefined();
    expect(readFileSync(target, "utf-8")).toBe(original);
  });

  it("instala qtc-cert y luego retira el alias Claude cert exacto", () => {
    const qtcCert: McpConnectionRef = {
      name: "qtc-cert",
      dsnVar: "QTC_CERT_DATABASE_URL",
    };
    const legacy = publishedLegacy("cert", qtcCert.dsnVar);
    const target = join(workspace, ".mcp.json");
    writeFileSync(
      target,
      `${JSON.stringify(
        { mcpServers: { cert: mcpEntryShapeForHost("claude", legacy) } },
        null,
        2,
      )}\n`,
    );

    const preview = migrate([qtcCert]);
    expect(preview.items[0]).toMatchObject({
      instance: "qtc-cert",
      state: "missing",
      action: "replace-known-legacy",
      retirements: [
        expect.objectContaining({
          instance: "cert",
          state: "known-legacy",
          action: "retire-known-legacy",
        }),
      ],
    });

    const applied = migrate([qtcCert], true);
    expect(applied.items[0]).toMatchObject({
      action: "replace-known-legacy",
      readback_state: "current",
      configuration_changed: true,
      retirements: [
        expect.objectContaining({ action: "retire-known-legacy", readback_state: "missing" }),
      ],
    });
    const content = JSON.parse(readFileSync(target, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(content.mcpServers.cert).toBeUndefined();
    const current = currentEntry(qtcCert.name, qtcCert.dsnVar);
    expect(content.mcpServers[current.name]).toEqual(mcpEntryShapeForHost("claude", current));
  });

  it("conserva el alias legacy si qtc no se puede escribir", () => {
    const qtcCert: McpConnectionRef = {
      name: "qtc-cert",
      dsnVar: "QTC_CERT_DATABASE_URL",
    };
    const legacy = publishedLegacy("cert", qtcCert.dsnVar);
    const legacyFile = join(workspace, ".claude", "settings.json");
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      legacyFile,
      `${JSON.stringify(
        { mcpServers: { cert: mcpEntryShapeForHost("claude", legacy) } },
        null,
        2,
      )}\n`,
    );
    // Force the current qtc write to fail after classification. The migration
    // must not remove `cert` until `qtc-cert` has been written and reread.
    mkdirSync(join(workspace, ".mcp.json.agent-workflow.lock"));

    const applied = migrate([qtcCert], true);

    expect(applied.items[0]).toMatchObject({
      instance: "qtc-cert",
      action: "failed",
      retirements: [
        expect.objectContaining({
          instance: "cert",
          action: "blocked",
          error: expect.objectContaining({ code: "MCP_MIGRATION_WRITE_FAILED" }),
        }),
      ],
    });
    const retained = JSON.parse(readFileSync(legacyFile, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(retained.mcpServers.cert).toEqual(mcpEntryShapeForHost("claude", legacy));
    expect(existsSync(join(workspace, ".mcp.json"))).toBe(false);
  });

  it("retira también un alias DBHub exacto de la ubicación histórica de Claude", () => {
    const qtcProd: McpConnectionRef = {
      name: "qtc-prod",
      dsnVar: "QTC_PROD_DATABASE_URL",
    };
    const legacy = publishedLegacy("prod", qtcProd.dsnVar);
    const legacyFile = join(workspace, ".claude", "settings.json");
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      legacyFile,
      `${JSON.stringify(
        { mcpServers: { prod: mcpEntryShapeForHost("claude", legacy) } },
        null,
        2,
      )}\n`,
    );

    const applied = migrate([qtcProd], true);
    expect(applied.items[0]).toMatchObject({
      action: "replace-known-legacy",
      readback_state: "current",
      retirements: [expect.objectContaining({ instance: "prod", readback_state: "missing" })],
    });
    const retired = JSON.parse(readFileSync(legacyFile, "utf-8")) as Record<string, unknown>;
    expect(retired.mcpServers).toBeUndefined();
  });

  it("requiere aprobación explícita para aplicar una migración global", () => {
    const result = runMcpMigration(env, {
      scope: "global",
      apply: true,
      hosts: ["claude"],
      connections: [CONNECTION],
      namespace: "tenant-a",
    });

    expect(result).toMatchObject({ ok: false, error: "global_requires_force", exitCode: 2 });
    expect(existsSync(join(workspace, ".claude.json"))).toBe(false);
  });
});
