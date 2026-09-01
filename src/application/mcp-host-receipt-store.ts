import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type McpHostReceipt,
  McpHostReceiptError,
  type McpHostReceiptStore,
  type McpHostReceiptTransaction,
  emptyMcpHostReceiptBook,
  parseMcpHostReceiptBook,
  serializeMcpHostReceiptBook,
} from "./mcp-host-receipt-service.js";
import type { PathsService } from "./paths-service.js";

interface NodeError extends Error {
  code?: string;
}

/**
 * File adapter for {@link McpHostReceiptStore}.
 *
 * A `<file>.lock` is acquired with O_EXCL, so concurrent processes fail closed
 * rather than losing an observation between read and replace. The actual book
 * is written beside its destination and atomically renamed, then read back.
 */
export class NodeMcpHostReceiptStore implements McpHostReceiptStore {
  constructor(private readonly file: string) {}

  async read(): Promise<readonly McpHostReceipt[]> {
    return (await this.readBook()).receipts;
  }

  async update<T>(
    transaction: (receipts: readonly McpHostReceipt[]) => McpHostReceiptTransaction<T>,
  ): Promise<T> {
    const lock = await this.acquireLock();
    try {
      const current = await this.readBook();
      const next = transaction(current.receipts);
      const payload = serializeMcpHostReceiptBook(next.receipts);
      await this.writeAtomically(payload);
      const readback = await this.readBook();
      if (serializeMcpHostReceiptBook(readback.receipts) !== payload) {
        throw new McpHostReceiptError(
          "MCP_RECEIPT_MALFORMED",
          "La comprobación posterior de escritura del recibo MCP no coincide.",
        );
      }
      return next.result;
    } finally {
      try {
        await lock.close();
      } catch {
        // The lock is still unlinked below; a close failure must not strand it.
      } finally {
        try {
          await unlink(this.lockFile());
        } catch {
          // The operation already has its outcome; lock cleanup is best effort.
        }
      }
    }
  }

  private async readBook() {
    try {
      return parseMcpHostReceiptBook(await readFile(this.file, "utf8"));
    } catch (err) {
      if ((err as NodeError).code === "ENOENT") return emptyMcpHostReceiptBook();
      throw err;
    }
  }

  private async acquireLock() {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      return await open(this.lockFile(), "wx", 0o600);
    } catch (err) {
      if ((err as NodeError).code === "EEXIST") {
        throw new McpHostReceiptError(
          "MCP_RECEIPT_BUSY",
          "Otro proceso está actualizando los recibos MCP; reintentá la operación.",
        );
      }
      throw err;
    }
  }

  private async writeAtomically(payload: string): Promise<void> {
    const staged = await this.reserveAtomicTempFile();
    try {
      await staged.handle.writeFile(payload, "utf8");
      try {
        await chmod(staged.path, 0o600);
      } catch {
        // Some filesystems do not expose POSIX modes. The contents remain secret-free.
      }
      await staged.handle.close();
      await rename(staged.path, this.file);
    } catch (err) {
      try {
        await staged.handle.close();
      } catch {
        // The handle may have already been closed before a failed rename.
      }
      try {
        await unlink(staged.path);
      } catch {
        // Only this process can reach a reserved temporary path.
      }
      throw err;
    }
  }

  private async reserveAtomicTempFile(): Promise<{
    path: string;
    handle: Awaited<ReturnType<typeof open>>;
  }> {
    for (let attempt = 1; attempt <= 64; attempt += 1) {
      const temporary = `${this.file}.${process.pid}.${attempt}.tmp`;
      try {
        return { path: temporary, handle: await open(temporary, "wx", 0o600) };
      } catch (err) {
        if ((err as NodeError).code === "EEXIST") continue;
        throw err;
      }
    }
    throw new McpHostReceiptError(
      "MCP_RECEIPT_BUSY",
      "No se pudo reservar un archivo temporal seguro para los recibos MCP; reintentá la operación.",
    );
  }

  private lockFile(): string {
    return `${this.file}.lock`;
  }
}

/** The single user-scoped receipt book covers both workspace and global host entries. */
export function mcpHostReceiptFile(paths: PathsService): string {
  return join(paths.userDevDir(), "mcp-host-receipts.json");
}
