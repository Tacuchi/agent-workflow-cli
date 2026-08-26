import { isAbsolute, join, resolve } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import { parseMdSection } from "../markdown.js";

/**
 * Read the workspace project block from `<dir>/CLAUDE.md` or `<dir>/AGENTS.md`
 * (first file whose parsed block satisfies `accept` wins) — the single home of
 * the read loop previously pasted per service.
 */
export async function readWorkspaceBlock(
  fs: FileSystemPort,
  dir: string,
  markers: ProjectBlockMarkers,
  accept: (block: ParsedProjectBlock) => boolean = () => true,
): Promise<ParsedProjectBlock | null> {
  for (const name of BLOCK_MIRROR_FILES) {
    const path = join(dir, name);
    if (!(await fs.exists(path))) continue;
    const parsed = parseProjectBlock(await fs.readText(path), markers);
    const block = parsed === null ? null : resolveWorkspaceBlockSources(parsed, dir);
    if (block !== null && accept(block)) return block;
  }
  return null;
}

/** The block is written to both files at once; a reader takes the first that has it. */
export const BLOCK_MIRROR_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

export interface ProjectFuente {
  alias: string;
  path: string;
  /** Declared base branch. `null` when the Fuentes cell is empty → the workspace default applies. */
  main_branch: string | null;
}

/**
 * Resolve one source coordinate read from a WORKSPACE block.
 *
 * New configuration persists absolute paths, but legacy blocks may still hold
 * a relative one. A block is scoped to the resolved Workline root that holds
 * it, never to whichever process cwd happens to read it later. Keep absolute
 * values byte-for-byte so a configured source is not rewritten merely by being
 * consumed.
 */
export function resolveWorkspaceSourcePath(workspace: string, sourcePath: string): string {
  if (sourcePath.length === 0 || isAbsolute(sourcePath)) return sourcePath;
  return resolve(workspace, sourcePath);
}

/** Apply the WORKSPACE source-coordinate rule to a parsed block. */
export function resolveWorkspaceBlockSources(
  block: ParsedProjectBlock,
  workspace: string,
): ParsedProjectBlock {
  const fuentes = block.fuentes.map((source) => ({
    ...source,
    path: resolveWorkspaceSourcePath(workspace, source.path),
  }));
  return { ...block, fuentes };
}

/**
 * Workspace-level branch defaults (`## Status > Ramas por defecto`). Each role
 * falls back to these when a source declares no value of its own; see
 * `branch-resolver.ts` for the resolution chain.
 */
export interface DefaultBranches {
  principal?: string;
  desarrollo?: string;
  qa?: string;
}

export interface ProjectStack {
  language?: string;
  framework?: string;
  db?: string;
  build?: string;
}

/**
 * Where a preserved line goes back when the block is re-rendered. The Status
 * slots name the recognized entry the line followed, so a rewrite puts a hand
 * written note back exactly where its author left it.
 */
export type PreservedSlot =
  | "fuentes"
  | "stack"
  | "status:start"
  | "status:defaults"
  | "status:working"
  | "status:qa"
  | "status:activity"
  | "status:historico"
  /**
   * A whole `##` section the block does not own, heading included, re-emitted at
   * the end. The four known sections are read by name, so anything under another
   * heading was invisible to the parser and simply never came back — and a `##`
   * is how a person naturally adds their own content to a Markdown block.
   */
  | "trailing";

/**
 * A line inside the block that the block does not own. It is carried through the
 * rewrite verbatim: the block stays CLI property (it is not free-form Markdown),
 * but rewriting it must never destroy what a person wrote inside it.
 */
export interface PreservedLine {
  slot: PreservedSlot;
  /** The line as written — leading indentation kept, trailing blanks trimmed. */
  text: string;
}

export interface ParsedProjectBlock {
  proyecto: string;
  fuentes: ProjectFuente[];
  stack: ProjectStack;
  default_branches: DefaultBranches;
  working_branches: Record<string, string>;
  qa_branches: Record<string, string>;
  last_activity: string | null;
  /** Foreign lines kept verbatim. Absent (not empty) when the block is clean. */
  preserved_lines?: PreservedLine[];
  /**
   * CLI-OWNED records the block can no longer honour: a branch entry whose
   * source is not declared any more, a default role that does not exist. They do
   * not survive the rewrite, so callers declare them instead of dropping them in
   * silence. Absent (not empty) when there are none.
   */
  dropped_lines?: string[];
}

export interface ProjectBlockMarkers {
  start: string;
  end: string;
}

export const DEFAULT_PROJECT_BLOCK_MARKERS: ProjectBlockMarkers = {
  start: "<!-- WORKFLOW-PROJECT-START -->",
  end: "<!-- WORKFLOW-PROJECT-END -->",
};

/**
 * Lines the render emits by itself when a section has no data. They belong to
 * the CLI, never to a person: preserving one would duplicate it on the next
 * write (the render re-emits it AND the carried copy would come back too).
 */
export const BLOCK_PLACEHOLDER_PROYECTO = "_Describe el proyecto aquí: qué es y por qué existe._";
export const BLOCK_PLACEHOLDER_FUENTES =
  "_Sin fuentes declaradas. Edita manualmente o usa `project-md-upsert --init`._";
export const BLOCK_PLACEHOLDER_STACK = "_Stack sin detectar._";
/** Emitted by the pre-TypeScript generator for an undetectable stack. */
const LEGACY_STACK_PLACEHOLDER = "Edita manualmente si aplica.";

const STACK_KEY_MAP: Record<string, keyof ProjectStack> = {
  lenguaje: "language",
  framework: "framework",
  bd: "db",
  build: "build",
};

export function parseProjectBlock(
  text: string,
  markers: ProjectBlockMarkers = DEFAULT_PROJECT_BLOCK_MARKERS,
): ParsedProjectBlock | null {
  return parseWithMarkers(text, markers);
}

function parseWithMarkers(text: string, markers: ProjectBlockMarkers): ParsedProjectBlock | null {
  if (!text.includes(markers.start) || !text.includes(markers.end)) {
    return null;
  }
  const start = text.indexOf(markers.start) + markers.start.length;
  const end = text.indexOf(markers.end, start);
  if (end < 0) return null;
  const inner = text.slice(start, end);

  const proyectoText = parseMdSection(inner, "Proyecto") ?? "";
  const fuentesText = parseMdSection(inner, "Fuentes") ?? "";
  const stackText = parseMdSection(inner, "Stack") ?? "";
  const statusText = parseMdSection(inner, "Status") ?? "";

  const fuentes = parseFuentesTable(fuentesText);
  const stack = parseStackList(stackText);
  // Aliases first: a Status entry is a branch because it names a DECLARED
  // source, not because of where it sits (see `readNestedRecord`).
  const status = parseStatusBlock(statusText, new Set(fuentes.fuentes.map((f) => f.alias)));

  const block: ParsedProjectBlock = {
    proyecto: stripLegacyModeLine(proyectoText),
    fuentes: fuentes.fuentes,
    stack: stack.stack,
    default_branches: status.defaultBranches,
    working_branches: status.workingBranches,
    qa_branches: status.qaBranches,
    last_activity: status.lastActivity,
  };
  const preserved = [
    ...fuentes.preserved,
    ...stack.preserved,
    ...status.preserved,
    ...foreignSections(inner),
  ];
  if (preserved.length > 0) block.preserved_lines = preserved;
  if (status.dropped.length > 0) block.dropped_lines = status.dropped;
  return block;
}

/** The four `##` sections this block owns; anything else under a heading is somebody else's. */
const OWNED_SECTIONS: ReadonlySet<string> = new Set(["proyecto", "fuentes", "stack", "status"]);

/**
 * Whole sections the block does not own, heading included.
 *
 * The four owned ones are read BY NAME, so a `## Notas` a person adds was never
 * seen by the parser and never came back — the silent loss this parser exists to
 * stop, arriving through the one shape Markdown makes most natural. They are
 * re-emitted last, after everything the CLI owns, because their original order
 * relative to generated sections is not something a rewrite can honour.
 */
function foreignSections(inner: string): PreservedLine[] {
  const kept: PreservedLine[] = [];
  let foreign = false;
  for (const raw of inner.split("\n")) {
    const heading = /^##\s+(.+)$/.exec(raw.trim());
    if (heading !== null) {
      foreign = !OWNED_SECTIONS.has((heading[1] ?? "").trim().toLowerCase());
    }
    if (!foreign) continue;
    if (raw.trim().length === 0 && kept.length === 0) continue;
    kept.push({ slot: "trailing", text: trimTrailing(raw) });
  }
  while (kept.length > 0 && (kept[kept.length - 1]?.text ?? "").length === 0) kept.pop();
  return kept;
}

/** Trailing blanks carry nothing and would churn the rewrite; indentation is content. */
function trimTrailing(raw: string): string {
  return raw.replace(/\s+$/, "");
}

interface FuentesParse {
  fuentes: ProjectFuente[];
  preserved: PreservedLine[];
}

function parseFuentesTable(text: string): FuentesParse {
  const fuentes: ProjectFuente[] = [];
  const preserved: PreservedLine[] = [];
  let header: string[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (!line.startsWith("|")) {
      if (line !== BLOCK_PLACEHOLDER_FUENTES) {
        preserved.push({ slot: "fuentes", text: trimTrailing(raw) });
      }
      continue;
    }
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^[-:\s]*$/.test(c))) {
      continue;
    }
    if (header === null) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    const alias = cells[0];
    const path = cells[1];
    const mainBranch = cells[2];
    if (cells.length < 3 || alias === undefined || path === undefined) {
      // A row the table shape cannot read: keep it rather than swallow it.
      preserved.push({ slot: "fuentes", text: trimTrailing(raw) });
      continue;
    }
    fuentes.push({
      alias,
      path,
      // Empty cell = undeclared: the workspace default applies at resolution time.
      main_branch: mainBranch !== undefined && mainBranch.length > 0 ? mainBranch : null,
    });
  }
  return { fuentes, preserved };
}

interface StackParse {
  stack: ProjectStack;
  preserved: PreservedLine[];
}

function parseStackList(text: string): StackParse {
  const stack: ProjectStack = {};
  const preserved: PreservedLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line === BLOCK_PLACEHOLDER_STACK || line === LEGACY_STACK_PLACEHOLDER) continue;
    const m = line.match(/^[-*]\s+(Lenguaje|Framework|BD|Build):\s*(.+)$/i);
    const key = m?.[1] ? STACK_KEY_MAP[m[1].toLowerCase()] : undefined;
    if (key && m?.[2]) {
      stack[key] = m[2].trim();
      continue;
    }
    preserved.push({ slot: "stack", text: trimTrailing(raw) });
  }
  return { stack, preserved };
}

interface StatusBlock {
  defaultBranches: DefaultBranches;
  workingBranches: Record<string, string>;
  qaBranches: Record<string, string>;
  lastActivity: string | null;
  preserved: PreservedLine[];
  dropped: string[];
}

type StatusSection = "none" | "defaults" | "working" | "qa";
type StatusSlot = Extract<PreservedSlot, `status:${string}`>;

const DEFAULT_BRANCH_KEYS: ReadonlySet<string> = new Set(["principal", "desarrollo", "qa"]);

/**
 * Read `## Status`. Every line falls in exactly one of three buckets and none of
 * them vanishes: a recognized entry (parsed), a CLI record the block can no
 * longer honour (dropped, and declared by the caller), or anything else — kept
 * verbatim at the slot it was found in.
 */
function parseStatusBlock(text: string, knownAliases: ReadonlySet<string>): StatusBlock {
  const defaultBranches: DefaultBranches = {};
  const workingBranches: Record<string, string> = {};
  const qaBranches: Record<string, string> = {};
  const preserved: PreservedLine[] = [];
  const dropped: string[] = [];
  let lastActivity: string | null = null;
  let section: StatusSection = "none";
  let slot: StatusSlot = "status:start";

  for (const raw of text.split("\n")) {
    const stripped = raw.trim();
    if (stripped.length === 0) continue;
    const transition = transitionSection(stripped);
    if (transition.handled) {
      section = transition.next;
      slot = transition.slot;
      if (transition.lastActivity !== undefined) {
        lastActivity = transition.lastActivity;
      }
      continue;
    }
    const record = readNestedRecord(raw, stripped);
    if (record === null || section === "none") {
      preserved.push({ slot, text: trimTrailing(raw) });
      continue;
    }
    const out = { defaultBranches, workingBranches, qaBranches };
    if (acceptRecord(section, record, out, knownAliases)) continue;
    // Shape matched but the block cannot honour the key. Indentation decides
    // WHERE it goes, and only here: an indented entry is one this CLI wrote, so
    // a key nobody declares anymore is its own residue — pruned, and declared.
    // A flush-left one is somebody's note that happens to read like `- k: v`,
    // and deleting it is the very loss this parser exists to stop.
    if (/^\s/.test(raw)) dropped.push(trimTrailing(raw));
    else preserved.push({ slot, text: trimTrailing(raw) });
  }

  return { defaultBranches, workingBranches, qaBranches, lastActivity, preserved, dropped };
}

/**
 * A `- key: value` entry — the shape the render emits for its own records.
 *
 * Position is NOT the signature: that is how a note written after the branch
 * header used to be adopted as a working branch and re-emitted nested under it,
 * perpetuating itself from the first re-run. What identifies a record is its
 * SHAPE plus a key the block already declares (`acceptRecord`).
 *
 * Indentation is deliberately NOT required. The render indents its own entries,
 * but a block hand-edited or written by an older CLI carries them flush left,
 * and demanding the indent would be the positional rule coming back in through
 * another door: those branches would stop being branches, and four consumers
 * read them.
 */
function readNestedRecord(_raw: string, stripped: string): { key: string; value: string } | null {
  if (!stripped.startsWith("- ")) return null;
  const entry = stripped.slice(2).trim();
  const colon = entry.indexOf(":");
  if (colon <= 0) return null;
  const key = entry.slice(0, colon).trim();
  const value = entry.slice(colon + 1).trim();
  if (!key || !value) return null;
  return { key, value };
}

interface StatusRecords {
  defaultBranches: DefaultBranches;
  workingBranches: Record<string, string>;
  qaBranches: Record<string, string>;
}

/** True when the record was stored; false when the block cannot honour it. */
function acceptRecord(
  section: Exclude<StatusSection, "none">,
  record: { key: string; value: string },
  out: StatusRecords,
  knownAliases: ReadonlySet<string>,
): boolean {
  if (section === "defaults") {
    const role = record.key.toLowerCase();
    if (!DEFAULT_BRANCH_KEYS.has(role)) return false;
    out.defaultBranches[role as keyof DefaultBranches] = record.value;
    return true;
  }
  if (!knownAliases.has(record.key)) return false;
  const target = section === "working" ? out.workingBranches : out.qaBranches;
  target[record.key] = record.value;
  return true;
}

function transitionSection(stripped: string): {
  handled: boolean;
  next: StatusSection;
  slot: StatusSlot;
  lastActivity?: string | null;
} {
  if (stripped.startsWith("- Ramas por defecto:"))
    return { handled: true, next: "defaults", slot: "status:defaults" };
  if (stripped.startsWith("- Ramas de trabajo actuales:"))
    return { handled: true, next: "working", slot: "status:working" };
  if (stripped.startsWith("- Ramas QA actuales:"))
    return { handled: true, next: "qa", slot: "status:qa" };
  if (stripped.startsWith("- Última actividad:")) {
    const idx = stripped.indexOf(":");
    return {
      handled: true,
      next: "none",
      slot: "status:activity",
      lastActivity: idx >= 0 ? stripped.slice(idx + 1).trim() : null,
    };
  }
  if (stripped.startsWith("- Histórico") || stripped.startsWith("- Historico")) {
    return { handled: true, next: "none", slot: "status:historico" };
  }
  return { handled: false, next: "none", slot: "status:start" };
}

/**
 * Drop any legacy `Mode:` line from the Proyecto text. The project/hub mode
 * concept was removed (a workspace simply has 1+ sources), so the value is
 * ignored — but historic blocks may still carry the line, and it must not leak
 * into the parsed `proyecto`.
 */
function stripLegacyModeLine(text: string): string {
  const cleanLines = text.split("\n").filter((line) => !/^\s*Mode:\s*\S/i.test(line));
  return cleanLines.join("\n").trim();
}
