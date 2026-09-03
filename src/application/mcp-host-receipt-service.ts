import { isAbsolute } from "node:path";
import type { McpHost } from "../domain/mcp-entry.js";
import { normalizeMcpInstance, validateMcpInstance } from "../domain/mcp-entry.js";
import { carriesSecretMaterial, isSecretFlag } from "../domain/redaction.js";
import { canonicalJson, semanticDigest } from "./semantic-operation/protocol.js";

/**
 * Durable, secret-free evidence about a host MCP registration.
 *
 * This module deliberately owns receipt semantics only. Persistence is behind
 * {@link McpHostReceiptStore}, so callers such as setup, migration and the
 * stdio server do not each invent their own partial state or file protocol.
 */
export const MCP_HOST_RECEIPT_SCHEMA_VERSION = 1;

const MCP_HOSTS = ["claude", "codex", "warp", "gemini", "opencode", "crush", "kimi"] as const;

export type McpReceiptScope = "workspace" | "global";

export type McpLaunchProbePhase =
  | "spawn"
  | "initialize"
  | "initialized"
  | "tools/list"
  | "tools/call";

/** The launch material that is safe to seal. Environment is intentionally absent. */
export interface McpReceiptDescriptor {
  command: string;
  args: readonly string[];
}

export interface McpHostLoadObservation {
  observed_at: string;
  descriptor_digest: string;
}

/** A probe is evidence of launchability, never evidence that a host loaded the server. */
export interface McpLaunchProbeReceipt {
  observed_at: string;
  outcome: "passed" | "failed";
  phase: McpLaunchProbePhase;
}

/** A native host check is diagnostic evidence, never host-load evidence. */
export type McpNativeHostCheckFailureCode =
  | "HOST_BINARY_MISSING"
  | "HOST_NATIVE_CHECK_FAILED"
  | "HOST_ENTRY_NOT_VISIBLE";

/**
 * Failure-only evidence from a host's documented native MCP inspection.
 * A passing inspection clears this value rather than creating a success log.
 */
export interface McpNativeHostCheckFailure {
  observed_at: string;
  code: McpNativeHostCheckFailureCode;
}

export interface McpHostReceipt {
  schema_version: typeof MCP_HOST_RECEIPT_SCHEMA_VERSION;
  host: McpHost;
  scope: McpReceiptScope;
  connection: string;
  workline_version: string;
  descriptor_digest: string;
  registered_at: string;
  /** A host must reconnect/restart before the descriptor can be considered loaded. */
  reload_required: boolean;
  /** Set only by the server after it receives the MCP `initialized` notification. */
  last_host_load_observed?: McpHostLoadObservation;
  /** Kept distinct so a CLI probe cannot pretend that a host loaded the server. */
  last_launch_probe?: McpLaunchProbeReceipt;
  /** Failure-only evidence; a later passing native check removes this field. */
  last_native_check_failure?: McpNativeHostCheckFailure;
}

export interface McpHostReceiptBook {
  schema_version: typeof MCP_HOST_RECEIPT_SCHEMA_VERSION;
  receipts: McpHostReceipt[];
}

export interface McpReceiptIdentity {
  host: McpHost;
  scope: McpReceiptScope;
  connection: string;
}

export interface RegisterMcpHostReceipt extends McpReceiptIdentity {
  worklineVersion: string;
  descriptor: McpReceiptDescriptor;
  /** Injection point for deterministic callers; defaults to the current UTC instant. */
  registeredAt?: string;
}

export interface ObserveMcpHostLoad extends McpReceiptIdentity {
  /** Must equal the receipt's active descriptor digest; stale servers cannot clear reload_required. */
  descriptorDigest: string;
  observedAt?: string;
}

export interface RecordMcpLaunchProbe extends McpReceiptIdentity {
  outcome: "passed" | "failed";
  phase: McpLaunchProbePhase;
  /** When supplied, evidence may only attach to this exact persisted descriptor. */
  descriptorDigest?: string;
  observedAt?: string;
}

export interface RecordMcpNativeHostCheck extends McpReceiptIdentity {
  /** Native evidence may only attach to this exact persisted descriptor. */
  descriptorDigest: string;
  outcome: "passed" | "failed";
  /** Required for a failed check and forbidden for a passed one. */
  code?: McpNativeHostCheckFailureCode;
  observedAt?: string;
}

export interface McpHostReceiptTransaction<T> {
  receipts: McpHostReceipt[];
  result: T;
}

/**
 * Persistence seam. `update` must serialize a read-modify-write operation;
 * the service never reasons over a receipt book outside that operation.
 */
export interface McpHostReceiptStore {
  read(): Promise<readonly McpHostReceipt[]>;
  update<T>(
    transaction: (receipts: readonly McpHostReceipt[]) => McpHostReceiptTransaction<T>,
  ): Promise<T>;
}

export type McpHostReceiptErrorCode =
  | "MCP_RECEIPT_INVALID"
  | "MCP_RECEIPT_NOT_FOUND"
  | "MCP_RECEIPT_DESCRIPTOR_STALE"
  | "MCP_RECEIPT_SECRET_REJECTED"
  | "MCP_RECEIPT_MALFORMED"
  | "MCP_RECEIPT_BUSY";

/** Error text intentionally never quotes a descriptor, DSN, SQL, or user input. */
export class McpHostReceiptError extends Error {
  constructor(
    readonly code: McpHostReceiptErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpHostReceiptError";
  }
}

/**
 * Deep receipt module used by setup/migration and by the MCP server lifecycle.
 * A registration always revokes prior host-load proof and makes reload explicit.
 */
export class McpHostReceiptService {
  constructor(private readonly store: McpHostReceiptStore) {}

  async list(): Promise<readonly McpHostReceipt[]> {
    return await this.store.read();
  }

  async find(identity: McpReceiptIdentity): Promise<McpHostReceipt | undefined> {
    const key = normalizeIdentity(identity);
    return (await this.store.read()).find((receipt) => sameIdentity(receipt, key));
  }

  async register(input: RegisterMcpHostReceipt): Promise<McpHostReceipt> {
    const identity = normalizeIdentity(input);
    const descriptorDigest = digestMcpReceiptDescriptor(input.descriptor);
    const worklineVersion = requireVersion(input.worklineVersion);
    const registeredAt = requireInstant(input.registeredAt ?? new Date().toISOString());
    const receipt: McpHostReceipt = {
      schema_version: MCP_HOST_RECEIPT_SCHEMA_VERSION,
      ...identity,
      workline_version: worklineVersion,
      descriptor_digest: descriptorDigest,
      registered_at: registeredAt,
      reload_required: true,
    };

    return await this.store.update((receipts) => ({
      receipts: replaceReceipt(receipts, receipt),
      result: receipt,
    }));
  }

  /** Remove receipt evidence only after the matching host descriptor is gone. */
  async remove(identityInput: McpReceiptIdentity): Promise<boolean> {
    const identity = normalizeIdentity(identityInput);
    return await this.store.update((receipts) => {
      const remaining = receipts.filter((receipt) => !sameIdentity(receipt, identity));
      return { receipts: remaining, result: remaining.length !== receipts.length };
    });
  }

  /**
   * Record a real host lifecycle notification. A local probe cannot call this
   * truthfully: it must know the exact currently persisted descriptor digest.
   */
  async observeHostLoad(input: ObserveMcpHostLoad): Promise<McpHostReceipt> {
    const identity = normalizeIdentity(input);
    const descriptorDigest = requireDigest(input.descriptorDigest);
    const observedAt = requireInstant(input.observedAt ?? new Date().toISOString());

    return await this.store.update((receipts) => {
      const current = findReceipt(receipts, identity);
      if (current === undefined) {
        throw new McpHostReceiptError(
          "MCP_RECEIPT_NOT_FOUND",
          "No existe un recibo MCP para la conexión y host indicados.",
        );
      }
      if (current.descriptor_digest !== descriptorDigest) {
        throw new McpHostReceiptError(
          "MCP_RECEIPT_DESCRIPTOR_STALE",
          "El servidor corresponde a un descriptor MCP anterior; recargá el host antes de confirmarlo.",
        );
      }
      const next: McpHostReceipt = {
        ...current,
        reload_required: false,
        last_host_load_observed: { observed_at: observedAt, descriptor_digest: descriptorDigest },
      };
      return { receipts: replaceReceipt(receipts, next), result: next };
    });
  }

  /** Keep launchability separately from host loading, including its exact failing phase. */
  async recordLaunchProbe(input: RecordMcpLaunchProbe): Promise<McpHostReceipt> {
    const identity = normalizeIdentity(input);
    const observedAt = requireInstant(input.observedAt ?? new Date().toISOString());
    const phase = requireProbePhase(input.phase);
    const outcome = requireProbeOutcome(input.outcome);
    const expectedDescriptorDigest =
      input.descriptorDigest === undefined ? undefined : requireDigest(input.descriptorDigest);

    return await this.store.update((receipts) => {
      const current = findReceipt(receipts, identity);
      if (current === undefined) {
        throw new McpHostReceiptError(
          "MCP_RECEIPT_NOT_FOUND",
          "No existe un recibo MCP para la conexión y host indicados.",
        );
      }
      if (
        expectedDescriptorDigest !== undefined &&
        current.descriptor_digest !== expectedDescriptorDigest
      ) {
        throw new McpHostReceiptError(
          "MCP_RECEIPT_DESCRIPTOR_STALE",
          "El descriptor MCP cambió durante el probe; la evidencia no se registró.",
        );
      }
      const next: McpHostReceipt = {
        ...current,
        last_launch_probe: { observed_at: observedAt, outcome, phase },
      };
      return { receipts: replaceReceipt(receipts, next), result: next };
    });
  }

  /**
   * Record only a failed native inspection. A passing inspection deliberately
   * clears stale failure evidence, while the descriptor digest fences races
   * with a later host-config write.
   */
  async recordNativeHostCheck(input: RecordMcpNativeHostCheck): Promise<McpHostReceipt> {
    const identity = normalizeIdentity(input);
    const descriptorDigest = requireDigest(input.descriptorDigest);
    const outcome = requireNativeCheckOutcome(input.outcome);
    const code = nativeCheckFailureCodeFor(outcome, input.code);
    const observedAt = requireInstant(input.observedAt ?? new Date().toISOString());

    return await this.store.update((receipts) => {
      const current = findReceipt(receipts, identity);
      if (current === undefined) {
        throw new McpHostReceiptError(
          "MCP_RECEIPT_NOT_FOUND",
          "No existe un recibo MCP para la conexión y host indicados.",
        );
      }
      if (current.descriptor_digest !== descriptorDigest) {
        throw new McpHostReceiptError(
          "MCP_RECEIPT_DESCRIPTOR_STALE",
          "El descriptor MCP cambió durante la verificación nativa; la evidencia no se registró.",
        );
      }
      const next: McpHostReceipt =
        code === undefined
          ? withoutNativeCheckFailure(current)
          : { ...current, last_native_check_failure: { observed_at: observedAt, code } };
      return { receipts: replaceReceipt(receipts, next), result: next };
    });
  }
}

/**
 * The digest deliberately covers only the persisted, non-secret launch shape.
 * Rejecting credential-shaped values before hashing prevents a receipt from
 * becoming a stable fingerprint of a DSN that should never have been there.
 */
export function digestMcpReceiptDescriptor(descriptor: McpReceiptDescriptor): string {
  if (typeof descriptor.command !== "string" || !isAbsolute(descriptor.command)) {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_INVALID",
      "El descriptor MCP debe declarar una ruta absoluta al ejecutable de Node.",
    );
  }
  if (!Array.isArray(descriptor.args) || descriptor.args.length === 0) {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_INVALID",
      "El descriptor MCP debe declarar el entrypoint absoluto y sus argumentos.",
    );
  }
  if (!isAbsolute(descriptor.args[0] ?? "")) {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_INVALID",
      "El descriptor MCP debe declarar una ruta absoluta al entrypoint.",
    );
  }
  assertSecretFree(descriptor.command);
  for (const arg of descriptor.args) {
    if (typeof arg !== "string") {
      throw new McpHostReceiptError(
        "MCP_RECEIPT_INVALID",
        "El descriptor MCP contiene un argumento inválido.",
      );
    }
    assertSecretFree(arg);
    if (isSecretFlag(arg)) {
      throw new McpHostReceiptError(
        "MCP_RECEIPT_SECRET_REJECTED",
        "El recibo MCP rechazó un argumento que podría transportar una credencial.",
      );
    }
  }
  return `sha256:${semanticDigest({ command: descriptor.command, args: [...descriptor.args] })}`;
}

/** Parses persisted state fail-closed, without echoing a potentially secret file. */
export function parseMcpHostReceiptBook(raw: string): McpHostReceiptBook {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_MALFORMED",
      "El libro de recibos MCP no contiene JSON válido.",
    );
  }
  if (
    !isRecord(value) ||
    value.schema_version !== MCP_HOST_RECEIPT_SCHEMA_VERSION ||
    !Array.isArray(value.receipts)
  ) {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_MALFORMED",
      "El libro de recibos MCP tiene una versión o forma no reconocida.",
    );
  }
  const receipts = value.receipts.map(parseReceipt);
  const keys = new Set<string>();
  for (const receipt of receipts) {
    const key = receiptKey(receipt);
    if (keys.has(key)) {
      throw new McpHostReceiptError(
        "MCP_RECEIPT_MALFORMED",
        "El libro de recibos MCP contiene identidades duplicadas.",
      );
    }
    keys.add(key);
  }
  return { schema_version: MCP_HOST_RECEIPT_SCHEMA_VERSION, receipts: sortReceipts(receipts) };
}

/** Stable, newline-terminated bytes for atomic stores and readback comparison. */
export function serializeMcpHostReceiptBook(receipts: readonly McpHostReceipt[]): string {
  const book: McpHostReceiptBook = {
    schema_version: MCP_HOST_RECEIPT_SCHEMA_VERSION,
    receipts: sortReceipts(receipts),
  };
  // canonicalJson makes the digest/readback comparison deterministic across hosts.
  return `${canonicalJson(book)}\n`;
}

export function emptyMcpHostReceiptBook(): McpHostReceiptBook {
  return { schema_version: MCP_HOST_RECEIPT_SCHEMA_VERSION, receipts: [] };
}

function parseReceipt(value: unknown): McpHostReceipt {
  if (!isRecord(value) || value.schema_version !== MCP_HOST_RECEIPT_SCHEMA_VERSION) {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_MALFORMED",
      "Un recibo MCP tiene una forma no reconocida.",
    );
  }
  const identity = normalizeIdentity({
    host: value.host as McpHost,
    scope: value.scope as McpReceiptScope,
    connection: value.connection as string,
  });
  const worklineVersion = requireVersion(value.workline_version);
  const descriptorDigest = requireDigest(value.descriptor_digest);
  const registeredAt = requireInstant(value.registered_at);
  if (typeof value.reload_required !== "boolean") {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_MALFORMED",
      "Un recibo MCP no declara reload_required.",
    );
  }
  const base: McpHostReceipt = {
    schema_version: MCP_HOST_RECEIPT_SCHEMA_VERSION,
    ...identity,
    workline_version: worklineVersion,
    descriptor_digest: descriptorDigest,
    registered_at: registeredAt,
    reload_required: value.reload_required,
  };
  const observed = value.last_host_load_observed;
  const probe = value.last_launch_probe;
  const nativeFailure = value.last_native_check_failure;
  const parsedObservation = observed === undefined ? undefined : parseHostLoadObservation(observed);
  if (!value.reload_required && parsedObservation === undefined) {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_MALFORMED",
      "Un recibo MCP cargado no tiene una observación de host que lo respalde.",
    );
  }
  if (!value.reload_required && parsedObservation?.descriptor_digest !== descriptorDigest) {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_MALFORMED",
      "La observación de carga MCP no corresponde al descriptor vigente.",
    );
  }
  return {
    ...base,
    ...(parsedObservation === undefined ? {} : { last_host_load_observed: parsedObservation }),
    ...(probe === undefined ? {} : { last_launch_probe: parseLaunchProbe(probe) }),
    ...(nativeFailure === undefined
      ? {}
      : { last_native_check_failure: parseNativeHostCheckFailure(nativeFailure) }),
  };
}

function parseHostLoadObservation(value: unknown): McpHostLoadObservation {
  if (!isRecord(value)) {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_MALFORMED",
      "La observación de carga MCP es inválida.",
    );
  }
  return {
    observed_at: requireInstant(value.observed_at),
    descriptor_digest: requireDigest(value.descriptor_digest),
  };
}

function parseLaunchProbe(value: unknown): McpLaunchProbeReceipt {
  if (!isRecord(value) || (value.outcome !== "passed" && value.outcome !== "failed")) {
    throw new McpHostReceiptError("MCP_RECEIPT_MALFORMED", "El probe MCP registrado es inválido.");
  }
  return {
    observed_at: requireInstant(value.observed_at),
    outcome: value.outcome,
    phase: requireProbePhase(value.phase),
  };
}

function parseNativeHostCheckFailure(value: unknown): McpNativeHostCheckFailure {
  if (!isRecord(value)) {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_MALFORMED",
      "La evidencia nativa MCP registrada es inválida.",
    );
  }
  try {
    return {
      observed_at: requireInstant(value.observed_at),
      code: requireNativeCheckFailureCode(value.code),
    };
  } catch (error) {
    if (error instanceof McpHostReceiptError) {
      throw new McpHostReceiptError(
        "MCP_RECEIPT_MALFORMED",
        "La evidencia nativa MCP es inválida.",
      );
    }
    throw error;
  }
}

function normalizeIdentity(input: McpReceiptIdentity): McpReceiptIdentity {
  if (!MCP_HOSTS.includes(input.host)) {
    throw new McpHostReceiptError("MCP_RECEIPT_INVALID", "El host MCP indicado no es compatible.");
  }
  if (input.scope !== "workspace" && input.scope !== "global") {
    throw new McpHostReceiptError("MCP_RECEIPT_INVALID", "El scope del recibo MCP es inválido.");
  }
  if (typeof input.connection !== "string") {
    throw new McpHostReceiptError("MCP_RECEIPT_INVALID", "La conexión MCP es inválida.");
  }
  const connection = validateMcpInstance(input.connection);
  if (!connection.ok) {
    throw new McpHostReceiptError("MCP_RECEIPT_INVALID", "La conexión MCP es inválida.");
  }
  return {
    host: input.host,
    scope: input.scope,
    connection: normalizeMcpInstance(connection.value),
  };
}

function replaceReceipt(
  receipts: readonly McpHostReceipt[],
  replacement: McpHostReceipt,
): McpHostReceipt[] {
  return sortReceipts([
    ...receipts.filter((receipt) => !sameIdentity(receipt, replacement)),
    replacement,
  ]);
}

function withoutNativeCheckFailure(receipt: McpHostReceipt): McpHostReceipt {
  const { last_native_check_failure: _discarded, ...remaining } = receipt;
  return remaining;
}

function findReceipt(
  receipts: readonly McpHostReceipt[],
  identity: McpReceiptIdentity,
): McpHostReceipt | undefined {
  return receipts.find((receipt) => sameIdentity(receipt, identity));
}

function sameIdentity(left: McpReceiptIdentity, right: McpReceiptIdentity): boolean {
  return (
    left.host === right.host && left.scope === right.scope && left.connection === right.connection
  );
}

function sortReceipts(receipts: readonly McpHostReceipt[]): McpHostReceipt[] {
  return [...receipts].sort((left, right) => compareCodeUnits(receiptKey(left), receiptKey(right)));
}

function receiptKey(receipt: McpReceiptIdentity): string {
  return `${receipt.scope}\u0000${receipt.host}\u0000${receipt.connection}`;
}

function requireVersion(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_INVALID",
      "La versión Workline del recibo MCP es inválida.",
    );
  }
  assertSecretFree(value);
  return value.trim();
}

function requireDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_INVALID",
      "El digest del descriptor MCP es inválido.",
    );
  }
  return value;
}

function requireInstant(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_INVALID",
      "La marca temporal del recibo MCP es inválida.",
    );
  }
  return value;
}

function requireProbePhase(value: unknown): McpLaunchProbePhase {
  if (
    value !== "spawn" &&
    value !== "initialize" &&
    value !== "initialized" &&
    value !== "tools/list" &&
    value !== "tools/call"
  ) {
    throw new McpHostReceiptError("MCP_RECEIPT_INVALID", "La fase del probe MCP es inválida.");
  }
  return value;
}

function requireProbeOutcome(value: unknown): "passed" | "failed" {
  if (value !== "passed" && value !== "failed") {
    throw new McpHostReceiptError("MCP_RECEIPT_INVALID", "El resultado del probe MCP es inválido.");
  }
  return value;
}

function requireNativeCheckOutcome(value: unknown): "passed" | "failed" {
  if (value !== "passed" && value !== "failed") {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_INVALID",
      "El resultado de la verificación nativa MCP es inválido.",
    );
  }
  return value;
}

function nativeCheckFailureCodeFor(
  outcome: "passed" | "failed",
  value: unknown,
): McpNativeHostCheckFailureCode | undefined {
  if (outcome === "passed") {
    if (value !== undefined) {
      throw new McpHostReceiptError(
        "MCP_RECEIPT_INVALID",
        "Una verificación nativa MCP aprobada no puede declarar un fallo.",
      );
    }
    return undefined;
  }
  return requireNativeCheckFailureCode(value);
}

function requireNativeCheckFailureCode(value: unknown): McpNativeHostCheckFailureCode {
  if (
    value !== "HOST_BINARY_MISSING" &&
    value !== "HOST_NATIVE_CHECK_FAILED" &&
    value !== "HOST_ENTRY_NOT_VISIBLE"
  ) {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_INVALID",
      "El código de la verificación nativa MCP es inválido.",
    );
  }
  return value;
}

/**
 * A receipt never needs a connection URI or an assignment carrying credentials.
 *
 * The predicate itself lives in `domain/redaction.ts`: the custody gate over a
 * declared authentication flow asks the same question, and one expression with
 * two callers is the only way both surfaces keep rejecting the same thing.
 */
function assertSecretFree(value: string): void {
  if (carriesSecretMaterial(value)) {
    throw new McpHostReceiptError(
      "MCP_RECEIPT_SECRET_REJECTED",
      "El recibo MCP rechazó material que podría contener una credencial.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
