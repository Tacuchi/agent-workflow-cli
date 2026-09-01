import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openMcpHostReceiptService,
  registerPersistedMcpDescriptor,
} from "../../src/application/mcp-host-receipts.js";
import { removeMcpRemoveReceipts } from "../../src/application/mcp-receipt-removal-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { buildMcpEntry } from "../../src/domain/mcp-entry.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("removeMcpRemoveReceipts", () => {
  it("retira evidencia huérfana cuando la entrada ya faltaba antes de remove", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-receipt-remove-"));
    roots.push(root);
    const paths = new PathsService(normalizeNamespace("workflow"), root, root);
    const connection = { name: "alpha", dsnVar: "ALPHA_DATABASE_URL" };
    const entry = buildMcpEntry(connection.name, connection.dsnVar, {
      host: "claude",
      scope: "global",
      namespace: "workflow",
    });
    await registerPersistedMcpDescriptor(paths, {
      host: "claude",
      scope: "global",
      connection: connection.name,
      entry,
    });

    const errors = await removeMcpRemoveReceipts(
      paths,
      {
        hosts: ["claude"],
        connections: [connection],
        namespace: "workflow",
        scope: "global",
      },
      {
        scope: "global",
        scope_dir: root,
        dry_run: false,
        removed: [],
        skipped: [
          {
            host: "claude",
            target: join(root, ".claude.json"),
            name: connection.name,
            action: "skipped-idempotent",
            backup: null,
          },
        ],
        conflicts: [],
        errors: [],
      },
    );

    expect(errors).toEqual([]);
    expect(
      await openMcpHostReceiptService(paths).find({
        host: "claude",
        scope: "global",
        connection: connection.name,
      }),
    ).toBeUndefined();
  });
});
