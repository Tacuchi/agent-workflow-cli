import type { SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type McpHostReceipt,
  McpHostReceiptService,
  type McpHostReceiptStore,
  type McpHostReceiptTransaction,
} from "../../src/application/mcp-host-receipt-service.js";
import { openMcpHostReceiptService } from "../../src/application/mcp-host-receipts.js";
import {
  type NativeMcpHostCheckDeps,
  checkNativeMcpHosts,
  recordNativeMcpHostChecks,
} from "../../src/application/mcp-native-host-check-service.js";
import type { McpReceiptProbeTarget } from "../../src/application/mcp-receipt-registration-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { buildMcpEntry, mcpEntryShapeForHost } from "../../src/domain/mcp-entry.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

const CLAUDE_TARGET: McpReceiptProbeTarget = {
  host: "claude",
  instance: "qtc-cert",
  target: "/safe/.claude.json",
};
const CLAUDE_RECEIPT_IDENTITY = {
  host: "claude" as const,
  scope: "global" as const,
  connection: "qtc-cert",
};

class MemoryReceiptStore implements McpHostReceiptStore {
  private receipts: McpHostReceipt[] = [];

  async read(): Promise<readonly McpHostReceipt[]> {
    return structuredClone(this.receipts);
  }

  async update<T>(
    transaction: (receipts: readonly McpHostReceipt[]) => McpHostReceiptTransaction<T>,
  ): Promise<T> {
    const next = transaction(await this.read());
    this.receipts = structuredClone(next.receipts);
    return next.result;
  }
}

function spawnResult(
  input: {
    stdout?: string;
    stderr?: string;
    status?: number | null;
    error?: Error;
  } = {},
): SpawnSyncReturns<Buffer> {
  const stdout = Buffer.from(input.stdout ?? "", "utf8");
  const stderr = Buffer.from(input.stderr ?? "", "utf8");
  return {
    pid: 42,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status: input.status ?? 0,
    signal: null,
    ...(input.error === undefined ? {} : { error: input.error }),
  };
}

function check(
  targets: readonly McpReceiptProbeTarget[],
  spawnSync: NonNullable<NativeMcpHostCheckDeps["spawnSync"]>,
) {
  return checkNativeMcpHosts(targets, {
    spawnSync,
    environment: { PATH: "/private/bin" },
  });
}

describe("checkNativeMcpHosts", () => {
  it("usa los comandos nativos documentados sin shell y sólo una vez por entrada", async () => {
    const calls: Array<{ command: string; args: readonly string[]; shell: boolean }> = [];
    const result = await check(
      [
        CLAUDE_TARGET,
        { ...CLAUDE_TARGET, target: "/other/.claude.json" },
        { host: "codex", instance: "qtc-prod", target: "/safe/.codex/config.toml" },
        { host: "warp", instance: "qtc-cert", target: "/safe/warp.json" },
      ],
      (command, args, options) => {
        calls.push({ command, args, shell: options.shell });
        return spawnResult({
          stdout: `registered: ${command === "claude" ? "qtc-cert" : "qtc-prod"}`,
        });
      },
    );

    expect(calls).toEqual([
      { command: "claude", args: ["mcp", "list"], shell: false },
      { command: "codex", args: ["mcp", "list"], shell: false },
    ]);
    expect(result).toEqual({
      checks: [
        { host: "claude", instance: "qtc-cert", outcome: "passed" },
        { host: "codex", instance: "qtc-prod", outcome: "passed" },
      ],
      errors: [],
    });
  });

  it("reporta un binario ausente sin publicar el error ni la salida del host", async () => {
    const missing = Object.assign(
      new Error("spawn claude ENOENT postgres://readonly:secret@db.example.test/app"),
      { code: "ENOENT" },
    );
    const result = await check([CLAUDE_TARGET], () =>
      spawnResult({
        error: missing,
        stdout: "postgres://readonly:secret@db.example.test/app",
        stderr: "credential=secret",
      }),
    );

    expect(result).toEqual({
      checks: [
        {
          host: "claude",
          instance: "qtc-cert",
          outcome: "failed",
          code: "HOST_BINARY_MISSING",
        },
      ],
      errors: [
        {
          host: "claude",
          instance: "qtc-cert",
          target: "/safe/.claude.json",
          message: "No se encontró el binario nativo del host para verificar su configuración MCP.",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("postgres://");
  });

  it("distingue un fallo del comando nativo de una entrada que no quedó visible", async () => {
    const commandFailure = await check([CLAUDE_TARGET], () =>
      spawnResult({ status: 1, stderr: "private failure details" }),
    );
    const invisible = await check([CLAUDE_TARGET], () =>
      spawnResult({ stdout: "other-server\nDATABASE_URL=private" }),
    );

    expect(commandFailure.checks[0]).toMatchObject({
      outcome: "failed",
      code: "HOST_NATIVE_CHECK_FAILED",
    });
    expect(invisible.checks[0]).toMatchObject({
      outcome: "failed",
      code: "HOST_ENTRY_NOT_VISIBLE",
    });
    expect(JSON.stringify(commandFailure)).not.toContain("private failure details");
    expect(JSON.stringify(invisible)).not.toContain("DATABASE_URL=private");
  });

  it("no acredita un nombre que sólo aparece como prefijo de otra entrada", async () => {
    const result = await check([CLAUDE_TARGET], () =>
      spawnResult({ stdout: "registered: qtc-cert-old" }),
    );

    expect(result.checks[0]).toMatchObject({
      outcome: "failed",
      code: "HOST_ENTRY_NOT_VISIBLE",
    });
  });

  it("no confunde una visibilidad nativa fallida con un probe de launch en el recibo", async () => {
    const receipts = new McpHostReceiptService(new MemoryReceiptStore());
    await receipts.register({
      host: "claude",
      scope: "global",
      connection: "qtc-cert",
      worklineVersion: "23.0.0",
      descriptor: { command: "/safe/node", args: ["/safe/main.js", "mcp", "serve-db"] },
      registeredAt: "2026-08-31T12:00:00.000Z",
    });

    const result = await check([CLAUDE_TARGET], () => spawnResult({ stdout: "other-server" }));
    const receipt = await receipts.find({
      host: "claude",
      scope: "global",
      connection: "qtc-cert",
    });

    expect(result.checks[0]).toMatchObject({ code: "HOST_ENTRY_NOT_VISIBLE" });
    expect(receipt).toMatchObject({ reload_required: true });
    expect(receipt?.last_launch_probe).toBeUndefined();
  });

  it("persiste el fallo nativo sólo para el descriptor releído y lo limpia al aprobar", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-native-check-receipt-"));
    try {
      const home = join(root, "home");
      const project = join(root, "project");
      const paths = new PathsService(normalizeNamespace("workflow"), home, project);
      const entry = buildMcpEntry("qtc-cert", "QTC_CERT_DATABASE_URL", {
        host: "claude",
        scope: "global",
        namespace: "workflow",
      });
      const target = join(home, ".claude.json");
      mkdirSync(home, { recursive: true });
      writeFileSync(
        target,
        `${JSON.stringify({ mcpServers: { [entry.name]: mcpEntryShapeForHost("claude", entry) } })}\n`,
        "utf-8",
      );
      const receipts = openMcpHostReceiptService(paths);
      const registered = await receipts.register({
        host: "claude",
        scope: "global",
        connection: "qtc-cert",
        worklineVersion: "23.0.0",
        descriptor: { command: entry.command, args: entry.args },
        registeredAt: "2026-08-31T12:00:00.000Z",
      });
      const receiptTarget: McpReceiptProbeTarget = {
        host: "claude",
        instance: "qtc-cert",
        target,
        entry,
      };

      await recordNativeMcpHostChecks({
        paths,
        scope: "global",
        scopeDir: home,
        targets: [receiptTarget],
        checks: [
          {
            host: "claude",
            instance: "qtc-cert",
            outcome: "failed",
            code: "HOST_ENTRY_NOT_VISIBLE",
          },
        ],
      });
      expect(
        (await receipts.find(CLAUDE_RECEIPT_IDENTITY))?.last_native_check_failure,
      ).toMatchObject({
        code: "HOST_ENTRY_NOT_VISIBLE",
      });

      await recordNativeMcpHostChecks({
        paths,
        scope: "global",
        scopeDir: home,
        targets: [receiptTarget],
        checks: [{ host: "claude", instance: "qtc-cert", outcome: "passed" }],
      });
      expect(
        (await receipts.find(CLAUDE_RECEIPT_IDENTITY))?.last_native_check_failure,
      ).toBeUndefined();
      expect((await receipts.find(CLAUDE_RECEIPT_IDENTITY))?.descriptor_digest).toBe(
        registered.descriptor_digest,
      );

      writeFileSync(
        target,
        `${JSON.stringify({ mcpServers: { [entry.name]: { command: "foreign", args: [] } } })}\n`,
        "utf-8",
      );
      await recordNativeMcpHostChecks({
        paths,
        scope: "global",
        scopeDir: home,
        targets: [receiptTarget],
        checks: [
          {
            host: "claude",
            instance: "qtc-cert",
            outcome: "failed",
            code: "HOST_BINARY_MISSING",
          },
        ],
      });
      expect(
        (await receipts.find(CLAUDE_RECEIPT_IDENTITY))?.last_native_check_failure,
      ).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
