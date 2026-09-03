/**
 * What the host itself says about its MCP servers.
 *
 * The CLI already runs these two commands and deliberately throws their output
 * away (`checkNativeMcpHosts`), because there it only needed a yes/no about one
 * entry. A doctor needs the opposite: the host's own verdict per server, ours
 * and other people's alike, because an MCP that fails to connect is a problem
 * the person has whether or not Workline wrote it.
 *
 * Both parsers fail CLOSED. Codex publishes JSON and Claude publishes prose with
 * no contract at all, so a line whose mark is not recognized becomes
 * `unverified` — never `connected`. A doctor that guesses health from an
 * unfamiliar format is worse than one that says it could not tell.
 */
import { type SpawnSyncReturns, spawnSync as nodeSpawnSync } from "node:child_process";

export const NATIVE_MCP_HOSTS = ["claude", "codex"] as const;
export type NativeMcpHost = (typeof NATIVE_MCP_HOSTS)[number];

/** How the host reports one server. `unverified` is the fail-closed answer. */
export type NativeServerHealth = "connected" | "failed" | "disabled" | "needs-auth" | "unverified";

export interface NativeMcpServerState {
  host: NativeMcpHost;
  name: string;
  health: NativeServerHealth;
  /** The host's own reason, never its command line and never a value. */
  detail: string | null;
  /** Codex reports authentication per server; Claude does not. */
  auth_status: string | null;
  transport: string | null;
}

/**
 * Why a read did not happen, and it is two different things.
 *
 * `absent` is "there is no binary to ask" — the normal, expected state of a host
 * whose runtime was uninstalled and left its config dir behind. `failed` is "the
 * binary is here and the question did not work". Collapsing them into one reason
 * string is what turned an orphaned config directory into a fallen provider, and
 * with it a healthy environment into exit code 1.
 */
export type NativeReadFailure = "absent" | "failed";

export type NativeHostRead =
  | { ok: true; host: NativeMcpHost; servers: NativeMcpServerState[] }
  | { ok: false; host: NativeMcpHost; failure: NativeReadFailure; reason: string };

export interface NativeHostRunResult {
  status: number | null;
  stdout: string;
  /** `ENOENT` when the binary is not installed. */
  errorCode: string | null;
  timedOut: boolean;
}

export interface NativeHostDeps {
  run?: (command: string, args: readonly string[], timeoutMs: number) => NativeHostRunResult;
  timeoutMs?: number;
}

/**
 * The ceiling. `claude mcp list` CONNECTS every server to report its health, so
 * the diagnostic phase pays for the slowest one; without a bound a single hung
 * server would hold the whole report.
 */
export const NATIVE_READ_TIMEOUT_MS = 15_000;

export function readNativeMcpState(host: NativeMcpHost, deps: NativeHostDeps = {}): NativeHostRead {
  const run = deps.run ?? defaultRun;
  const args = host === "codex" ? ["mcp", "list", "--json"] : ["mcp", "list"];
  const result = run(host, args, deps.timeoutMs ?? NATIVE_READ_TIMEOUT_MS);
  if (result.errorCode === "ENOENT") {
    return {
      ok: false,
      host,
      failure: "absent",
      reason: `el binario '${host}' no está en el PATH`,
    };
  }
  if (result.timedOut) {
    return {
      ok: false,
      host,
      failure: "failed",
      reason: `'${host} ${args.join(" ")}' no respondió dentro del límite`,
    };
  }
  if (result.errorCode !== null || result.status !== 0) {
    return {
      ok: false,
      host,
      failure: "failed",
      reason: `'${host} ${args.join(" ")}' terminó con código ${result.status ?? "desconocido"}`,
    };
  }
  return host === "codex" ? parseCodexMcpList(result.stdout) : parseClaudeMcpList(result.stdout);
}

export function parseCodexMcpList(stdout: string): NativeHostRead {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      host: "codex",
      failure: "failed",
      reason: "la salida de 'codex mcp list --json' no es JSON",
    };
  }
  if (!Array.isArray(data)) {
    return {
      ok: false,
      host: "codex",
      failure: "failed",
      reason: "'codex mcp list --json' no devolvió una lista",
    };
  }
  const servers: NativeMcpServerState[] = [];
  for (const raw of data) {
    if (!isRecord(raw) || typeof raw.name !== "string") continue;
    servers.push({
      host: "codex",
      name: raw.name,
      health: codexHealth(raw),
      detail: typeof raw.disabled_reason === "string" ? raw.disabled_reason : null,
      auth_status: typeof raw.auth_status === "string" ? raw.auth_status : null,
      transport: transportType(raw.transport),
    });
  }
  return { ok: true, host: "codex", servers };
}

/**
 * Codex reports availability and credentials separately, and so does this.
 *
 * `enabled: false` is a deliberate state, not a fault — folding it into "failed"
 * would put a warning on something the person turned off on purpose. A missing
 * or non-boolean `enabled` is the fail-closed case: the shape moved and nobody
 * can say what it means now.
 */
function codexHealth(raw: Record<string, unknown>): NativeServerHealth {
  if (raw.enabled === false) return "disabled";
  if (raw.enabled !== true) return "unverified";
  return raw.auth_status === "not_logged_in" ? "needs-auth" : "connected";
}

function transportType(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.type === "string") return value.type;
  return null;
}

/**
 * Claude publishes prose. Every mark it is known to print is listed here, and
 * anything else is `unverified` with the status text it did print.
 *
 * The table carries more marks than one capture shows on purpose: the observed
 * output uses `!` for the authentication case where an earlier capture showed
 * `⏸`, and a parser that only knows the marks of the machine it was written on
 * mis-reads the next version as healthy or as broken.
 */
const CLAUDE_MARKS: ReadonlyArray<{ mark: string; health: NativeServerHealth }> = [
  { mark: "✔", health: "connected" },
  { mark: "✓", health: "connected" },
  { mark: "✘", health: "failed" },
  { mark: "✗", health: "failed" },
  { mark: "⊘", health: "disabled" },
  { mark: "⏸", health: "needs-auth" },
  { mark: "!", health: "needs-auth" },
];

export function parseClaudeMcpList(stdout: string): NativeHostRead {
  const servers: NativeMcpServerState[] = [];
  for (const line of stdout.split("\n")) {
    const parsed = parseClaudeLine(line);
    if (parsed !== null) servers.push(parsed);
  }
  return { ok: true, host: "claude", servers };
}

function parseClaudeLine(line: string): NativeMcpServerState | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  // The name is the first whitespace-free token and it ends in a colon. Plugin
  // servers are named `plugin:<pkg>:<server>`, so splitting on the FIRST colon
  // would call every one of them `plugin`.
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace <= 0) return null;
  const token = trimmed.slice(0, firstSpace);
  if (!token.endsWith(":")) return null;
  const name = token.slice(0, -1);
  if (name.length === 0) return null;

  // The status sits at the end, after the last " - ". The command in between is
  // deliberately not retained: it is the host's business, it can be long, and a
  // report has no use for it.
  const cut = trimmed.lastIndexOf(" - ");
  const status = cut === -1 ? "" : trimmed.slice(cut + 3).trim();
  const known = CLAUDE_MARKS.find((candidate) => status.startsWith(candidate.mark));
  if (known === undefined) {
    return {
      host: "claude",
      name,
      health: "unverified",
      detail: status.length === 0 ? "formato de línea no reconocido" : status,
      auth_status: null,
      transport: null,
    };
  }
  const detail = status.slice(known.mark.length).trim();
  return {
    host: "claude",
    name,
    health: known.health,
    detail: detail.length === 0 ? null : detail,
    auth_status: null,
    transport: null,
  };
}

function defaultRun(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): NativeHostRunResult {
  let result: SpawnSyncReturns<Buffer>;
  try {
    result = nodeSpawnSync(command, [...args], {
      encoding: "buffer",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true,
    }) as SpawnSyncReturns<Buffer>;
  } catch {
    return { status: null, stdout: "", errorCode: "SPAWN_FAILED", timedOut: false };
  }
  const errorCode = readErrorCode(result.error);
  return {
    status: result.status,
    stdout: result.stdout?.toString("utf8") ?? "",
    errorCode: errorCode ?? null,
    timedOut: errorCode === "ETIMEDOUT" || result.signal === "SIGTERM",
  };
}

function readErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
