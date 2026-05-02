export type DirEntryType = "file" | "dir" | "other";

export interface DirEntry {
  name: string;
  path: string;
  type: DirEntryType;
}

export interface FileSystemPort {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<DirEntry[]>;
  mkdirp(path: string): Promise<void>;
}
