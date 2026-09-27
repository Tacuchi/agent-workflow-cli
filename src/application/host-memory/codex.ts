import { join } from "node:path";
import type { HostMemorySkip } from "../../domain/host-memory/model.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { parseToml } from "../parsers/toml.js";
import { type RawMemoryItem, type ReaderOutcome, sortedEntries } from "./reader.js";

const GROUP_HEADING = /^# Task Group:\s*(.+)$/;
const GROUP_HEADER_LINE = /^(scope|applies_to):/;
/** The two sections of a group that hold what was learned; the rest is its record. */
const LEARNING_SECTIONS: ReadonlySet<string> = new Set([
  "Reusable knowledge",
  "Failures and how to do differently",
]);
const ROLLOUT_DATE = /rollout_summaries\/(\d{4}-\d{2}-\d{2})T/;
/**
 * Consolidation labels what it derived from an ad-hoc note. Those notes are read
 * directly, so the derived bullet would be the same learning twice.
 */
const AD_HOC_TAG = "[ad-hoc note]";
const AD_HOC_NOTE_NAME = /^(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}-.+\.md$/;

interface CodexGroup {
  title: string;
  /** Title, scope, applies_to and keywords: what the topic filter judges for every bullet. */
  header: string[];
  /** The newest rollout the group was consolidated from. */
  date: string | null;
  bullets: { section: string; text: string }[];
}

/**
 * Codex keeps a global memory in `~/.codex/memories/`: a consolidated
 * `MEMORY.md` of `# Task Group` blocks, plus append-only ad-hoc notes. It is only
 * live with `[features] memories = true`.
 */
/** The ad-hoc note name Codex's own consolidation reads. */
export const CODEX_AD_HOC_NAME_FORMAT = "YYYY-MM-DDTHH-MM-SS-<slug>.md";

export function codexMemoryPaths(home: string) {
  const root = join(home, ".codex");
  const memories = join(root, "memories");
  return {
    root,
    config: join(root, "config.toml"),
    memories,
    index: join(memories, "MEMORY.md"),
    notesDir: join(memories, "extensions", "ad_hoc", "notes"),
  };
}

export async function readCodexMemory(fs: FileSystemPort, home: string): Promise<ReaderOutcome> {
  const { root, config, index, notesDir } = codexMemoryPaths(home);
  if (!(await fs.exists(root))) return { state: "absent", reason: `no existe ${root}` };
  const memoriesSwitch = await readCodexMemoriesSwitch(fs, config);
  if (memoriesSwitch !== null) return memoriesSwitch;

  const [hasIndex, hasNotes] = await Promise.all([fs.exists(index), fs.exists(notesDir)]);
  if (!hasIndex && !hasNotes) {
    return { state: "absent", reason: `ni ${index} ni ${notesDir} existen` };
  }

  // Index and notes are independent sources: one that cannot be read never hides the other.
  const fromIndex = hasIndex ? await readIndexItems(fs, index) : [];
  const fromNotes = hasNotes ? await readAdHocNotes(fs, notesDir) : { items: [], skipped: [] };
  const indexItems = Array.isArray(fromIndex) ? fromIndex : [];
  const skipped = Array.isArray(fromIndex) ? fromNotes.skipped : [fromIndex, ...fromNotes.skipped];
  const items = [...indexItems, ...fromNotes.items];
  if (items.length === 0 && skipped.length > 0) {
    return { state: "unreadable", reason: skipped.map((s) => `${s.path}: ${s.reason}`).join("; ") };
  }
  return { state: "read", items, skipped };
}

/** The index's learnings, or why the index could not be read as one. */
async function readIndexItems(
  fs: FileSystemPort,
  index: string,
): Promise<RawMemoryItem[] | HostMemorySkip> {
  let text: string;
  try {
    text = await fs.readText(index);
  } catch (err) {
    return { path: index, reason: `no se pudo leer: ${(err as Error).message}` };
  }
  const groups = parseIndex(text);
  if (groups.length === 0) return { path: index, reason: "no trae ningún bloque '# Task Group'" };
  return groupItems(groups, index);
}

async function readAdHocNotes(
  fs: FileSystemPort,
  notesDir: string,
): Promise<{ items: RawMemoryItem[]; skipped: HostMemorySkip[] }> {
  const items: RawMemoryItem[] = [];
  const skipped: HostMemorySkip[] = [];
  for (const file of await sortedEntries(fs, notesDir)) {
    if (file.type !== "file" || !file.name.endsWith(".md")) continue;
    const note = await readAdHocNote(fs, file.path, file.name);
    if ("reason" in note) skipped.push(note);
    else items.push(note);
  }
  return { items, skipped };
}

/** Null when memory is on; otherwise the state and reason that say why it is off. */
export async function readCodexMemoriesSwitch(
  fs: FileSystemPort,
  configPath: string,
): Promise<{ state: "disabled" | "unreadable"; reason: string } | null> {
  if (!(await fs.exists(configPath))) {
    return { state: "disabled", reason: `sin ${configPath}: [features] memories no está activado` };
  }
  let config: Record<string, unknown>;
  try {
    config = parseToml(await fs.readText(configPath));
  } catch (err) {
    return {
      state: "unreadable",
      reason: `${configPath} no es TOML válido: ${(err as Error).message}`,
    };
  }
  const features = config.features as Record<string, unknown> | undefined;
  if (features?.memories === true) return null;
  return { state: "disabled", reason: `[features] memories no es true en ${configPath}` };
}

function parseIndex(text: string): CodexGroup[] {
  const parser = new IndexParser();
  for (const line of text.split(/\r?\n/)) parser.read(line);
  return parser.groups;
}

/** One pass over `MEMORY.md`, tracking which group, section and bullet a line belongs to. */
class IndexParser {
  readonly groups: CodexGroup[] = [];
  private group: CodexGroup | null = null;
  private section: string | null = null;
  private subsection: string | null = null;
  private bullet: { section: string; text: string } | null = null;

  read(line: string): void {
    const heading = GROUP_HEADING.exec(line)?.[1];
    if (heading !== undefined) {
      this.startGroup(heading);
      return;
    }
    const group = this.group;
    if (group === null) return;
    if (line.startsWith("## ")) {
      this.enterSection(line.slice(3).trim(), null);
    } else if (line.startsWith("### ")) {
      this.enterSection(this.section, line.slice(4).trim());
    } else {
      this.readRecord(group, line);
      this.readLearning(group, line);
    }
  }

  private startGroup(title: string): void {
    this.group = { title: title.trim(), header: [title], date: null, bullets: [] };
    this.groups.push(this.group);
    this.enterSection(null, null);
  }

  private enterSection(section: string | null, subsection: string | null): void {
    this.section = section;
    this.subsection = subsection;
    this.bullet = null;
  }

  /** The lines that say what the group is about and when it was last consolidated. */
  private readRecord(group: CodexGroup, line: string): void {
    if (GROUP_HEADER_LINE.test(line)) group.header.push(line);
    if (this.subsection === "keywords" && line.startsWith("- ")) group.header.push(line);
    const rollout = ROLLOUT_DATE.exec(line)?.[1];
    if (rollout !== undefined && (group.date === null || rollout > group.date)) {
      group.date = rollout;
    }
  }

  /** A learning bullet, including the indented lines that continue it. */
  private readLearning(group: CodexGroup, line: string): void {
    const section = this.section;
    if (section === null || this.subsection !== null || !LEARNING_SECTIONS.has(section)) return;
    if (line.startsWith("- ")) {
      this.bullet = { section, text: line.slice(2).trim() };
      group.bullets.push(this.bullet);
    } else if (this.bullet !== null && /^\s+\S/.test(line)) {
      this.bullet.text += ` ${line.trim()}`;
    } else {
      this.bullet = null;
    }
  }
}

function groupItems(groups: readonly CodexGroup[], index: string): RawMemoryItem[] {
  return groups.flatMap((group) =>
    group.bullets
      .filter((bullet) => !bullet.text.includes(AD_HOC_TAG))
      .map((bullet) => ({
        // MEMORY.md is rewritten by every consolidation, so no key inside it is
        // stable: a position shifts as much as a wording. The durable source is the
        // append-only ad-hoc note, which is why those are read directly.
        key: `MEMORY.md#${group.title}#${bullet.text}`,
        date: group.date,
        text: bullet.text,
        topic: group.header.join("\n"),
        body: bullet.text,
        source: { path: index, section: `${group.title} › ${bullet.section}` },
      })),
  );
}

async function readAdHocNote(
  fs: FileSystemPort,
  path: string,
  name: string,
): Promise<RawMemoryItem | HostMemorySkip> {
  const date = AD_HOC_NOTE_NAME.exec(name)?.[1];
  if (date === undefined) {
    return { path, reason: "el nombre no sigue YYYY-MM-DDTHH-MM-SS-<slug>.md" };
  }
  let content: string;
  try {
    content = await fs.readText(path);
  } catch (err) {
    return { path, reason: `no se pudo leer: ${(err as Error).message}` };
  }
  const text = firstLine(content);
  if (text === null) return { path, reason: "la nota está vacía" };
  return {
    key: `ad_hoc/${name}`,
    date,
    text,
    topic: content,
    body: content,
    source: { path, section: null },
  };
}

/** The first line with content, without its Markdown heading or bullet mark. */
function firstLine(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const text = line.replace(/^\s*(#+|[-*])\s*/, "").trim();
    if (text !== "") return text;
  }
  return null;
}
