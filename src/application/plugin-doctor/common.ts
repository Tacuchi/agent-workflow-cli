import { extname } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";

export interface DoctorFinding {
  level: "error" | "warn";
  file: string;
  msg: string;
}

export interface SkillFrontmatterInfo {
  dir: string;
  name: string | null;
  version: string | null;
}

export type HooksInfoValue = string[] | "invalid-structure" | null;
export type McpServerInfo = "missing" | { dsn_env: string | null; env_set: boolean | null };

export interface ExportedSkillRecord {
  namespace: string;
  version_declared: string | null;
  since: string | null;
  exists_in_disk: boolean;
  frontmatter_ok: boolean;
  version_in_skill?: string;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function collectMarkdownFiles(fs: FileSystemPort, dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries: Awaited<ReturnType<FileSystemPort["list"]>>;
    try {
      entries = await fs.list(current);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.type === "dir") stack.push(e.path);
      else if (e.type === "file" && extname(e.name).toLowerCase() === ".md") out.push(e.path);
    }
  }
  return out;
}
