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

/** Read + JSON.parse; any failure (read or parse) collapses to one error string. */
export async function readJson(
  fs: FileSystemPort,
  path: string,
): Promise<{ data: unknown } | { error: string }> {
  try {
    return { data: JSON.parse(await fs.readText(path)) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
