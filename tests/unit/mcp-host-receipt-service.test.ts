import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type McpHostReceipt,
  McpHostReceiptError,
  McpHostReceiptService,
  type McpHostReceiptStore,
  type McpHostReceiptTransaction,
  digestMcpReceiptDescriptor,
  parseMcpHostReceiptBook,
} from "../../src/application/mcp-host-receipt-service.js";
import { NodeMcpHostReceiptStore } from "../../src/application/mcp-host-receipt-store.js";

const IDENTITY = { host: "codex" as const, scope: "global" as const, connection: "qtc-cert" };
const FIRST_DESCRIPTOR = {
  command: "/usr/local/bin/node",
  args: ["/opt/workline/dist/cli/main.js", "mcp", "serve-db", "--instance", "qtc-cert"],
};
const SECOND_DESCRIPTOR = {
  command: "/usr/local/bin/node",
  args: ["/opt/workline-v2/dist/cli/main.js", "mcp", "serve-db", "--instance", "qtc-cert"],
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

function register(service: McpHostReceiptService, descriptor = FIRST_DESCRIPTOR) {
  return service.register({
    ...IDENTITY,
    worklineVersion: "23.0.0",
    descriptor,
    registeredAt: "2026-08-31T12:00:00.000Z",
  });
}

function receiptError(action: () => void): McpHostReceiptError {
  try {
    action();
  } catch (error) {
    if (error instanceof McpHostReceiptError) return error;
    throw error;
  }
  throw new Error("Se esperaba McpHostReceiptError.");
}

describe("McpHostReceiptService", () => {
  it("sella solamente el descriptor seguro y rechaza una URI de conexión", () => {
    const digest = digestMcpReceiptDescriptor(FIRST_DESCRIPTOR);

    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(digest).not.toContain("qtc-cert");
    expect(digest).not.toContain("postgres");
    expect(() =>
      digestMcpReceiptDescriptor({
        command: "/usr/local/bin/node",
        args: ["/opt/workline/dist/cli/main.js", "postgres://readonly:secret@db.example.test/app"],
      }),
    ).toThrow(McpHostReceiptError);
  });

  it("mantiene launchability separada de la carga observada por el host", async () => {
    const service = new McpHostReceiptService(new MemoryReceiptStore());
    const registered = await register(service);

    expect(registered).toMatchObject({ reload_required: true });
    expect(registered.last_host_load_observed).toBeUndefined();

    const afterProbe = await service.recordLaunchProbe({
      ...IDENTITY,
      outcome: "passed",
      phase: "tools/list",
      observedAt: "2026-08-31T12:01:00.000Z",
    });

    expect(afterProbe).toMatchObject({
      reload_required: true,
      last_launch_probe: {
        outcome: "passed",
        phase: "tools/list",
        observed_at: "2026-08-31T12:01:00.000Z",
      },
    });
    expect(afterProbe.last_host_load_observed).toBeUndefined();

    const observed = await service.observeHostLoad({
      ...IDENTITY,
      descriptorDigest: registered.descriptor_digest,
      observedAt: "2026-08-31T12:02:00.000Z",
    });

    expect(observed).toMatchObject({
      reload_required: false,
      last_host_load_observed: {
        descriptor_digest: registered.descriptor_digest,
        observed_at: "2026-08-31T12:02:00.000Z",
      },
      last_launch_probe: { outcome: "passed", phase: "tools/list" },
    });
  });

  it("persiste sólo un fallo nativo y lo limpia con una comprobación vigente aprobada", async () => {
    const service = new McpHostReceiptService(new MemoryReceiptStore());
    const registered = await register(service);

    const failed = await service.recordNativeHostCheck({
      ...IDENTITY,
      descriptorDigest: registered.descriptor_digest,
      outcome: "failed",
      code: "HOST_ENTRY_NOT_VISIBLE",
      observedAt: "2026-08-31T12:01:00.000Z",
    });

    expect(failed.last_native_check_failure).toEqual({
      code: "HOST_ENTRY_NOT_VISIBLE",
      observed_at: "2026-08-31T12:01:00.000Z",
    });
    expect(failed.last_launch_probe).toBeUndefined();

    const cleared = await service.recordNativeHostCheck({
      ...IDENTITY,
      descriptorDigest: registered.descriptor_digest,
      outcome: "passed",
      observedAt: "2026-08-31T12:02:00.000Z",
    });

    expect(cleared.last_native_check_failure).toBeUndefined();
    expect(JSON.stringify(cleared)).not.toContain("HOST_ENTRY_NOT_VISIBLE");

    await expect(
      service.recordNativeHostCheck({
        ...IDENTITY,
        descriptorDigest: digestMcpReceiptDescriptor(SECOND_DESCRIPTOR),
        outcome: "failed",
        code: "HOST_BINARY_MISSING",
        observedAt: "2026-08-31T12:03:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "MCP_RECEIPT_DESCRIPTOR_STALE" });
    expect((await service.find(IDENTITY))?.last_native_check_failure).toBeUndefined();
  });

  it("no deja que un servidor de descriptor anterior confirme una reinstalación", async () => {
    const service = new McpHostReceiptService(new MemoryReceiptStore());
    const first = await register(service);
    const second = await register(service, SECOND_DESCRIPTOR);

    await expect(
      service.observeHostLoad({
        ...IDENTITY,
        descriptorDigest: first.descriptor_digest,
        observedAt: "2026-08-31T12:03:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "MCP_RECEIPT_DESCRIPTOR_STALE" });

    expect(await service.find(IDENTITY)).toEqual(second);
    expect(second).toMatchObject({ reload_required: true });
    expect(second.last_host_load_observed).toBeUndefined();
  });

  it("rechaza libros malformados y una carga sin evidencia de host", () => {
    expect(receiptError(() => parseMcpHostReceiptBook("{ no es json"))).toMatchObject({
      code: "MCP_RECEIPT_MALFORMED",
    });

    const digest = digestMcpReceiptDescriptor(FIRST_DESCRIPTOR);
    const unloadedButMarkedLoaded = JSON.stringify({
      schema_version: 1,
      receipts: [
        {
          schema_version: 1,
          ...IDENTITY,
          workline_version: "23.0.0",
          descriptor_digest: digest,
          registered_at: "2026-08-31T12:00:00.000Z",
          reload_required: false,
        },
      ],
    });

    expect(receiptError(() => parseMcpHostReceiptBook(unloadedButMarkedLoaded))).toMatchObject({
      code: "MCP_RECEIPT_MALFORMED",
    });

    const invalidNativeFailure = JSON.stringify({
      schema_version: 1,
      receipts: [
        {
          schema_version: 1,
          ...IDENTITY,
          workline_version: "23.0.0",
          descriptor_digest: digest,
          registered_at: "2026-08-31T12:00:00.000Z",
          reload_required: true,
          last_native_check_failure: {
            observed_at: "2026-08-31T12:01:00.000Z",
            code: "HOST_PRIVATE_DETAILS",
          },
        },
      ],
    });

    expect(receiptError(() => parseMcpHostReceiptBook(invalidNativeFailure))).toMatchObject({
      code: "MCP_RECEIPT_MALFORMED",
    });
  });
});

describe("NodeMcpHostReceiptStore", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("escribe y relee el libro atómico sin introducir secretos", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-host-receipt-store-"));
    roots.push(root);
    const file = join(root, "state", "mcp-host-receipts.json");
    const service = new McpHostReceiptService(new NodeMcpHostReceiptStore(file));

    const receipt = await register(service);
    const persisted = readFileSync(file, "utf8");

    expect(persisted).toContain(receipt.descriptor_digest);
    expect(persisted).not.toContain("postgres://");
    expect(persisted).not.toContain("secret");
    expect((await service.find(IDENTITY))?.descriptor_digest).toBe(receipt.descriptor_digest);
  });

  it("no sobrescribe un temporal preexistente al reservar la escritura atómica", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-host-receipt-collision-"));
    roots.push(root);
    const file = join(root, "state", "mcp-host-receipts.json");
    const collidingTemporary = `${file}.${process.pid}.1.tmp`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(collidingTemporary, "foreign-temporary-content");

    const service = new McpHostReceiptService(new NodeMcpHostReceiptStore(file));
    await register(service);

    expect(readFileSync(collidingTemporary, "utf8")).toBe("foreign-temporary-content");
    expect((await service.find(IDENTITY))?.connection).toBe("qtc-cert");
  });

  it("falla cerrado si el libro existente no se puede validar", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-host-receipt-malformed-"));
    roots.push(root);
    const file = join(root, "mcp-host-receipts.json");
    writeFileSync(file, '{"schema_version":1,"receipts":"not-an-array"}\n');
    const store = new NodeMcpHostReceiptStore(file);

    await expect(store.read()).rejects.toMatchObject({ code: "MCP_RECEIPT_MALFORMED" });
  });
});
