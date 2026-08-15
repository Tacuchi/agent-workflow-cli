// Launcher that resolves the DSN and spawns `npx -y @bytebase/dbhub`.
// stdin/stderr are inherited; stdout is piped so the dbhub startup banner never
// reaches the MCP JSON-RPC channel (see DbhubBannerFilter).
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { DsnResolution } from "./dsn-reader-service.js";
import { resolveExactDsn } from "./dsn-reader-service.js";
import {
  type StoredMcpConnection,
  resolveMcpConnectionSelection,
} from "./mcp-connections-service.js";
import type { PathsService } from "./paths-service.js";

export interface DbhubLauncherDeps {
  /** Returns process.env (or test override). */
  env: Record<string, string | undefined>;
  /** Path resolver — provides the dsn.env file location for the active namespace. */
  paths: PathsService;
  /** Returns `process.platform` (or test override). */
  platform: NodeJS.Platform;
  /**
   * Diagnostic sink. Defaults to process.stderr and must NEVER be stdout:
   * stdout is the MCP JSON-RPC channel of the spawned server.
   */
  stderr?: (chunk: string) => void;
  /**
   * This process's JSON-RPC channel. Defaults to process.stdout; injectable so
   * the drain-before-exit barrier can be exercised without a real pipe.
   */
  stdout?: NodeJS.WritableStream;
}

export type DbhubResolvedDsn = DsnResolution;

export class DbhubLauncherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbhubLauncherError";
  }
}

export function resolveDsn(
  instance: string | undefined,
  deps: DbhubLauncherDeps,
): DbhubResolvedDsn {
  const connection = resolveRegisteredConnection(instance, deps);
  let resolved: DsnResolution | null = null;
  let fileError: string | null = null;
  try {
    resolved = resolveExactDsn(connection.dsnVar, deps.env, deps.paths);
  } catch (err) {
    // An unreadable dsn.env (a directory in its place, a permission or race
    // error) surfaces as this launcher's own diagnostic naming the cause,
    // never as a raw fs throw and never as a silent "not found".
    fileError = err instanceof Error ? err.message : String(err);
  }
  if (resolved === null) {
    throw new DbhubLauncherError(buildUnresolvedDsnMessage(connection, deps, fileError));
  }
  return resolved;
}

function resolveRegisteredConnection(
  instance: string | undefined,
  deps: DbhubLauncherDeps,
): StoredMcpConnection {
  const selection = resolveMcpConnectionSelection(deps.paths, {
    ...(instance !== undefined ? { instance } : {}),
  });
  if (!selection.ok) throw new DbhubLauncherError(`[dbhub-mcp-runner] ${selection.message}`);
  const connection = selection.connections[0];
  if (connection === undefined) {
    throw new DbhubLauncherError("[dbhub-mcp-runner] la selección MCP no produjo una conexión");
  }
  return connection;
}

function buildUnresolvedDsnMessage(
  connection: StoredMcpConnection,
  deps: DbhubLauncherDeps,
  fileError: string | null,
): string {
  const dsnFile = deps.paths.userDsnFile();
  const where =
    fileError === null
      ? `primero en process.env y después en ${dsnFile}`
      : `primero en process.env; ${dsnFile} no se pudo leer (${fileError})`;
  return [
    `[dbhub-mcp-runner] no encontré el DSN de la conexión registrada '${connection.name}'.`,
    `La conexión exige ${connection.dsnVar} — ${where}.`,
    `Exportá ${connection.dsnVar} en ~/.zshenv (macOS/Linux) o System Environment (Windows)`,
    `y reabrí el host desde una terminal donde 'echo $${connection.dsnVar}' devuelva valor;`,
    `o actualizá su registro con 'aw self mcp use-env --name ${connection.name} --dsn-var <VARIABLE>'.`,
  ].join(" ");
}

function stderrWriter(deps: DbhubLauncherDeps): (chunk: string) => void {
  return (
    deps.stderr ??
    ((chunk: string): void => {
      process.stderr.write(chunk);
    })
  );
}

export interface DbhubStdoutRouting {
  /** Bytes that belong to the MCP JSON-RPC channel. */
  stdout: Buffer;
  /** Banner/diagnostic bytes — these must never reach stdout. */
  stderr: Buffer;
}

const NEWLINE = 0x0a;
const OPEN_BRACE = 0x7b;
const EMPTY_CHUNK = Buffer.alloc(0);
/** Narrow enough that a banner containing it verbatim is not a realistic risk. */
const JSONRPC_MARKER = Buffer.from('{"jsonrpc"');

/**
 * Splits dbhub's stdout into banner (stderr) and protocol (stdout).
 *
 * `@bytebase/dbhub` prints an ASCII banner on stdout before speaking JSON-RPC,
 * which corrupts the stdio channel every MCP client reads. Complete lines are
 * routed to stderr until the first one whose first non-blank byte is `{`; from
 * that line on the filter is `started` and the caller must hand the pipe over
 * raw, so the protocol is never re-sliced. Pure on purpose: testable without
 * spawning a process.
 */
export class DbhubBannerFilter {
  private pending: Buffer = EMPTY_CHUNK;
  private jsonStarted = false;

  /** True once the JSON-RPC stream began: the caller switches to raw passthrough. */
  get started(): boolean {
    return this.jsonStarted;
  }

  push(chunk: Buffer): DbhubStdoutRouting {
    if (this.jsonStarted) return { stdout: chunk, stderr: EMPTY_CHUNK };

    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    // A banner that does not end in a newline would otherwise swallow the first
    // message glued to its tail, so the protocol marker is a second and narrower
    // cut point: bytes before it are banner, bytes from it on are protocol.
    const marker = this.pending.indexOf(JSONRPC_MARKER);
    const banner: Buffer[] = [];
    let consumed = 0;
    let newline = this.pending.indexOf(NEWLINE, consumed);
    while (newline !== -1) {
      const line = this.pending.subarray(consumed, newline + 1);
      // A line that already opens the protocol is handed over from its first
      // byte, blanks included: the marker cut is for a banner glued to the
      // message, never an excuse to re-slice bytes that are already protocol.
      if (startsJsonRpc(line)) return this.startAt(consumed, consumed, banner);
      if (marker !== -1 && marker < newline) return this.startAt(marker, consumed, banner);
      banner.push(line);
      consumed = newline + 1;
      newline = this.pending.indexOf(NEWLINE, consumed);
    }
    if (marker !== -1) return this.startAt(marker, consumed, banner);
    this.pending = Buffer.from(this.pending.subarray(consumed));
    return { stdout: EMPTY_CHUNK, stderr: Buffer.concat(banner) };
  }

  /** Protocol starts at `cut`: [consumed, cut) is banner, [cut, …) goes out verbatim. */
  private startAt(cut: number, consumed: number, banner: Buffer[]): DbhubStdoutRouting {
    this.jsonStarted = true;
    if (cut > consumed) banner.push(this.pending.subarray(consumed, cut));
    const stdout = Buffer.from(this.pending.subarray(cut));
    this.pending = EMPTY_CHUNK;
    return { stdout, stderr: Buffer.concat(banner) };
  }

  /** Stream ended: anything still buffered never became a JSON line, so it is banner. */
  end(): DbhubStdoutRouting {
    const stderr = this.pending;
    this.pending = EMPTY_CHUNK;
    return { stdout: EMPTY_CHUNK, stderr };
  }
}

function startsJsonRpc(line: Buffer): boolean {
  for (const byte of line) {
    // Skip leading blanks (space, tab, CR, LF); a fully blank line is banner.
    if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === NEWLINE) continue;
    return byte === OPEN_BRACE;
  }
  return false;
}

export interface DbhubLauncherInput {
  instance?: string;
  deps: DbhubLauncherDeps;
}

export interface DbhubLauncherResult {
  exitCode: number;
}

/**
 * Resolves the DSN and spawns `npx -y @bytebase/dbhub`.
 * Resolves only when the spawned child exits.
 */
export async function runDbhubLauncher(input: DbhubLauncherInput): Promise<DbhubLauncherResult> {
  const { dsn } = resolveDsn(input.instance, input.deps);

  const isWin = input.deps.platform === "win32";
  const cmd = isWin ? "npx.cmd" : "npx";
  const protocol = input.deps.stdout ?? process.stdout;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, ["-y", "@bytebase/dbhub"], {
      stdio: ["inherit", "pipe", "inherit"],
      env: { ...input.deps.env, DSN: dsn },
      shell: isWin,
    });
    if (child.stdout === null) {
      reject(new DbhubLauncherError("[dbhub-mcp-runner] no pude capturar el stdout de dbhub"));
      return;
    }
    forwardDbhubStdout(child.stdout, {
      protocol,
      diagnostics: stderrWriter(input.deps),
    });
    child.on("error", (err) => reject(new DbhubLauncherError(`[dbhub-mcp-runner] ${err.message}`)));
    // `close`, not `exit`: `exit` fires before the child's stdout is drained, so
    // the tail of the protocol would still be in flight. And piping made a second
    // loss possible that `stdio: "inherit"` ruled out structurally — the child
    // used to write fd 1 itself, whereas now every byte is re-written through OUR
    // stdout, and the CLI ends with process.exit(), which drops whatever is still
    // queued on a pipe. The zero-length write is a drain barrier: its callback
    // runs once everything before it reached the OS.
    child.on("close", (code, signal) => {
      // Honor signal: emulate `process.kill(process.pid, signal)` from JS launcher
      // by mapping to a non-zero exit. The CLI command will exit with that code.
      const exitCode = signal ? 128 + (signalToNumber(signal) ?? 0) : (code ?? 0);
      protocol.write(EMPTY_CHUNK, () => resolve({ exitCode }));
    });
  });
}

export interface DbhubStdoutChannels {
  /** This process's MCP JSON-RPC channel (process.stdout in production). */
  protocol: NodeJS.WritableStream;
  /** Where banner bytes go — anywhere but the protocol channel. */
  diagnostics: (chunk: string) => void;
}

/**
 * Wires a dbhub stdout stream to this process's channels: banner lines to
 * diagnostics, protocol bytes to the protocol channel. Takes its channels as
 * parameters so the handover can be exercised without spawning anything.
 */
export function forwardDbhubStdout(source: Readable, channels: DbhubStdoutChannels): void {
  const filter = new DbhubBannerFilter();
  const onData = (chunk: Buffer): void => {
    const routed = filter.push(chunk);
    if (routed.stderr.length > 0) channels.diagnostics(routed.stderr.toString("utf-8"));
    if (routed.stdout.length > 0) channels.protocol.write(routed.stdout);
    if (!filter.started) return;
    // Protocol started: pause before detaching, so no chunk can be emitted
    // between removing the listener and attaching the pipe. `end: false` keeps
    // the child's EOF from closing our own stdout.
    source.pause();
    source.removeListener("data", onData);
    source.pipe(channels.protocol, { end: false });
  };
  source.on("data", onData);
  source.on("end", () => {
    const rest = filter.end();
    if (rest.stderr.length > 0) channels.diagnostics(rest.stderr.toString("utf-8"));
  });
}

function signalToNumber(signal: NodeJS.Signals): number | null {
  // Common signals; fallback to null (will produce exitCode 128 + 0 = 128).
  const map: Record<string, number> = {
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return map[signal] ?? null;
}
