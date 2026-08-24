import {
  appendFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DirEntry,
  DirEntryType,
  FileStat,
  FileSystemPort,
  LinkStat,
} from "../ports/file-system.js";

interface NodeError extends Error {
  code?: string;
}

export class NodeFileSystem implements FileSystemPort {
  private static writeCounter = 0;

  async readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path));
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
   * Atomic AND exclusive: stage the full content to a tmp, then `link` it onto
   * `path`.
   *
   * `link` is the primitive that gives both properties at once — it is atomic
   * and it fails with EEXIST instead of clobbering, which `rename` would do. So
   * the destination never exists in a partial state and never overwrites a
   * document somebody else published.
   *
   * Two details are load-bearing, and both were defects here first:
   *
   * 1. **The staging name must not read as a correlative.** It used to be
   *    `<path>.<pid>.<n>.publish.tmp`, which begins with the target's own
   *    `NNN-`, so `leadingCorrelative` read a number out of the leftover and the
   *    correlative was consumed FOREVER by a file no reader recognizes, no
   *    `heldReservation` matches and no session close reclaims. The staging name
   *    now begins with a dot and carries no correlative at all. It stays in the
   *    target's own directory because `link` needs both ends on one filesystem.
   * 2. **The staging write belongs inside the try.** A staging write that fails
   *    after creating the file (ENOSPC, EDQUOT, EIO) would otherwise strand its
   *    partial tmp, which is the very "failure before the commit leaves an
   *    effect behind" this method exists to prevent.
   *
   * A filesystem without hard links (exFAT/FAT32, some FUSE and network mounts)
   * answers EPERM/ENOTSUP/EXDEV rather than EEXIST. There the exclusive-create
   * path is used instead: it keeps the command WORKING, at the cost of the
   * atomicity this filesystem cannot offer — a declared degradation, never a
   * silent one, and never a wrong answer.
   */
  async publishTextExclusive(path: string, content: string): Promise<{ created: boolean }> {
    const tmpPath = join(
      dirname(path),
      `.aw-publish-${process.pid}-${++NodeFileSystem.writeCounter}.tmp`,
    );
    try {
      await writeFile(tmpPath, content, "utf8");
      await link(tmpPath, path);
      return { created: true };
    } catch (err) {
      const code = (err as NodeError).code;
      if (code === "EEXIST") return { created: false };
      if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV") {
        return await this.writeTextExclusive(path, content);
      }
      throw err;
    } finally {
      try {
        await unlink(tmpPath);
      } catch {
        // Best effort: the content is already at its real name, or never landed.
      }
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

  /** Append content, creating parent dirs on first write (log-friendly). */
  async appendText(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, content, "utf8");
  }

  async remove(path: string): Promise<void> {
    // recursive+force: removes a file or a directory (with its contents); force
    // ignores ENOENT → idempotent.
    await rm(path, { recursive: true, force: true });
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

  async symlink(target: string, path: string): Promise<void> {
    // "junction" on Windows: links dirs without admin privileges (real symlinks
    // require Developer Mode). On POSIX the type argument is ignored.
    await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
  }

  async lstat(path: string): Promise<LinkStat | null> {
    try {
      const s = await lstat(path);
      const type: DirEntryType = s.isFile() ? "file" : s.isDirectory() ? "dir" : "other";
      return { type, isSymlink: s.isSymbolicLink() };
    } catch (err) {
      if ((err as NodeError).code === "ENOENT") return null;
      throw err;
    }
  }

  async realPath(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch (err) {
      // A path that is not there yet has no canonical form; the caller compares
      // it against something that does not exist either, so the raw spelling is
      // the honest answer instead of an invented one.
      if ((err as NodeError).code === "ENOENT") return path;
      throw err;
    }
  }
}
