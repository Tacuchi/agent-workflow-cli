import {
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// Atomic replace: stage to a tmp sibling and rename over the target. At global
// scope the targets are live user files (~/.claude.json is rewritten by any
// running Claude Code session); rename keeps a concurrent reader from seeing a
// truncated/half-written file. `withHostConfigLock` serializes agent-workflow
// writers; an external host can still race, so every caller must read back.
const MAX_ATOMIC_TEMP_ATTEMPTS = 64;

export function atomicWriteFileSync(path: string, content: string): void {
  let descriptor: number | undefined;
  let tmp: string | undefined;
  try {
    const staged = reserveAtomicTempFile(path);
    descriptor = staged.descriptor;
    tmp = staged.path;
    // The temporary file is exclusively created with 0600. Tighten it again
    // where POSIX permissions exist; Windows ACL filesystems can reject
    // fchmod, and that must not turn an otherwise safe atomic replacement
    // into a platform-specific setup failure.
    try {
      fchmodSync(descriptor, 0o600);
    } catch {
      // The exclusive create mode above remains the only portable guarantee.
    }
    writeFileSync(descriptor, content, "utf-8");
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tmp, path);
    tmp = undefined;
  } catch (err) {
    if (descriptor !== undefined) closeAtomicTempFile(descriptor);
    if (tmp !== undefined) discardAtomicTempFile(tmp);
    throw err;
  }
}

function reserveAtomicTempFile(path: string): { path: string; descriptor: number } {
  for (let attempt = 0; attempt < MAX_ATOMIC_TEMP_ATTEMPTS; attempt += 1) {
    const tmp = `${path}.${process.pid}.${attempt + 1}.tmp`;
    try {
      return { path: tmp, descriptor: openSync(tmp, "wx", 0o600) };
    } catch (error) {
      if (filesystemErrorCode(error) === "EEXIST") continue;
      throw error;
    }
  }
  throw new McpWriterError(
    "no se pudo reservar un archivo temporal seguro para la configuración del host",
    path,
  );
}

function closeAtomicTempFile(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // The failed write is reported below; cleanup is best-effort.
  }
}

function discardAtomicTempFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Only an exclusively-created temp reaches this branch. It may already
    // have been removed by the filesystem after a failed write.
  }
}

function filesystemErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export class McpWriterError extends Error {
  constructor(
    message: string,
    public readonly target: string,
  ) {
    super(message);
    this.name = "McpWriterError";
  }
}

/**
 * Serializes the whole read-modify-write window, not merely the final rename.
 * A competing writer fails explicitly instead of silently dropping one host
 * entry. A stale lock is intentionally not guessed away: removing it requires
 * an operator decision because it may belong to another live process.
 */
export function withHostConfigLock<T>(target: string, work: () => T): T {
  const lock = `${target}.agent-workflow.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  let descriptor: number;
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      descriptor = openSync(lock, "wx", 0o600);
      break;
    } catch (error) {
      if (filesystemErrorCode(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new McpWriterError(
          "otro proceso está actualizando esta configuración; reintentá cuando termine",
          target,
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try {
    return work();
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        // A remaining lock is safer than claiming a concurrent write succeeded.
      }
    }
  }
}
