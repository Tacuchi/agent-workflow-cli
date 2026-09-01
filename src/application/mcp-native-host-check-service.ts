import { type SpawnSyncReturns, spawnSync as nodeSpawnSync } from "node:child_process";
import type { McpHost } from "../domain/mcp-entry.js";
import { classifyMcpEntry } from "./mcp-entry-classification.js";
import { readMcpEntry } from "./mcp-host-reader.js";
import {
  type McpNativeHostCheckFailureCode,
  type McpReceiptScope,
  digestMcpReceiptDescriptor,
} from "./mcp-host-receipt-service.js";
import { openMcpHostReceiptService } from "./mcp-host-receipts.js";
import type { McpReceiptProbeTarget } from "./mcp-receipt-registration-service.js";
import type { McpErrorRecord } from "./mcp-scope-common.js";
import type { PathsService } from "./paths-service.js";

const NATIVE_HOSTS = ["claude", "codex"] as const;
const NATIVE_CHECK_TIMEOUT_MS = 10_000;

export interface McpNativeHostCheck {
  host: (typeof NATIVE_HOSTS)[number];
  instance: string;
  outcome: "passed" | "failed";
  code?: McpNativeHostCheckFailureCode;
}

export interface McpNativeHostCheckBatch {
  checks: McpNativeHostCheck[];
  errors: McpErrorRecord[];
}

export interface NativeMcpHostCheckDeps {
  spawnSync?: (
    command: string,
    args: readonly string[],
    options: {
      env: NodeJS.ProcessEnv;
      encoding: "buffer";
      shell: false;
      stdio: ["ignore", "pipe", "pipe"];
      timeout: number;
      windowsHide: true;
    },
  ) => SpawnSyncReturns<Buffer>;
  environment?: NodeJS.ProcessEnv;
}

export interface RecordNativeMcpHostChecksInput {
  paths: PathsService;
  scope: McpReceiptScope;
  scopeDir: string;
  targets: readonly McpReceiptProbeTarget[];
  checks: readonly McpNativeHostCheck[];
}

/**
 * Verify that the two hosts with documented native inspection commands can
 * see the configured entry. Their output is deliberately never retained: it
 * could contain host-local diagnostics unrelated to Workline.
 */
export async function checkNativeMcpHosts(
  targets: readonly McpReceiptProbeTarget[],
  deps: NativeMcpHostCheckDeps = {},
): Promise<McpNativeHostCheckBatch> {
  const checks: McpNativeHostCheck[] = [];
  const errors: McpNativeHostCheckBatch["errors"] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    if (!isNativeHost(target.host)) continue;
    const key = `${target.host}:${target.instance}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const check = checkNativeMcpHost(target.host, target.instance, deps);
    checks.push(check);
    if (check.outcome === "passed") continue;
    errors.push({
      host: target.host,
      instance: target.instance,
      target: target.target,
      message: nativeCheckMessage(check.code),
    });
  }
  return { checks, errors };
}

/**
 * Best-effort persistence for native inspection failures. It rereads the exact
 * descriptor and fences the update with its digest, so a stale check can never
 * mark a replacement host configuration as failed. Passing checks clear only
 * prior native-failure evidence; they do not claim host load or launchability.
 */
export async function recordNativeMcpHostChecks(
  input: RecordNativeMcpHostChecksInput,
): Promise<void> {
  const receipts = openMcpHostReceiptService(input.paths);
  const targets = firstTargetsByIdentity(input.targets);
  for (const check of input.checks) {
    const target = targets.get(nativeCheckKey(check.host, check.instance));
    if (target === undefined) continue;
    await recordNativeMcpHostCheck(receipts, input.scopeDir, input.scope, target, check);
  }
}

function firstTargetsByIdentity(
  targets: readonly McpReceiptProbeTarget[],
): Map<string, McpReceiptProbeTarget> {
  const byIdentity = new Map<string, McpReceiptProbeTarget>();
  for (const target of targets) {
    const key = nativeCheckKey(target.host, target.instance);
    if (!byIdentity.has(key)) byIdentity.set(key, target);
  }
  return byIdentity;
}

function nativeCheckKey(host: McpHost, instance: string): string {
  return `${host}:${instance}`;
}

async function recordNativeMcpHostCheck(
  receipts: ReturnType<typeof openMcpHostReceiptService>,
  scopeDir: string,
  scope: McpReceiptScope,
  target: McpReceiptProbeTarget,
  check: McpNativeHostCheck,
): Promise<void> {
  try {
    const snapshot = readMcpEntry(target.host, scopeDir, target.instance, scope);
    if (!isCurrentNativeCheckDescriptor(target, snapshot)) return;
    const descriptorDigest = digestMcpReceiptDescriptor({
      command: snapshot.command,
      args: snapshot.args,
    });
    const identity = { host: target.host, scope, connection: target.instance };
    const receipt = await receipts.find(identity);
    if (receipt?.descriptor_digest !== descriptorDigest) return;
    await receipts.recordNativeHostCheck({
      ...identity,
      descriptorDigest,
      outcome: check.outcome,
      ...(check.code === undefined ? {} : { code: check.code }),
    });
  } catch {
    // Config/probe output stays truthful if a receipt update races or fails.
    // Native output and descriptor material must never enter an error report.
  }
}

function isCurrentNativeCheckDescriptor(
  target: McpReceiptProbeTarget,
  snapshot: ReturnType<typeof readMcpEntry>,
): snapshot is ReturnType<typeof readMcpEntry> & { command: string; args: string[] } {
  if (target.entry === undefined || snapshot.command === undefined || snapshot.args === undefined) {
    return false;
  }
  return (
    classifyMcpEntry(target.host, snapshot, target.entry, {
      name: target.instance,
      dsnVar: "",
    }).state === "current"
  );
}

function checkNativeMcpHost(
  host: (typeof NATIVE_HOSTS)[number],
  instance: string,
  deps: NativeMcpHostCheckDeps,
): McpNativeHostCheck {
  const spawnSync = deps.spawnSync ?? defaultSpawnSync;
  let result: SpawnSyncReturns<Buffer>;
  try {
    result = spawnSync(host, ["mcp", "list"], {
      env: deps.environment ?? process.env,
      encoding: "buffer",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: NATIVE_CHECK_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    return { host, instance, outcome: "failed", code: "HOST_NATIVE_CHECK_FAILED" };
  }
  if (readErrorCode(result.error) === "ENOENT") {
    return { host, instance, outcome: "failed", code: "HOST_BINARY_MISSING" };
  }
  if (result.error !== undefined || result.status !== 0) {
    return { host, instance, outcome: "failed", code: "HOST_NATIVE_CHECK_FAILED" };
  }
  const stdout = result.stdout?.toString("utf8") ?? "";
  return hasDelimitedInstance(stdout, instance)
    ? { host, instance, outcome: "passed" }
    : { host, instance, outcome: "failed", code: "HOST_ENTRY_NOT_VISIBLE" };
}

function hasDelimitedInstance(output: string, instance: string): boolean {
  // Native CLIs do not share a machine-readable list format. Fail closed on
  // the server-name token itself: qtc-cert-old must not prove qtc-cert loaded.
  const escaped = instance.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s|,:=\\[\\]"'])${escaped}(?=$|[\\s|,:=\\[\\]"'])`, "m").test(output);
}

function defaultSpawnSync(
  command: string,
  args: readonly string[],
  options: Parameters<typeof nodeSpawnSync>[2],
): SpawnSyncReturns<Buffer> {
  return nodeSpawnSync(command, args, options) as SpawnSyncReturns<Buffer>;
}

function isNativeHost(host: McpHost): host is (typeof NATIVE_HOSTS)[number] {
  return (NATIVE_HOSTS as readonly string[]).includes(host);
}

function readErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function nativeCheckMessage(code: McpNativeHostCheck["code"]): string {
  switch (code) {
    case "HOST_BINARY_MISSING":
      return "No se encontró el binario nativo del host para verificar su configuración MCP.";
    case "HOST_ENTRY_NOT_VISIBLE":
      return "El comando nativo del host no mostró la entrada MCP recién configurada.";
    default:
      return "El comando nativo del host no pudo verificar la configuración MCP.";
  }
}
