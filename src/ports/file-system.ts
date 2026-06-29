export type DirEntryType = "file" | "dir" | "other";

export interface DirEntry {
  name: string;
  path: string;
  type: DirEntryType;
}

export interface FileStat {
  mtime: Date;
  size: number;
  type: DirEntryType;
}

export interface FileSystemPort {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  /**
   * Atomically create file with content. Returns `{ created: true }` on success
   * or `{ created: false }` if path already exists. Used by lock-service to
   * implement true atomic claim (O_CREAT|O_EXCL semantics). Errors other than
   * "already exists" propagate as exceptions.
   */
  writeTextExclusive(path: string, content: string): Promise<{ created: boolean }>;
  /** Idempotent removal of a file or directory (recursive). A missing path is silently ignored. */
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<DirEntry[]>;
  mkdirp(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
}
