import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import { MAX_TOOL_RESULT_BYTES } from "../domain/database-tools.js";

/** The protocol revision used by the local Workline MCP server. */
export const MCP_STDIO_PROBE_PROTOCOL_VERSION = "2025-06-18";

/**
 * `content[0].text` JSON-escapes the already bounded canonical response. A
 * control-character-heavy result can expand close to sixfold before JSON-RPC
 * framing, so the probe must not reject a valid 4 MiB tool contract.
 */
export const DEFAULT_MCP_STDIO_PROBE_MAX_FRAME_BYTES = MAX_TOOL_RESULT_BYTES * 6 + 64 * 1024;

export interface McpStdioProbeDescriptor {
  command: string;
  args: readonly string[];
  /** Descriptor-local environment only. It is never included in a result. */
  env?: Readonly<Record<string, string>>;
}

export type McpStdioProbeMode = "launch" | "data";

export type McpStdioProbePhase =
  | "spawn"
  | "initialize"
  | "initialized"
  | "tools/list"
  | "tools/call";

export type McpStdioProbeCode =
  | "INVALID_DESCRIPTOR"
  | "SPAWN_FAILED"
  | "PHASE_TIMEOUT"
  | "PROCESS_EXITED"
  | "STDIN_WRITE_FAILED"
  | "STDOUT_PROTOCOL_VIOLATION"
  | "STDOUT_FRAME_TOO_LARGE"
  | "SERVER_ERROR"
  | "INVALID_INITIALIZE_RESPONSE"
  | "PROTOCOL_VERSION_MISMATCH"
  | "INVALID_TOOLS_RESPONSE"
  | "TOOL_SCHEMA_MISMATCH"
  | "TOOL_MISSING"
  | "INVALID_DATA_RESPONSE"
  | "TOOL_CALL_FAILED";

export interface McpStdioProbeTimeouts {
  spawn: number;
  initialize: number;
  initialized: number;
  toolsList: number;
  toolsCall: number;
}

export const DEFAULT_MCP_STDIO_PROBE_TIMEOUTS: Readonly<McpStdioProbeTimeouts> = {
  spawn: 10_000,
  initialize: 10_000,
  initialized: 10_000,
  toolsList: 10_000,
  toolsCall: 30_000,
};

/** Only the stable descriptor fields take part in schema comparison. */
export interface McpStdioProbeExpectedTool {
  name: string;
  inputSchema: unknown;
}

export interface McpStdioProbeInput {
  /** Use the descriptor read back from the host configuration, never a reconstruction. */
  descriptor: McpStdioProbeDescriptor;
  mode?: McpStdioProbeMode;
  /** When supplied, the published set and every input schema must match exactly. */
  expectedTools?: readonly McpStdioProbeExpectedTool[];
  protocolVersion?: string;
  timeouts?: Partial<McpStdioProbeTimeouts>;
  /** Optional working directory for an explicitly persisted descriptor. */
  cwd?: string;
  maxFrameBytes?: number;
}

export interface McpStdioProbeSpawnOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
}

export type McpStdioProbeSpawner = (
  command: string,
  args: readonly string[],
  options: McpStdioProbeSpawnOptions,
) => ChildProcess;

export interface McpStdioProbeDeps {
  /** Injectable only to exercise protocol behavior; production uses node:child_process. */
  spawn?: McpStdioProbeSpawner;
  /** Base environment inherited by the descriptor. It is never recorded or returned. */
  environment?: NodeJS.ProcessEnv;
}

export interface McpStdioProbeSuccess {
  ok: true;
  mode: McpStdioProbeMode;
  protocol_version: string;
  tool_count: number;
  data_verified?: true;
}

export interface McpStdioProbeFailure {
  ok: false;
  mode: McpStdioProbeMode;
  phase: McpStdioProbePhase;
  code: McpStdioProbeCode;
  /** Intentionally generic: neither stderr nor any JSON-RPC payload is disclosed. */
  error: string;
}

export type McpStdioProbeResult = McpStdioProbeSuccess | McpStdioProbeFailure;

interface ResolvedProbeInput {
  descriptor: Required<McpStdioProbeDescriptor>;
  mode: McpStdioProbeMode;
  expectedTools: readonly McpStdioProbeExpectedTool[];
  protocolVersion: string;
  timeouts: McpStdioProbeTimeouts;
  maxFrameBytes: number;
  cwd?: string;
}

interface JsonRpcResponse {
  id: number;
  result: unknown;
}

interface PendingResponse {
  id: number;
  resolve: (value: JsonRpcResponse) => void;
  reject: (reason: ProbeFailure) => void;
}

interface PublishedTool {
  name: string;
  inputSchema: unknown;
}

class ProbeFailure extends Error {
  constructor(
    readonly phase: McpStdioProbePhase,
    readonly code: McpStdioProbeCode,
    message: string,
  ) {
    super(message);
    this.name = "ProbeFailure";
  }
}

/**
 * Launches a persisted stdio descriptor without a shell and proves the MCP
 * lifecycle. It never prints child stdout/stderr and deliberately returns no
 * tool payload, so a faulty server cannot put DSNs, SQL or rows into a doctor
 * report by echoing them.
 */
export async function runMcpStdioProbe(
  input: McpStdioProbeInput,
  deps: McpStdioProbeDeps = {},
): Promise<McpStdioProbeResult> {
  const mode = input.mode ?? "launch";
  const normalized = normalizeInput(input, mode);
  if (normalized instanceof ProbeFailure) return toFailure(mode, normalized);

  let child: ChildProcess | null = null;
  let session: McpStdioProbeSession | null = null;
  try {
    const spawner = deps.spawn ?? defaultSpawner;
    const options: McpStdioProbeSpawnOptions = {
      // The server uses this marker to keep a local launch probe separate from
      // an actual host `initialized` notification in its receipt ledger.
      env: {
        ...(deps.environment ?? process.env),
        ...normalized.descriptor.env,
        AW_MCP_PROBE: "1",
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(normalized.cwd === undefined ? {} : { cwd: normalized.cwd }),
    };
    child = spawner(normalized.descriptor.command, normalized.descriptor.args, options);
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new ProbeFailure(
        "spawn",
        "SPAWN_FAILED",
        "No se pudo abrir el transporte stdio del servidor MCP.",
      );
    }
    session = new McpStdioProbeSession(child, normalized);
    return await session.run();
  } catch (error) {
    if (error instanceof ProbeFailure) return toFailure(mode, error);
    return toFailure(
      mode,
      new ProbeFailure("spawn", "SPAWN_FAILED", "No se pudo iniciar el servidor MCP configurado."),
    );
  } finally {
    session?.terminate();
    if (session === null && child !== null) terminateChild(child);
  }
}

class McpStdioProbeSession {
  private decoder = new StringDecoder("utf8");
  private readonly failureWaiters = new Set<(reason: ProbeFailure) => void>();
  private lineBuffer = "";
  private stdoutBufferedBytes = 0;
  private nextId = 1;
  private pending: PendingResponse | null = null;
  private failure: ProbeFailure | null = null;
  private currentPhase: McpStdioProbePhase = "spawn";
  private finished = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly input: ResolvedProbeInput,
  ) {}

  async run(): Promise<McpStdioProbeSuccess> {
    this.attachListeners();
    await this.waitForSpawn();

    const initialized = await this.request("initialize", "initialize", {
      protocolVersion: this.input.protocolVersion,
      capabilities: {},
      clientInfo: { name: "agent-workflow-mcp-probe", version: "1" },
    });
    const protocolVersion = readProtocolVersion(initialized.result);
    if (protocolVersion === null) {
      throw new ProbeFailure(
        "initialize",
        "INVALID_INITIALIZE_RESPONSE",
        "El servidor MCP devolvió una inicialización inválida.",
      );
    }
    if (protocolVersion !== this.input.protocolVersion) {
      throw new ProbeFailure(
        "initialize",
        "PROTOCOL_VERSION_MISMATCH",
        "El servidor MCP negoció una versión de protocolo incompatible.",
      );
    }

    await this.notify("initialized", "notifications/initialized");

    const listed = await this.request("tools/list", "tools/list", {});
    const tools = readPublishedTools(listed.result);
    if (tools === null) {
      throw new ProbeFailure(
        "tools/list",
        "INVALID_TOOLS_RESPONSE",
        "El servidor MCP devolvió una lista de tools inválida.",
      );
    }
    if (!sameToolSchemas(tools, this.input.expectedTools)) {
      throw new ProbeFailure(
        "tools/list",
        "TOOL_SCHEMA_MISMATCH",
        "Las tools publicadas no coinciden con el catálogo esperado.",
      );
    }

    if (this.input.mode === "data") {
      if (!tools.some((tool) => tool.name === "execute_sql")) {
        throw new ProbeFailure(
          "tools/call",
          "TOOL_MISSING",
          "El servidor MCP no publicó la tool requerida para la verificación de datos.",
        );
      }
      const called = await this.request("tools/call", "tools/call", {
        name: "execute_sql",
        // Kept only on stdin. It is never included in any result or error.
        arguments: { sql: "SELECT 1 AS ok" },
      });
      const dataState = readDataProbeResult(called.result);
      if (dataState === "invalid") {
        throw new ProbeFailure(
          "tools/call",
          "INVALID_DATA_RESPONSE",
          "El servidor MCP devolvió una respuesta de datos inválida.",
        );
      }
      if (dataState === "failure") {
        throw new ProbeFailure(
          "tools/call",
          "TOOL_CALL_FAILED",
          "La verificación de datos del servidor MCP no se pudo completar.",
        );
      }
    }

    this.finished = true;
    return {
      ok: true,
      mode: this.input.mode,
      protocol_version: protocolVersion,
      tool_count: tools.length,
      ...(this.input.mode === "data" ? { data_verified: true } : {}),
    };
  }

  terminate(): void {
    this.finished = true;
    terminateChild(this.child);
  }

  private attachListeners(): void {
    const stdout = this.child.stdout;
    const stderr = this.child.stderr;
    if (stdout === null || stderr === null) {
      this.fail(
        new ProbeFailure(
          "spawn",
          "SPAWN_FAILED",
          "No se pudo abrir el transporte stdio del servidor MCP.",
        ),
      );
      return;
    }
    stdout.on("data", (chunk: Buffer | string) => this.onStdout(chunk));
    stdout.on("end", () => this.onStdoutEnd());
    stdout.on("error", () => {
      this.fail(
        new ProbeFailure(this.currentPhase, "PROCESS_EXITED", "El servidor MCP cerró su salida."),
      );
    });
    // Stderr can contain a driver error with credentials. Drain it, never store
    // or forward it.
    stderr.resume();
    stderr.on("error", () => {});
    this.child.on("error", () => {
      this.fail(
        new ProbeFailure(
          this.currentPhase,
          "SPAWN_FAILED",
          "No se pudo iniciar el servidor MCP configurado.",
        ),
      );
    });
    this.child.on("exit", () => {
      this.fail(
        new ProbeFailure(
          this.currentPhase,
          "PROCESS_EXITED",
          "El servidor MCP terminó antes de completar el probe.",
        ),
      );
    });
    this.child.on("close", () => {
      this.fail(
        new ProbeFailure(
          this.currentPhase,
          "PROCESS_EXITED",
          "El servidor MCP cerró antes de completar el probe.",
        ),
      );
    });
  }

  private async waitForSpawn(): Promise<void> {
    // Node assigns pid before emitting `spawn`. Treat that as launched so a
    // synchronous test double cannot lose the event between spawn() and this
    // listener; a later child error still fails the active protocol phase.
    if (this.child.pid !== undefined) return;
    const spawned = new Promise<void>((resolve) => {
      this.child.once("spawn", resolve);
    });
    await this.withPhaseTimeout("spawn", this.input.timeouts.spawn, spawned);
  }

  private async request(
    phase: "initialize" | "tools/list" | "tools/call",
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<JsonRpcResponse>((resolve, reject) => {
      const pending: PendingResponse = { id, resolve, reject };
      this.pending = pending;
      this.write({ jsonrpc: "2.0", id, method, params }, phase, pending);
    });
    try {
      return await this.withPhaseTimeout(phase, timeoutFor(this.input.timeouts, phase), response);
    } finally {
      if (this.pending?.id === id) this.pending = null;
    }
  }

  private async notify(phase: "initialized", method: string): Promise<void> {
    const write = new Promise<void>((resolve, reject) => {
      this.write({ jsonrpc: "2.0", method }, phase, null, resolve, reject);
    });
    await this.withPhaseTimeout(phase, this.input.timeouts.initialized, write);
  }

  private write(
    message: Record<string, unknown>,
    phase: McpStdioProbePhase,
    pending: PendingResponse | null,
    onWritten?: () => void,
    onWriteFailure?: (reason: ProbeFailure) => void,
  ): void {
    const stdin = this.child.stdin;
    if (stdin === null) {
      const failure = new ProbeFailure(
        phase,
        "STDIN_WRITE_FAILED",
        "No se pudo escribir al servidor MCP.",
      );
      if (pending !== null) pending.reject(failure);
      else onWriteFailure?.(failure);
      return;
    }
    try {
      stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error === undefined || error === null) {
          onWritten?.();
          return;
        }
        const failure = new ProbeFailure(
          phase,
          "STDIN_WRITE_FAILED",
          "No se pudo escribir al servidor MCP.",
        );
        if (pending !== null && this.pending === pending) pending.reject(failure);
        else onWriteFailure?.(failure);
      });
    } catch {
      const failure = new ProbeFailure(
        phase,
        "STDIN_WRITE_FAILED",
        "No se pudo escribir al servidor MCP.",
      );
      if (pending !== null) pending.reject(failure);
      else onWriteFailure?.(failure);
    }
  }

  private async withPhaseTimeout<T>(
    phase: McpStdioProbePhase,
    timeoutMs: number,
    operation: Promise<T>,
  ): Promise<T> {
    this.currentPhase = phase;
    if (this.failure !== null) throw this.failure;
    const deferred = this.waitForFailure();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ProbeFailure(phase, "PHASE_TIMEOUT", "El servidor MCP no respondió a tiempo."));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation, deferred.promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      deferred.dispose();
    }
  }

  private waitForFailure(): { promise: Promise<never>; dispose: () => void } {
    let rejectWaiter: ((reason: ProbeFailure) => void) | null = null;
    const promise = new Promise<never>((_resolve, reject) => {
      rejectWaiter = reject;
      if (this.failure !== null) {
        reject(this.failure);
        return;
      }
      this.failureWaiters.add(reject);
    });
    return {
      promise,
      dispose: () => {
        if (rejectWaiter !== null) this.failureWaiters.delete(rejectWaiter);
      },
    };
  }

  private onStdout(chunk: Buffer | string): void {
    if (this.finished || this.failure !== null) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline < 0 ? bytes.length : newline + 1;
      const segment = bytes.subarray(offset, end);
      // Split raw bytes before decoding: a single giant completed line must
      // fail without allocating a decoded string just to discover its size.
      if (this.stdoutBufferedBytes + segment.length > this.input.maxFrameBytes) {
        this.fail(
          new ProbeFailure(
            this.currentPhase,
            "STDOUT_FRAME_TOO_LARGE",
            "El servidor MCP excedió el límite de salida del probe.",
          ),
        );
        return;
      }
      this.stdoutBufferedBytes += segment.length;
      this.lineBuffer += this.decoder.write(segment);
      if (newline >= 0) {
        const line = this.lineBuffer.slice(0, -1).replace(/\r$/, "");
        this.lineBuffer = "";
        this.stdoutBufferedBytes = 0;
        this.acceptLine(line);
        if (this.failure !== null) return;
      }
      offset = end;
    }
  }

  private onStdoutEnd(): void {
    if (this.finished || this.failure !== null) return;
    const tail = this.decoder.end();
    if (tail.length > 0) this.lineBuffer += tail;
    if (this.lineBuffer.length > 0) {
      this.fail(
        new ProbeFailure(
          this.currentPhase,
          "STDOUT_PROTOCOL_VIOLATION",
          "El stdout del servidor MCP no contiene JSON-RPC lineal válido.",
        ),
      );
      return;
    }
    this.fail(
      new ProbeFailure(this.currentPhase, "PROCESS_EXITED", "El servidor MCP cerró su salida."),
    );
  }

  private acceptLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(
        new ProbeFailure(
          this.currentPhase,
          "STDOUT_PROTOCOL_VIOLATION",
          "El stdout del servidor MCP no contiene JSON-RPC lineal válido.",
        ),
      );
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      this.fail(
        new ProbeFailure(
          this.currentPhase,
          "STDOUT_PROTOCOL_VIOLATION",
          "El stdout del servidor MCP no contiene JSON-RPC lineal válido.",
        ),
      );
      return;
    }
    const pending = this.pending;
    if (pending === null || message.id !== pending.id) return;
    if (Object.hasOwn(message, "error")) {
      pending.reject(
        new ProbeFailure(
          this.currentPhase,
          "SERVER_ERROR",
          "El servidor MCP rechazó una fase del probe.",
        ),
      );
      return;
    }
    if (!Object.hasOwn(message, "result")) {
      pending.reject(
        new ProbeFailure(
          this.currentPhase,
          "STDOUT_PROTOCOL_VIOLATION",
          "El servidor MCP devolvió una respuesta JSON-RPC inválida.",
        ),
      );
      return;
    }
    pending.resolve({ id: pending.id, result: message.result });
  }

  private fail(failure: ProbeFailure): void {
    if (this.finished || this.failure !== null) return;
    this.failure = failure;
    if (this.pending !== null) this.pending.reject(failure);
    for (const reject of this.failureWaiters) reject(failure);
    this.failureWaiters.clear();
  }
}

function defaultSpawner(
  command: string,
  args: readonly string[],
  options: McpStdioProbeSpawnOptions,
): ChildProcess {
  return nodeSpawn(command, args, options);
}

function normalizeInput(
  input: McpStdioProbeInput,
  mode: McpStdioProbeMode,
): ResolvedProbeInput | ProbeFailure {
  const descriptor = input.descriptor;
  if (
    !isRecord(descriptor) ||
    typeof descriptor.command !== "string" ||
    descriptor.command.trim().length === 0 ||
    !isAbsolute(descriptor.command) ||
    !Array.isArray(descriptor.args) ||
    !isAbsolute(descriptor.args[0] ?? "") ||
    descriptor.args.some((arg) => typeof arg !== "string") ||
    (descriptor.env !== undefined && !allStrings(descriptor.env))
  ) {
    return new ProbeFailure(
      "spawn",
      "INVALID_DESCRIPTOR",
      "El descriptor MCP persistido es inválido.",
    );
  }
  const protocolVersion = input.protocolVersion ?? MCP_STDIO_PROBE_PROTOCOL_VERSION;
  if (protocolVersion.trim().length === 0) {
    return new ProbeFailure(
      "initialize",
      "INVALID_DESCRIPTOR",
      "El protocolo MCP solicitado es inválido.",
    );
  }
  const maxFrameBytes = input.maxFrameBytes ?? DEFAULT_MCP_STDIO_PROBE_MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    return new ProbeFailure(
      "spawn",
      "INVALID_DESCRIPTOR",
      "El límite de salida del probe es inválido.",
    );
  }
  const timeouts = resolveTimeouts(input.timeouts);
  if (timeouts === null) {
    return new ProbeFailure("spawn", "INVALID_DESCRIPTOR", "Los timeouts del probe son inválidos.");
  }
  const expectedTools = input.expectedTools ?? [];
  if (
    expectedTools.some((tool) => !isExpectedTool(tool)) ||
    new Set(expectedTools.map((tool) => tool.name)).size !== expectedTools.length
  ) {
    return new ProbeFailure(
      "tools/list",
      "INVALID_DESCRIPTOR",
      "El catálogo esperado para el probe es inválido.",
    );
  }
  return {
    descriptor: {
      command: descriptor.command,
      args: [...descriptor.args],
      env: { ...(descriptor.env ?? {}) },
    },
    mode,
    expectedTools,
    protocolVersion,
    timeouts,
    maxFrameBytes,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  };
}

function resolveTimeouts(
  values: Partial<McpStdioProbeTimeouts> | undefined,
): McpStdioProbeTimeouts | null {
  const candidate: McpStdioProbeTimeouts = {
    spawn: values?.spawn ?? DEFAULT_MCP_STDIO_PROBE_TIMEOUTS.spawn,
    initialize: values?.initialize ?? DEFAULT_MCP_STDIO_PROBE_TIMEOUTS.initialize,
    initialized: values?.initialized ?? DEFAULT_MCP_STDIO_PROBE_TIMEOUTS.initialized,
    toolsList: values?.toolsList ?? DEFAULT_MCP_STDIO_PROBE_TIMEOUTS.toolsList,
    toolsCall: values?.toolsCall ?? DEFAULT_MCP_STDIO_PROBE_TIMEOUTS.toolsCall,
  };
  return Object.values(candidate).every((timeout) => Number.isSafeInteger(timeout) && timeout > 0)
    ? candidate
    : null;
}

function timeoutFor(
  timeouts: McpStdioProbeTimeouts,
  phase: "initialize" | "tools/list" | "tools/call",
): number {
  switch (phase) {
    case "initialize":
      return timeouts.initialize;
    case "tools/list":
      return timeouts.toolsList;
    case "tools/call":
      return timeouts.toolsCall;
  }
}

function readProtocolVersion(value: unknown): string | null {
  if (
    !isRecord(value) ||
    typeof value.protocolVersion !== "string" ||
    value.protocolVersion.length === 0
  ) {
    return null;
  }
  return value.protocolVersion;
}

function readPublishedTools(value: unknown): PublishedTool[] | null {
  if (!isRecord(value) || !Array.isArray(value.tools)) return null;
  const tools: PublishedTool[] = [];
  const names = new Set<string>();
  for (const item of value.tools) {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      item.name.length === 0 ||
      !Object.hasOwn(item, "inputSchema")
    ) {
      return null;
    }
    if (names.has(item.name)) return null;
    names.add(item.name);
    tools.push({ name: item.name, inputSchema: item.inputSchema });
  }
  return tools;
}

function sameToolSchemas(
  published: readonly PublishedTool[],
  expected: readonly McpStdioProbeExpectedTool[],
): boolean {
  if (expected.length === 0) return true;
  if (published.length !== expected.length) return false;
  return expected.every((required) => {
    const actual = published.find((tool) => tool.name === required.name);
    return actual !== undefined && isDeepStrictEqual(actual.inputSchema, required.inputSchema);
  });
}

function readDataProbeResult(value: unknown): "success" | "failure" | "invalid" {
  if (!isRecord(value) || !Array.isArray(value.content)) return "invalid";
  const content = value.content[0];
  if (
    !isRecord(content) ||
    content.type !== "text" ||
    content.mimeType !== "application/json" ||
    typeof content.text !== "string"
  ) {
    return "invalid";
  }
  try {
    const body: unknown = JSON.parse(content.text);
    if (!isRecord(body) || typeof body.success !== "boolean") return "invalid";
    if (!body.success || value.isError === true) return "failure";
    return isSelectOneProbePayload(body.data) ? "success" : "invalid";
  } catch {
    return "invalid";
  }
}

/** The data probe is proof of the canonical SELECT 1 response, not just a claim of success. */
function isSelectOneProbePayload(data: unknown): boolean {
  if (!isRecord(data) || !Array.isArray(data.statements) || data.statements.length !== 1)
    return false;
  const statement = data.statements[0];
  if (!isRecord(statement) || statement.sql !== "SELECT 1 AS ok" || statement.count !== 1)
    return false;
  if (!Array.isArray(statement.rows) || statement.rows.length !== 1) return false;
  const row = statement.rows[0];
  return isRecord(row) && row.ok === 1;
}

function isExpectedTool(value: unknown): value is McpStdioProbeExpectedTool {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    Object.hasOwn(value, "inputSchema")
  );
}

function allStrings(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toFailure(mode: McpStdioProbeMode, failure: ProbeFailure): McpStdioProbeFailure {
  return {
    ok: false,
    mode,
    phase: failure.phase,
    code: failure.code,
    error: failure.message,
  };
}

function terminateChild(child: ChildProcess): void {
  try {
    child.stdin?.end();
  } catch {
    // The process may have exited between the probe and cleanup.
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Best effort only. The caller already has the probe result.
  }
}
