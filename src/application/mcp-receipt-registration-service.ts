import { type McpEntry, type McpHost, buildMcpEntry } from "../domain/mcp-entry.js";
import { readPackageVersion } from "../runtime/version.js";
import { classifyMcpEntry } from "./mcp-entry-classification.js";
import { readMcpEntry } from "./mcp-host-reader.js";
import { digestMcpReceiptDescriptor } from "./mcp-host-receipt-service.js";
import { openMcpHostReceiptService } from "./mcp-host-receipts.js";
import type { McpErrorRecord } from "./mcp-scope-common.js";
import type { McpSetupInput, McpSetupResult } from "./mcp-setup-service.js";
import type { PathsService } from "./paths-service.js";

export interface McpReceiptRegistration {
  host: string;
  instance: string;
  descriptor_digest: string;
  reload_required: true;
}

export interface McpReceiptRegistrationResult {
  registered: McpReceiptRegistration[];
  /** Internal launch targets for registrations that need fresh evidence. */
  probeTargets: McpReceiptProbeTarget[];
  errors: McpErrorRecord[];
}

export interface McpReceiptProbeTarget {
  host: McpHost;
  instance: string;
  target: string;
  /** Expected complete shape used to reject a post-write descriptor drift. */
  entry?: McpEntry;
}

interface ReceiptBuckets {
  registered: McpReceiptRegistration[];
  probeTargets: McpReceiptProbeTarget[];
  errors: McpErrorRecord[];
}

interface PersistedReceiptDescriptor {
  entry: McpEntry;
  descriptor: { command: string; args: string[] };
}

/**
 * Projects successful host config mutations into revocable, secret-free
 * receipts. Previews and idempotent writes deliberately leave prior state
 * untouched: neither is evidence of a new descriptor needing reload.
 */
export async function registerMcpSetupReceipts(
  paths: PathsService,
  input: McpSetupInput,
  result: McpSetupResult,
): Promise<McpReceiptRegistrationResult> {
  const buckets: ReceiptBuckets = { registered: [], probeTargets: [], errors: [] };
  // Workspace descriptors intentionally remain PATH-dependent and portable.
  // The receipt contract is reliable user-scope/TUI evidence only, avoiding a
  // user-global receipt identity being shared by separate workspaces.
  if (result.dry_run || input.scope !== "global") return buckets;
  const receipts = openMcpHostReceiptService(paths);
  const worklineVersion = readPackageVersion();
  for (const write of [...result.applied, ...result.skipped]) {
    await registerSetupWrite(receipts, input, result, write, worklineVersion, buckets);
  }
  return buckets;
}

async function registerSetupWrite(
  receipts: ReturnType<typeof openMcpHostReceiptService>,
  input: McpSetupInput,
  result: McpSetupResult,
  write: McpSetupResult["applied"][number],
  worklineVersion: string,
  buckets: ReceiptBuckets,
): Promise<void> {
  if (!isEligibleReceiptWrite(write)) return;
  const connection = input.connections.find((candidate) => candidate.name === write.name);
  if (connection === undefined) return;
  try {
    const persisted = readPersistedReceiptDescriptor(input, result, write, connection);
    if (persisted === undefined) return addReceiptReadbackError(buckets, write, connection.name);
    const existing = await receipts.find({
      host: write.host,
      scope: input.scope,
      connection: connection.name,
    });
    if (shouldKeepExistingReceipt(write.action, existing, persisted.descriptor)) return;
    const receipt = await receipts.register({
      host: write.host,
      scope: input.scope,
      connection: connection.name,
      worklineVersion,
      descriptor: persisted.descriptor,
    });
    buckets.registered.push({
      host: write.host,
      instance: connection.name,
      descriptor_digest: receipt.descriptor_digest,
      reload_required: true,
    });
    buckets.probeTargets.push({
      host: write.host,
      instance: connection.name,
      target: write.target,
      entry: persisted.entry,
    });
  } catch {
    buckets.errors.push({
      host: write.host,
      instance: connection.name,
      target: write.target,
      message: "No se pudo registrar el recibo MCP; la configuración requiere revisión manual.",
    });
  }
}

function isEligibleReceiptWrite(write: McpSetupResult["applied"][number]): boolean {
  return (
    (write.action === "written" || write.action === "skipped-idempotent") &&
    write.partial === undefined
  );
}

function readPersistedReceiptDescriptor(
  input: McpSetupInput,
  result: McpSetupResult,
  write: McpSetupResult["applied"][number],
  connection: McpSetupInput["connections"][number],
): PersistedReceiptDescriptor | undefined {
  const entry = entryFor(input, write.host, connection.name, connection.dsnVar);
  const snapshot = readMcpEntry(write.host, result.scope_dir, entry.name, input.scope);
  if (
    classifyMcpEntry(write.host, snapshot, entry, connection).state !== "current" ||
    snapshot.command === undefined ||
    snapshot.args === undefined
  ) {
    return undefined;
  }
  return { entry, descriptor: { command: snapshot.command, args: snapshot.args } };
}

function addReceiptReadbackError(
  buckets: ReceiptBuckets,
  write: McpSetupResult["applied"][number],
  instance: string,
): void {
  buckets.errors.push({
    host: write.host,
    instance,
    target: write.target,
    message:
      "La entrada MCP cambió antes de registrar el recibo; no se registró evidencia ni se debe recargar el host.",
  });
}

function shouldKeepExistingReceipt(
  action: McpSetupResult["applied"][number]["action"],
  existing: Awaited<ReturnType<ReturnType<typeof openMcpHostReceiptService>["find"]>>,
  descriptor: PersistedReceiptDescriptor["descriptor"],
): boolean {
  return (
    action === "skipped-idempotent" &&
    existing?.descriptor_digest === digestMcpReceiptDescriptor(descriptor)
  );
}

function entryFor(
  input: McpSetupInput,
  host: McpSetupInput["hosts"][number],
  name: string,
  dsnVar: string,
): McpEntry {
  return buildMcpEntry(name, dsnVar, {
    host,
    scope: input.scope,
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
  });
}
