import { join, posix as posixPath, relative } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";

const FRONTMATTER_DELIMITER = "---";
const FRONTMATTER_MAX_LINES = 60;

export interface SkillIndexItem {
  name: string;
  description: string | null;
  version: string | null;
  exported: boolean;
  registry_version?: string | null;
  since_export?: string | null;
  frontmatter_ok: boolean;
  path: string;
}

export interface SkillIndexInput {
  pluginRoot?: string;
  flow?: string;
  exportedOnly?: boolean;
}

export interface SkillIndexOutput {
  flow: string | null;
  plugin: string | null;
  plugin_root: string;
  skills_count: number;
  exported_only: boolean;
  skills: SkillIndexItem[];
}

export async function runSkillIndex(
  fs: FileSystemPort,
  env: EnvPort,
  input: SkillIndexInput,
): Promise<SkillIndexOutput> {
  const pluginRoot = input.pluginRoot ?? env.cwd();
  const pluginName = await readPluginName(fs, pluginRoot);
  const items = await buildIndex(fs, pluginRoot);
  const filtered = input.exportedOnly === true ? items.filter((s) => s.exported) : items;
  return {
    flow: input.flow ?? null,
    plugin: pluginName,
    plugin_root: pluginRoot,
    skills_count: filtered.length,
    exported_only: input.exportedOnly === true,
    skills: filtered,
  };
}

async function readPluginName(fs: FileSystemPort, pluginRoot: string): Promise<string | null> {
  for (const candidate of [
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    join(pluginRoot, ".codex-plugin", "plugin.json"),
  ]) {
    if (!(await fs.exists(candidate))) continue;
    try {
      const text = await fs.readText(candidate);
      const json = JSON.parse(text) as { name?: string };
      if (json.name) return json.name;
    } catch {
      // ignore
    }
  }
  return null;
}

async function buildIndex(fs: FileSystemPort, pluginRoot: string): Promise<SkillIndexItem[]> {
  const skillsDir = join(pluginRoot, "skills");
  if (!(await fs.exists(skillsDir))) return [];
  const entries = await fs.list(skillsDir);
  const dirs = entries.filter((e) => e.type === "dir").sort((a, b) => a.name.localeCompare(b.name));
  const items: SkillIndexItem[] = [];
  for (const dir of dirs) {
    const skillMd = join(dir.path, "SKILL.md");
    if (!(await fs.exists(skillMd))) continue;
    const text = await fs.readText(skillMd);
    const fm = parseFrontmatter(text);
    const relPath = toPosixRelative(skillMd, pluginRoot);
    if (!fm) {
      items.push({
        name: dir.name,
        description: null,
        version: null,
        exported: false,
        frontmatter_ok: false,
        path: relPath,
      });
      continue;
    }
    const name = fm.name ?? dir.name;
    items.push({
      name,
      description: fm.description ?? null,
      version: fm.version ?? null,
      exported: false,
      registry_version: null,
      since_export: null,
      frontmatter_ok: true,
      path: relPath,
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== FRONTMATTER_DELIMITER) return null;
  const fm: Record<string, string> = {};
  for (let i = 1; i <= FRONTMATTER_MAX_LINES && i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) return null;
    if (line.trim() === FRONTMATTER_DELIMITER) return fm;
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m?.[1] && m[2] !== undefined) {
      fm[m[1]] = m[2].trim();
    }
  }
  return null;
}

function toPosixRelative(path: string, base: string): string {
  const rel = relative(base, path);
  return rel.split(/[\\/]/).join(posixPath.sep);
}
