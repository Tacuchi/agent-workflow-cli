import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DirEntry, DirEntryType, FileStat, FileSystemPort } from "../ports/file-system.js";

export class NodeFileSystem implements FileSystemPort {
  async readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async writeText(path: string, content: string): Promise<void> {
    await writeFile(path, content, "utf8");
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
