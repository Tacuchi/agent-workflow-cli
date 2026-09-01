import { PostgresReadonlyTools } from "../adapters/postgres-readonly-tools.js";
import { PostgresToolError } from "../ports/postgres-tools.js";
import { type DsnResolution, resolveExactDsn } from "./dsn-reader-service.js";
import type { PathsService } from "./paths-service.js";

export interface McpTestConnectionInput {
  /** Exact registered DSN env var name (e.g. ALPHA_DATABASE_URL). */
  dsnVar: string;
  env: Record<string, string | undefined>;
  paths: PathsService;
  /** Retained for source compatibility; PostgreSQL owns its explicit timeouts. */
  platform: NodeJS.Platform;
  /** Retained for source compatibility; PostgreSQL uses the 10s/30s contract. */
  timeoutMs?: number;
}

export interface McpTestConnectionResult {
  ok: boolean;
  /** Where the DSN was resolved from. `null` when it could not be resolved. */
  source: "env" | "dsn.env" | null;
  /** Safe diagnostic when `ok=false`; never a DSN or driver message. */
  error?: string;
}

/**
 * A real read-only `SELECT 1`, replacing the old five-second DBHub liveness
 * heuristic. MCP lifecycle probing lives in `mcp doctor --probe`; this check is
 * intentionally a direct database health signal for the TUI connection wizard.
 */
export async function testMcpConnection(
  input: McpTestConnectionInput,
): Promise<McpTestConnectionResult> {
  void input.platform;
  void input.timeoutMs;
  const resolved = resolveDsnString(input);
  if (!resolved) {
    return {
      ok: false,
      source: null,
      error: `${input.dsnVar} no está exportada en el shell ni en ${input.paths.userDsnFile()}`,
    };
  }
  try {
    await new PostgresReadonlyTools().execute("SELECT 1 AS ok", resolved.dsn);
    return { ok: true, source: resolved.source };
  } catch (error) {
    if (error instanceof PostgresToolError) {
      return { ok: false, source: resolved.source, error: error.message };
    }
    return {
      ok: false,
      source: resolved.source,
      error: "No se pudo verificar la conexión PostgreSQL.",
    };
  }
}

function resolveDsnString(input: McpTestConnectionInput): DsnResolution | null {
  return resolveExactDsn(input.dsnVar, input.env, input.paths);
}
