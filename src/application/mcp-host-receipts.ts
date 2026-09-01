import type { McpEntry, McpHost } from "../domain/mcp-entry.js";
import { readPackageVersion } from "../runtime/version.js";
import {
  type McpHostReceipt,
  McpHostReceiptService,
  type McpReceiptScope,
} from "./mcp-host-receipt-service.js";
import { NodeMcpHostReceiptStore, mcpHostReceiptFile } from "./mcp-host-receipt-store.js";
import type { PathsService } from "./paths-service.js";

/** Creates the one namespaced, user-scoped receipt book used by MCP adapters. */
export function openMcpHostReceiptService(paths: PathsService): McpHostReceiptService {
  return new McpHostReceiptService(new NodeMcpHostReceiptStore(mcpHostReceiptFile(paths)));
}

export interface RegisterPersistedMcpDescriptor {
  host: McpHost;
  scope: McpReceiptScope;
  connection: string;
  entry: Pick<McpEntry, "command" | "args">;
}

/**
 * Registers a receipt only after a host config write has succeeded. The entry
 * is intentionally projected to command/args: env is neither persisted nor
 * hashed, so a DSN can never reach a receipt.
 */
export async function registerPersistedMcpDescriptor(
  paths: PathsService,
  input: RegisterPersistedMcpDescriptor,
): Promise<McpHostReceipt> {
  return await openMcpHostReceiptService(paths).register({
    host: input.host,
    scope: input.scope,
    connection: input.connection,
    worklineVersion: readPackageVersion(),
    descriptor: { command: input.entry.command, args: input.entry.args },
  });
}

export async function removePersistedMcpReceipt(
  paths: PathsService,
  identity: { host: McpHost; scope: McpReceiptScope; connection: string },
): Promise<boolean> {
  const service = openMcpHostReceiptService(paths);
  if ((await service.find(identity)) === undefined) return false;
  return await service.remove(identity);
}
