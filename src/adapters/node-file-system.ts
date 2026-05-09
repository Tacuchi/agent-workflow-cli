import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DirEntry, DirEntryType, FileStat, FileSystemPort } from "../ports/file-system.js";

interface NodeError extends Error {
  code?: string;
}

export class NodeFileSystem implements FileSystemPort {
  private static writeCounter = 0;

  async readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  /**
   * Atomic write: stage to `<path>.<pid>.<n>.tmp` and rename onto `path`.
   * `rename` is atomic on POSIX/NTFS within the same filesystem, so a concurrent
   * reader either sees the previous full content or the new full content — never
   * a half-written file. On failure, the tmp is best-effort unlinked.
   */
  async writeText(path: string, content: string): Promise<void> {
    const tmpPath = `${path}.${process.pid}.${++NodeFileSystem.writeCounter}.tmp`;
    try {
      await writeFile(tmpPath, content, "utf8");
      await rename(tmpPath, path);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {
        // tmp may not exist if writeFile failed before creating it
      }
      throw err;
    }
  }

  /**
   * Atomic create-or-fail via O_CREAT|O_EXCL. Returns { created: false } if
   * the file already exists; other I/O errors propagate.
   */
  async writeTextExclusive(path: string, content: string): Promise<{ created: boolean }> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(path, "wx");
    } catch (err) {
      if ((err as NodeError).code === "EEXIST") {
        return { created: false };
      }
      throw err;
    }
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    return { created: true };
  }

  async remove(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeError).code === "ENOENT") return;
      throw err;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async list(path: string): Promise<DirEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => {
      const type: DirEntryType = entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other";
      return { name: entry.name, path: join(path, entry.name), type };
    });
  }

  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async stat(path: string): Promise<FileStat> {
    const s = await stat(path);
    const type: DirEntryType = s.isFile() ? "file" : s.isDirectory() ? "dir" : "other";
    return { mtime: s.mtime, size: s.size, type };
  }
}
