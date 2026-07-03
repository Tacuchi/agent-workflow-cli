import { basename, join, relative } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { humanizeRelativeEs } from "./humanize-es.js";
import { firstNonEmptyLine } from "./markdown.js";
import { parseProjectBlock } from "./parsers/project-block.js";
import { parseTasks } from "./parsers/tasks.js";
import type { PathsService } from "./paths-service.js";
import { findArtifact } from "./session-artifacts.js";
import { SessionsService } from "./sessions-service.js";

export interface StatusWorkspace {
  name: string;
  path: string;
  /** `.<ns>/` present in the workspace root. */
  initialized: boolean;
}

export interface StatusSpec {
  file: string; // relpath from workspace, e.g. docs/specs/003-spec-foo.md
  number: string; // "003"
  slug: string; // "foo" ("" for legacy NNN-spec.md)
  /** has `## Refinement decisions` AND `## Q&A traceability` */
  refined: boolean;
  open_questions: number;
  date: string; // YYYY-MM-DD (fs mtime)
  relative: string;
}

export interface StatusPlan {
  file: string;
  number: string;
  slug: string;
  tasks_total: number;
  tasks_done: number;
  progress_pct: number;
  date: string;
  relative: string;
}

export interface StatusSession {
  code: string | null;
  folder: string;
  type: string | null;
  summary: string;
  date: string;
  relative: string;
}

export type DiscardedKind = "deferred" | "excluded";

export interface StatusDiscarded {
  source: string; // session code/folder the item came from
  source_path: string; // relpath of the session folder
  kind: DiscardedKind; // deferred (BACKLOG ## Deferred) | excluded (CHECKPOINT ## Excluded)
  text: string;
  date: string;
  relative: string;
}

export interface StatusOutput {
  workspace: StatusWorkspace;
  specs: StatusSpec[];
  plans: StatusPlan[];
  sessions: {
    active: StatusSession[];
    closed: StatusSession[];
  };
  discarded: StatusDiscarded[];
  counts: {
    specs: number;
    specs_refined: number;
    plans: number;
    sessions_active: number;
    sessions_closed: number;
    discarded: number;
  };
}

export interface StatusInput {
  now?: Date;
}

/**
 * Read-only whole-workspace status aggregator. Never throws on a reachable cwd:
 * an uninitialized workspace returns `initialized:false` with empty collections;
 * a single unreadable file is skipped rather than tanking the command.
 */
export async function runStatusCommand(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: StatusInput = {},
): Promise<StatusOutput> {
  const now = input.now ?? new Date();
  const cwd = paths.workspaceDir();

  const workspace = await readWorkspace(fs, paths, cwd);
  const specs = await readSpecs(fs, cwd, now);
  const plans = await readPlans(fs, cwd, now);
  const { active, closed, folders } = await readSessions(fs, env, paths, now);
  const discarded = await readDiscarded(fs, folders, cwd, now);

  return {
    workspace,
    specs,
    plans,
    sessions: { active, closed },
    discarded,
    counts: {
      specs: specs.length,
      specs_refined: specs.filter((s) => s.refined).length,
      plans: plans.length,
      sessions_active: active.length,
      sessions_closed: closed.length,
      discarded: discarded.length,
    },
  };
}

// ── workspace ──────────────────────────────────────────────────────────────

async function readWorkspace(
  fs: FileSystemPort,
  paths: PathsService,
  cwd: string,
): Promise<StatusWorkspace> {
  let name = basename(cwd);
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    try {
      if (!(await fs.exists(file))) continue;
      const block = parseProjectBlock(await fs.readText(file), paths.blockMarkers());
      if (block?.proyecto) {
        name = block.proyecto;
        break;
      }
    } catch {
      // ignore; fall back to basename
    }
  }
  const initialized = await safeExists(fs, paths.cwdRoot());
  return { name, path: cwd, initialized };
}

// ── specs ──────────────────────────────────────────────────────────────────

const SPEC_RE = /^(\d{3})-spec(?:-(.+))?\.md$/i;

async function readSpecs(fs: FileSystemPort, cwd: string, now: Date): Promise<StatusSpec[]> {
  const dir = join(cwd, "docs", "specs");
  const files = await listMarkdown(fs, dir, SPEC_RE);
  const deduped = dedupeRefined(files);
  const out: StatusSpec[] = [];
  for (const f of deduped) {
    try {
      const text = await fs.readText(f.path);
      const refined =
        parseMdSectionLoose(text, "Refinement decisions") !== undefined &&
        parseMdSectionLoose(text, "Q&A traceability") !== undefined;
      const ts = await resolveTimestamp(fs, f.path, undefined, now);
      out.push({
        file: relFromCwd(f.path, cwd),
        number: f.number,
        slug: f.slug,
        refined,
        open_questions: countOpenQuestions(text),
        date: ts.date,
        relative: ts.relative,
      });
    } catch {
      // skip unreadable spec
    }
  }
  return sortByNumber(out);
}

// ── plans ────────────────────────────────────────────────────────────────────

const PLAN_RE = /^(\d{3})-plan(?:-(.+))?\.md$/i;

async function readPlans(fs: FileSystemPort, cwd: string, now: Date): Promise<StatusPlan[]> {
  const dir = join(cwd, "docs", "plans");
  const files = await listMarkdown(fs, dir, PLAN_RE);
  const out: StatusPlan[] = [];
  for (const f of files) {
    try {
      const text = await fs.readText(f.path);
      const t = parseTasks(text);
      const ts = await resolveTimestamp(fs, f.path, undefined, now);
      out.push({
        file: relFromCwd(f.path, cwd),
        number: f.number,
        slug: f.slug,
        tasks_total: t.total,
        tasks_done: t.closed,
        progress_pct: t.progress_pct,
        date: ts.date,
        relative: ts.relative,
      });
    } catch {
      // skip unreadable plan
    }
  }
  return sortByNumber(out);
}

// ── sessions ──────────────────────────────────────────────────────────────────

interface SessionFolderRef {
  code: string | null;
  folder: string;
  path: string; // absolute
}

async function readSessions(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  now: Date,
): Promise<{ active: StatusSession[]; closed: StatusSession[]; folders: SessionFolderRef[] }> {
  const active: StatusSession[] = [];
  const closed: StatusSession[] = [];
  const folders: SessionFolderRef[] = [];
  let list: Awaited<ReturnType<SessionsService["list"]>>;
  try {
    list = await new SessionsService(fs, env, paths).list({ state: "all", verbose: true });
  } catch {
    return { active, closed, folders };
  }
  for (const s of list.sessions) {
    folders.push({ code: s.code, folder: s.folder, path: s.path });
    const primary = (await findArtifact(s.path, "session", fs)) ?? s.path;
    const ts = await resolveTimestamp(fs, primary, s.date, now);
    const entry: StatusSession = {
      code: s.code,
      folder: s.folder,
      type: s.type ?? null,
      summary: s.summary ?? s.folder,
      date: ts.date,
      relative: ts.relative,
    };
    (s.state === "closed" ? closed : active).push(entry);
  }
  return { active, closed, folders };
}

// ── discarded ──────────────────────────────────────────────────────────────────

async function readDiscarded(
  fs: FileSystemPort,
  folders: SessionFolderRef[],
  cwd: string,
  now: Date,
): Promise<StatusDiscarded[]> {
  const out: StatusDiscarded[] = [];
  for (const f of folders) {
    await collectDiscarded(fs, f, "backlog", "Deferred", "deferred", cwd, now, out);
    await collectDiscarded(fs, f, "checkpoint", "Excluded", "excluded", cwd, now, out);
  }
  return out;
}

async function collectDiscarded(
  fs: FileSystemPort,
  ref: SessionFolderRef,
  artifact: "backlog" | "checkpoint",
  heading: string,
  kind: DiscardedKind,
  cwd: string,
  now: Date,
  out: StatusDiscarded[],
): Promise<void> {
  try {
    const path = await findArtifact(ref.path, artifact, fs);
    if (!path) return;
    const items = listItems(parseMdSectionLoose(await fs.readText(path), heading));
    if (items.length === 0) return;
    const ts = await resolveTimestamp(fs, path, undefined, now);
    for (const text of items) {
      out.push({
        source: ref.code ?? ref.folder,
        source_path: relFromCwd(ref.path, cwd),
        kind,
        text,
        date: ts.date,
        relative: ts.relative,
      });
    }
  } catch {
    // skip unreadable artifact
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface DocFile {
  path: string;
  number: string;
  slug: string;
}

async function listMarkdown(fs: FileSystemPort, dir: string, re: RegExp): Promise<DocFile[]> {
  if (!(await safeExists(fs, dir))) return [];
  let entries: Awaited<ReturnType<FileSystemPort["list"]>>;
  try {
    entries = await fs.list(dir);
  } catch {
    return [];
  }
  const out: DocFile[] = [];
  for (const e of entries) {
    if (e.type !== "file") continue;
    const m = re.exec(e.name);
    if (!m?.[1]) continue;
    out.push({ path: e.path, number: m[1], slug: m[2] ?? "" });
  }
  return out;
}

/** Drop legacy `NNN-spec-refined.md` when another file shares its number. */
function dedupeRefined(files: DocFile[]): DocFile[] {
  const byNumber = new Map<string, DocFile[]>();
  for (const f of files) {
    const group = byNumber.get(f.number) ?? [];
    group.push(f);
    byNumber.set(f.number, group);
  }
  const out: DocFile[] = [];
  for (const group of byNumber.values()) {
    const isRefined = (f: DocFile) => /(^|-)refined$/i.test(f.slug);
    const nonRefined = group.filter((f) => !isRefined(f));
    const chosen = nonRefined.length > 0 ? nonRefined : group;
    chosen.sort((a, b) => a.path.localeCompare(b.path));
    const first = chosen[0];
    if (first) out.push(first);
  }
  return out;
}

function sortByNumber<T extends { number: string; file: string }>(items: T[]): T[] {
  return items.sort((a, b) => a.number.localeCompare(b.number) || a.file.localeCompare(b.file));
}

interface ResolvedTimestamp {
  date: string;
  relative: string;
}

/**
 * Best-available timestamp for `relative`/`date`: full-precision fs mtime if the
 * path stats, else a date-only fallback projected to local noon, else `now`.
 */
async function resolveTimestamp(
  fs: FileSystemPort,
  path: string,
  fallbackDateOnly: string | undefined,
  now: Date,
): Promise<ResolvedTimestamp> {
  let mtime: Date | null = null;
  try {
    mtime = (await fs.stat(path)).mtime;
  } catch {
    mtime = null;
  }
  const when = mtime ?? dateOnlyToNoon(fallbackDateOnly) ?? now;
  return {
    date: formatDateOnly(when),
    relative: humanizeRelativeEs(when, now),
  };
}

function dateOnlyToNoon(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}

function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function safeExists(fs: FileSystemPort, path: string): Promise<boolean> {
  try {
    return await fs.exists(path);
  } catch {
    return false;
  }
}

function relFromCwd(path: string, cwd: string): string {
  // path.relative handles the win32 case a raw string-prefix strip missed: join()
  // yields backslash paths while the old prefix appended a forward slash, so the
  // strip never matched and status showed absolute paths. Normalize to forward
  // slashes so the displayed path reads the same on every OS.
  return relative(cwd, path).split("\\").join("/");
}

/**
 * Like `parseMdSection` but tolerant of the template heading annotations
 * (`## Excluded (list):`, `## Deferred (text):`) — matches a heading whose name
 * starts with `heading`, ignoring a trailing `(...)` / `:`. Kept local so
 * `markdown.ts` stays stable; needed for legacy artifacts that still carry the
 * suffix.
 */
function parseMdSectionLoose(text: string, heading: string): string | undefined {
  const target = heading.trim().toLowerCase();
  const lines = text.split("\n");
  const headingRe = /^(#{1,6})\s+(.+?)\s*$/;
  let captureFrom: number | null = null;
  let captureLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = line.match(headingRe);
    if (!match?.[1] || !match[2]) continue;
    const level = match[1].length;
    const name = normalizeHeading(match[2]);
    if (captureFrom === null) {
      if (name === target) {
        captureFrom = i + 1;
        captureLevel = level;
      }
    } else if (level <= captureLevel) {
      return lines.slice(captureFrom, i).join("\n").trim();
    }
  }
  if (captureFrom !== null) return lines.slice(captureFrom).join("\n").trim();
  return undefined;
}

function normalizeHeading(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*:?\s*$/, "")
    .replace(/:\s*$/, "")
    .trim();
}

/** List-item lines of a section, dropping the `List of …` template placeholder. */
function listItems(section: string | undefined): string[] {
  if (!section) return [];
  const out: string[] = [];
  for (const raw of section.split("\n")) {
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(raw);
    if (!m?.[1]) continue;
    const text = m[1].trim();
    if (text.length === 0) continue;
    if (/^list of\b/i.test(text)) continue; // template placeholder
    out.push(text);
  }
  return out;
}

function countOpenQuestions(text: string): number {
  const sec = parseMdSectionLoose(text, "Open questions");
  if (!sec) return 0;
  const first = (firstNonEmptyLine(sec) ?? "").toLowerCase();
  if (first.length === 0) return 0;
  if (/^[-*]?\s*(none|ninguna|ninguno|n\/a|—|-)\.?$/.test(first)) return 0;
  const bullets = sec.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
  return bullets > 0 ? bullets : 1;
}
