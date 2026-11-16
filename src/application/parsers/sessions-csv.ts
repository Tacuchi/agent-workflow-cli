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
