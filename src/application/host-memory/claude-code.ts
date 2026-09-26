import { join } from "node:path";
import type { HostMemorySkip } from "../../domain/host-memory/model.js";
import { parseSkillFrontmatter } from "../../domain/skill-frontmatter.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { type RawMemoryItem, type ReaderOutcome, isoDay, sortedEntries } from "./reader.js";

/** The index Claude Code loads each session; it points at the notes and is not one. */
const INDEX_FILE = "MEMORY.md";

/**
 * Claude Code keeps one note per fact in `~/.claude/projects/<key>/memory/`, with
 * a frontmatter `description` (the brief form) and, on newer notes, a
 * `metadata.modified` date. Every project folder is read: a learning about
 * Workline can live in any of them.
 */
export async function readClaudeCodeMemory(
  fs: FileSystemPort,
  home: string,
): Promise<ReaderOutcome> {
  const projects = join(home, ".claude", "projects");
  if (!(await fs.exists(projects))) return { state: "absent", reason: `no existe ${projects}` };

  const items: RawMemoryItem[] = [];
  const skipped: HostMemorySkip[] = [];
  let memoryDirs = 0;
  for (const project of await sortedEntries(fs, projects)) {
    const memory = join(project.path, "memory");
    if (project.type !== "dir" || !(await fs.exists(memory))) continue;
    memoryDirs++;
    await readMemoryDir(fs, memory, project.name, items, skipped);
  }
  if (memoryDirs === 0) {
    return { state: "absent", reason: `ninguna carpeta memory/ bajo ${projects}` };
  }
  return { state: "read", items, skipped };
}

async function readMemoryDir(
  fs: FileSystemPort,
  memory: string,
  project: string,
  items: RawMemoryItem[],
  skipped: HostMemorySkip[],
): Promise<void> {
  for (const file of await sortedEntries(fs, memory)) {
    if (file.type !== "file" || !file.name.endsWith(".md") || file.name === INDEX_FILE) continue;
    const note = await readNote(fs, file.path, `${project}/${file.name}`);
    if ("reason" in note) skipped.push(note);
    else items.push(note);
  }
}

async function readNote(
  fs: FileSystemPort,
  path: string,
  key: string,
): Promise<RawMemoryItem | HostMemorySkip> {
  let content: string;
  try {
    content = await fs.readText(path);
  } catch (err) {
    return { path, reason: `no se pudo leer: ${(err as Error).message}` };
  }
  const frontmatter = parseSkillFrontmatter(content);
  if (frontmatter === null) return { path, reason: "sin frontmatter" };
  const description = frontmatter.fields.description?.trim();
  if (!description) return { path, reason: "el frontmatter no trae description" };
  return {
    key,
    date: isoDay(frontmatter.metadata.modified),
    text: description,
    topic: content,
    body: content,
    source: { path, section: null },
  };
}
