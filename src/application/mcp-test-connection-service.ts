// Test real de conexión MCP: ejecuta `npx -y @bytebase/dbhub` con el DSN
// resuelto del shell env o del bootstrap file. Si dbhub arranca sin errores
// fatales (queda esperando inputs MCP en stdio), se considera la conexión
// válida. Si dbhub falla rápidamente con stderr, el test falla con el detalle.
import { spawn } from "node:child_process";
import { readBootstrapDsn } from "./dsn-reader-service.js";
import type { PathsService } from "./paths-service.js";

export interface McpTestConnectionInput {
  /** Nombre de la DSN env var (ej: DB_CERT_DSN). */
  dsnVar: string;
  env: Record<string, string | undefined>;
  paths: PathsService;
  platform: NodeJS.Platform;
  /** Timeout en ms para asumir que dbhub arrancó OK. Default: 5000. */
  timeoutMs?: number;
}

export interface McpTestConnectionResult {
  ok: boolean;
  /** De dónde se resolvió el DSN. `null` si no se pudo resolver. */
  source: "env" | "dsn.env" | null;
  /** Detalle del error cuando `ok=false`. */
  error?: string;
}

export async function testMcpConnection(
  input: McpTestConnectionInput,
): Promise<McpTestConnectionResult> {
  const resolved = resolveDsnString(input);
  if (!resolved) {
    return {
      ok: false,
      source: null,
      error: `${input.dsnVar} no está exportada en el shell ni en ${input.paths.userDsnFile()}`,
    };
  }
  return spawnDbhub(resolved.dsn, resolved.source, input);
}

function resolveDsnString(
  input: McpTestConnectionInput,
): { dsn: string; source: "env" | "dsn.env" } | null {
  const fromEnv = input.env[input.dsnVar];
  if (fromEnv && fromEnv.length > 0) {
    return { dsn: fromEnv, source: "env" };
  }
  const bootstrap = readBootstrapDsn(input.paths);
  const fromFile = bootstrap.values[input.dsnVar];
  if (fromFile && fromFile.length > 0) {
    return { dsn: fromFile, source: "dsn.env" };
  }
  return null;
}

function spawnDbhub(
  dsn: string,
  source: "env" | "dsn.env",
  input: McpTestConnectionInput,
): Promise<McpTestConnectionResult> {
  const timeoutMs = input.timeoutMs ?? 5000;
  const isWin = input.platform === "win32";
  const cmd = isWin ? "npx.cmd" : "npx";
  return new Promise((resolve) => {
    const child = spawn(cmd, ["-y", "@bytebase/dbhub"], {
      env: { ...input.env, DSN: dsn },
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWin,
    });
    let stderr = "";
    let settled = false;
    const settle = (result: McpTestConnectionResult): void => {
      if (settled) return;
      settled = true;
      if (!child.killed) child.kill("SIGTERM");
      resolve(result);
    };
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => settle({ ok: false, source, error: err.message }));
    child.on("exit", (code) => {
      if (code === 0 || code === null) {
        settle({ ok: true, source });
      } else {
        settle({
          ok: false,
          source,
          error: stderr.trim() || `dbhub salió con código ${code}`,
        });
      }
    });
    // Si dbhub sigue corriendo tras el timeout, asumimos que arrancó OK
    // (conectó y está esperando inputs MCP en stdio). Lo matamos y reportamos OK.
    setTimeout(() => settle({ ok: true, source }), timeoutMs);
  });
}
