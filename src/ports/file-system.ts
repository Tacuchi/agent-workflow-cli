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

/** Result of `lstat`: the entry itself, symlinks NOT followed. */
export interface LinkStat {
  type: DirEntryType;
  isSymlink: boolean;
}

export interface FileSystemPort {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  /** Append `content` to `path`, creating the file and its parent dirs if absent. */
  appendText(path: string, content: string): Promise<void>;
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
  /**
   * Create a symbolic link at `path` pointing to `target` (directories; on
   * Windows a junction, which needs no admin rights). Fails if `path` exists or
   * the platform forbids links (EPERM) — callers catch to fall back to copying.
   */
  symlink(target: string, path: string): Promise<void>;
  /** Stat without following symlinks; `null` when the path does not exist. */
  lstat(path: string): Promise<LinkStat | null>;
}
