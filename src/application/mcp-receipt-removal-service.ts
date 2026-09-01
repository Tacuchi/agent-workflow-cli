import { buildMcpEntry } from "../domain/mcp-entry.js";
import { classifyMcpEntry } from "./mcp-entry-classification.js";
import { readMcpEntry } from "./mcp-host-reader.js";
import { removePersistedMcpReceipt } from "./mcp-host-receipts.js";
import type { McpRemoveInput, McpRemoveResult } from "./mcp-remove-service.js";
import type { McpErrorRecord } from "./mcp-scope-common.js";
import type { PathsService } from "./paths-service.js";

/** Keeps descriptor retirement symmetric with registration without touching previews. */
export async function removeMcpRemoveReceipts(
  paths: PathsService,
  input: McpRemoveInput,
  result: McpRemoveResult,
): Promise<McpErrorRecord[]> {
  if (result.dry_run || input.scope !== "global") return [];
  const errors: McpErrorRecord[] = [];
  for (const write of [...result.removed, ...result.skipped]) {
    await removeReceiptForWrite(paths, input, result, write, errors);
  }
  return errors;
}

async function removeReceiptForWrite(
  paths: PathsService,
  input: McpRemoveInput,
  result: McpRemoveResult,
  write: McpRemoveResult["removed"][number],
  errors: McpErrorRecord[],
): Promise<void> {
  if (!isEligibleReceiptRemoval(write)) return;
  const connection = input.connections.find((candidate) => candidate.name === write.name);
  if (connection === undefined) return;
  try {
    if (!isRemovedDescriptor(input, result, write, connection)) {
      addReappearedDescriptorError(errors, write, connection.name);
      return;
    }
    await removePersistedMcpReceipt(paths, {
      host: write.host,
      scope: input.scope,
      connection: connection.name,
    });
  } catch {
    errors.push({
      host: write.host,
      instance: connection.name,
      target: write.target,
      message: "La entrada MCP se retiró, pero no se pudo retirar su recibo operativo.",
    });
  }
}

function isEligibleReceiptRemoval(write: McpRemoveResult["removed"][number]): boolean {
  return (
    (write.action === "removed" || write.action === "skipped-idempotent") &&
    write.partial === undefined
  );
}

function isRemovedDescriptor(
  input: McpRemoveInput,
  result: McpRemoveResult,
  write: McpRemoveResult["removed"][number],
  connection: McpRemoveInput["connections"][number],
): boolean {
  const entry = buildMcpEntry(connection.name, connection.dsnVar, {
    host: write.host,
    scope: input.scope,
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
  });
  const snapshot = readMcpEntry(write.host, result.scope_dir, entry.name, input.scope);
  return classifyMcpEntry(write.host, snapshot, entry, connection).state === "missing";
}

function addReappearedDescriptorError(
  errors: McpErrorRecord[],
  write: McpRemoveResult["removed"][number],
  instance: string,
): void {
  errors.push({
    host: write.host,
    instance,
    target: write.target,
    message:
      "La entrada MCP reapareció antes de retirar el recibo; se conserva la evidencia operativa.",
  });
}
