import type { DirEntry, FileStat, FileSystemPort, LinkStat } from "../../src/ports/file-system.js";

/**
 * Shared in-memory FileSystemPort for unit tests. `.file()`/`.dir()` builders
 * auto-register the whole parent-dir chain. Strict by default (unregistered
 * paths throw ENOENT on readText/list/stat); `{ lenient: true }` makes list()
 * return [] and stat() a zero-mtime file-stat instead, for services that probe
 * unseeded paths. `writes` records every writeText for assertions.
 */
export class MemFs implements FileSystemPort {
  readonly writes = new Map<string, string>();
  private readonly files = new Map<string, { content: string; mtime: Date }>();
  private readonly dirMtime = new Map<string, Date>();
  private readonly children = new Map<string, Map<string, DirEntry>>();

  constructor(private readonly opts: { lenient?: boolean } = {}) {}

  file(path: string, content: string, mtime = new Date(0)): this {
    this.files.set(path, { content, mtime });
    this.register(path, "file");
    return this;
  }

  dir(path: string, mtime = new Date(0)): this {
    if (!this.dirMtime.has(path)) this.dirMtime.set(path, mtime);
    this.register(path, "dir");
    return this;
  }

  private register(path: string, type: DirEntry["type"]): void {
    const parent = parentOf(path);
    if (parent === path) return;
    const kids = this.children.get(parent) ?? new Map<string, DirEntry>();
    kids.set(baseOf(path), { name: baseOf(path), path, type });
    this.children.set(parent, kids);
    if (!this.dirMtime.has(parent)) this.dirMtime.set(parent, new Date(0));
    this.register(parent, "dir");
  }

  async readText(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v.content;
  }
  async writeText(p: string, content: string): Promise<void> {
    this.writes.set(p, content);
    this.file(p, content);
  }
  async appendText(p: string, content: string): Promise<void> {
    const prev = this.files.get(p)?.content ?? "";
    await this.writeText(p, prev + content);
  }
  async writeTextExclusive(p: string, content: string): Promise<{ created: boolean }> {
    if (this.files.has(p)) return { created: false };
    await this.writeText(p, content);
    return { created: true };
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
    this.dirMtime.delete(p);
    this.children.delete(p);
    this.children.get(parentOf(p))?.delete(baseOf(p));
  }
  async exists(p: string): Promise<boolean> {
    return this.files.has(p) || this.dirMtime.has(p) || this.children.has(p);
  }
  async list(p: string): Promise<DirEntry[]> {
    const kids = this.children.get(p);
    if (kids === undefined) {
      if (this.opts.lenient || this.dirMtime.has(p)) return [];
      throw new Error(`ENOENT: ${p}`);
    }
    return [...kids.values()];
  }
  async mkdirp(p: string): Promise<void> {
    this.dir(p);
  }
  async stat(p: string): Promise<FileStat> {
    const f = this.files.get(p);
    if (f) return { mtime: f.mtime, size: f.content.length, type: "file" };
    const d = this.dirMtime.get(p);
    if (d) return { mtime: d, size: 0, type: "dir" };
    if (this.children.has(p)) return { mtime: new Date(0), size: 0, type: "dir" };
    if (this.opts.lenient) return { mtime: new Date(0), size: 0, type: "file" };
    throw new Error(`ENOENT: ${p}`);
  }
  async symlink(_target: string, path: string): Promise<void> {
    this.dir(path);
  }
  async lstat(p: string): Promise<LinkStat | null> {
    if (this.files.has(p)) return { type: "file", isSymlink: false };
    if (this.dirMtime.has(p) || this.children.has(p)) return { type: "dir", isSymlink: false };
    return null;
  }
}

function parentOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

function baseOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? p : p.slice(idx + 1);
}
