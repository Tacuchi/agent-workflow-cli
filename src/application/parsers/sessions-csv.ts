import type { FileSystemPort } from "../../ports/file-system.js";
import { listSessionFolders, parseSessionFolder } from "../session-resolver.js";

const SESSION_CODE_RE = /^\d{1,3}$/;

export class SessionsCsvError extends Error {
  readonly code: "INVALID_INPUT" | "UNKNOWN_SESSION";

  constructor(code: "INVALID_INPUT" | "UNKNOWN_SESSION", message: string) {
    super(message);
    this.code = code;
    this.name = "SessionsCsvError";
  }
}

export function parseSessionsCsv(input: string): string[] {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new SessionsCsvError("INVALID_INPUT", "--sessions vacío");
  }
  const tokens = trimmed
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new SessionsCsvError("INVALID_INPUT", "--sessions vacío");
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (!SESSION_CODE_RE.test(t)) {
      throw new SessionsCsvError(
        "INVALID_INPUT",
        `--sessions: token inválido '${t}' (esperado: 1-3 dígitos)`,
      );
    }
    const padded = t.padStart(3, "0");
    if (seen.has(padded)) {
      throw new SessionsCsvError("INVALID_INPUT", `--sessions: código duplicado '${padded}'`);
    }
    seen.add(padded);
    normalized.push(padded);
  }
  return normalized;
}

export async function validateSessionsExist(
  fs: FileSystemPort,
  sessionsDir: string,
  codes: readonly string[],
): Promise<void> {
  const folders = await listSessionFolders(fs, sessionsDir);
  const present = new Set<string>();
  for (const f of folders) {
    const { code } = parseSessionFolder(f.name);
    if (code !== null) present.add(code);
  }
  const missing = codes.filter((c) => !present.has(c));
  if (missing.length > 0) {
    throw new SessionsCsvError(
      "UNKNOWN_SESSION",
      `--sessions: códigos no encontrados: ${missing.join(", ")}`,
    );
  }
}
