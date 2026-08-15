import { isCorrelative, sameCorrelative } from "../../domain/correlative.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { listSessionFolders, sessionNumericCode } from "../session-resolver.js";

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
  for (const t of tokens) {
    if (!isCorrelative(t)) {
      throw new SessionsCsvError(
        "INVALID_INPUT",
        `--sessions: token inválido '${t}' (esperado: correlativo de al menos 3 dígitos)`,
      );
    }
    if (normalized.some((existing) => sameCorrelative(existing, t))) {
      throw new SessionsCsvError("INVALID_INPUT", `--sessions: código duplicado '${t}'`);
    }
    normalized.push(t);
  }
  return normalized;
}

export async function validateSessionsExist(
  fs: FileSystemPort,
  sessionsDir: string,
  codes: readonly string[],
): Promise<void> {
  for (const code of codes) {
    if (isCorrelative(code)) continue;
    throw new SessionsCsvError(
      "INVALID_INPUT",
      `--sessions: token inválido '${code}' (esperado: correlativo de al menos 3 dígitos)`,
    );
  }
  const folders = await listSessionFolders(fs, sessionsDir);
  const present: string[] = [];
  for (const f of folders) {
    const code = sessionNumericCode(f.name);
    if (code !== null) present.push(code);
  }
  const missing = codes.filter((code) => !present.some((found) => sameCorrelative(found, code)));
  if (missing.length > 0) {
    throw new SessionsCsvError(
      "UNKNOWN_SESSION",
      `--sessions: códigos no encontrados: ${missing.join(", ")}`,
    );
  }
}
