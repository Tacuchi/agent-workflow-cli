import { basename, join, relative } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { localDateIso } from "./dates.js";
import { type DesignGraph, buildDesignGraph } from "./design/design-graph-service.js";
import { humanizeRelativeEs } from "./humanize-es.js";
import { firstNonEmptyLine, parseMdSection, parseMdSectionBilingual } from "./markdown.js";
import { type ParsedPhases, parsePhases } from "./parsers/phases.js";
import { type ParsedPlanStatus, parsePlanStatus } from "./parsers/plan-status.js";
import { parseProjectBlock } from "./parsers/project-block.js";
import { type SpecEvidence, parseSpecRelation } from "./parsers/spec-relation.js";
import { type ParsedTasks, parseTasks } from "./parsers/tasks.js";
import type { PathsService } from "./paths-service.js";
import { findArtifact } from "./session-artifacts.js";
import { SessionsService } from "./sessions-service.js";

/**
 * The one reading of the workspace's Workline documents.
 *
 * `status` and `resume` used to answer the same questions from two places —
 * one in the CLI, one re-derived by an agent reading JSON — and drifted. This
 * module owns specs, plans, sessions, the spec→plan relation and the pending
 * pipeline; both commands project it and neither decides anything on its own.
 *
 * Read-only by construction: nothing here opens a file for writing.
 */

const SPEC_STATUSES = ["draft", "refining", "ready-for-plan"] as const;

/** Spec maturity: how ready the spec is for `plan-new` to design against it. */
export type SpecStatus = (typeof SPEC_STATUSES)[number];

/**
 * Whole-plan closure, derived — never declared alone and never inferred from
 * the counters. `open` = there is still something to do or to validate;
 * `done` = the plan declares it AND the counters back the declaration;
 * `inconsistent` = the document contradicts itself and a human must repair it.
 */
export type PlanState = "open" | "done" | "inconsistent";

/**
 * The spec a plan derives from, resolved against the real spec inventory.
 *
 * `unknown` and `ambiguous` are first-class answers, not failures to hide: a
 * plan whose provenance cannot be proven stays visible as unproven rather than
 * being attached to whichever spec looks similar.
 */
export type SpecRelation =
  | { status: "resolved"; number: string; file: string; evidence: SpecEvidence }
  | { status: "unknown"; reason: "no-evidence" | "spec-not-found" }
  | { status: "ambiguous"; numbers: string[]; evidence: SpecEvidence };

export interface IndexedWorkspace {
  name: string;
  path: string;
  /** `.<ns>/` present in the workspace root. */
  initialized: boolean;
}

export interface IndexedSpec {
  file: string;
  number: string;
  slug: string;
  /** frontmatter `status:` when declared, else inferred from the legacy trace sections */
  status: SpecStatus;
  /** derived alias of `status === "ready-for-plan"`; kept for existing consumers */
  refined: boolean;
  open_questions: number;
  date: string;
  relative: string;
}

export interface IndexedBlockedPhase {
  number: number;
  name: string;
  /** the phase's `> Bloqueo:` reason; `null` on a legacy block that declares none */
  blocker: string | null;
}

export interface IndexedPlan {
  file: string;
  number: string;
  slug: string;
  tasks_total: number;
  tasks_done: number;
  /** checkbox-derived work progress; the phase counts below never feed it */
  progress_pct: number;
  /** `### Fn` blocks inside `## Tasks`; `0` on a plan with none stated (pre-contract) */
  phases_total: number;
  /** phases whose exact mark is `> Estado: validada` — never inferred from the checkboxes */
  phases_validated: number;
  /** the plan's third axis: closure, derived from the declaration AND the two counters */
  plan_state: PlanState;
  /** phases whose exact mark is `> Estado: bloqueada` */
  phases_blocked: number;
  /** the blocked phases with what each one waits on */
  blocked_phases: IndexedBlockedPhase[];
  /** every task done and every phase validated, but the final validation never ran */
  final_validation_pending: boolean;
  /** which spec this plan proves it came from */
  spec: SpecRelation;
  date: string;
  relative: string;
}

export interface IndexedSession {
  code: string | null;
  folder: string;
  path: string;
  type: string | null;
  summary: string;
  state: "active" | "closed";
  has_checkpoint: boolean;
  /** the spec/plan its `## Origin` points at, when it points at one */
  linked_doc: string | null;
  date: string;
  relative: string;
}

export type DiscardedKind = "deferred" | "excluded";

export interface IndexedDiscarded {
  source: string;
  source_path: string;
  kind: DiscardedKind;
  text: string;
  date: string;
  relative: string;
}

/**
 * What is left to do, in the order the spec fixes: an unrefined spec outranks a
 * spec with no plan, which outranks an incomplete plan, which outranks a loose
 * checkpoint. Inside plans a partially executed one outranks an untouched one.
 *
 * Nothing here is sorted by date or age — two items that tie stay tied, and the
 * caller asks. That is the whole point: recency is not priority.
 */
export type PipelineKind = "spec-unrefined" | "spec-unplanned" | "plan-open" | "checkpoint-orphan";

export interface PipelineItem {
  kind: PipelineKind;
  priority: 1 | 2 | 3 | 4;
  /** workspace-relative path of the doc, or of the session folder */
  file: string;
  number: string | null;
  slug: string;
  summary: string;
  /** the exact command that continues this item — presented, never executed */
  command: string;
  /** plans only: work already started outranks an untouched plan */
  started?: boolean;
}

export interface WorklineIndex {
  workspace: IndexedWorkspace;
  specs: IndexedSpec[];
  plans: IndexedPlan[];
  sessions: IndexedSession[];
  discarded: IndexedDiscarded[];
  pipeline: PipelineItem[];
  /** `spec → package → flow/screen → plan/task`, with its four reference states. */
  designs: DesignGraph;
}

export interface WorklineIndexInput {
  now?: Date;
}

/**
 * Never throws on a reachable cwd: an uninitialized workspace returns
 * `initialized:false` with empty collections, and a single unreadable file is
 * skipped rather than tanking the whole read.
 */
export async function buildWorklineIndex(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: WorklineIndexInput = {},
): Promise<WorklineIndex> {
  const now = input.now ?? new Date();
  const cwd = paths.workspaceDir();

  const workspace = await readWorkspace(fs, paths, cwd);
  const specs = await readSpecs(fs, cwd, now);
  const plans = await readPlans(fs, cwd, specs, now);
  const sessions = await readSessions(fs, env, paths, now);
  const discarded = await readDiscarded(fs, sessions, cwd, now);
  const designs = await buildDesignGraph(fs, cwd, [
    ...specs.map((s) => ({ file: s.file, kind: "spec" as const })),
    ...plans.map((p) => ({ file: p.file, kind: "plan" as const })),
  ]);

  return {
    workspace,
    specs,
    plans,
    sessions,
    discarded,
    pipeline: derivePipeline(specs, plans, sessions),
    designs,
  };
}

// ── pipeline ─────────────────────────────────────────────────────────────────

function derivePipeline(
  specs: IndexedSpec[],
  plans: IndexedPlan[],
  sessions: IndexedSession[],
): PipelineItem[] {
  const plannedSpecs = new Set(
    plans.map((p) => (p.spec.status === "resolved" ? p.spec.number : null)).filter(isString),
  );

  const items: PipelineItem[] = [];
  for (const spec of specs) {
    if (spec.status !== "ready-for-plan") {
      items.push(specItem(spec, 1, "spec-unrefined", "/w:spec-refine"));
    } else if (!plannedSpecs.has(spec.number)) {
      items.push(specItem(spec, 2, "spec-unplanned", "/w:plan-new"));
    }
  }
  for (const plan of plans) {
    if (plan.plan_state === "done") continue;
    items.push({
      kind: "plan-open",
      priority: 3,
      file: plan.file,
      number: plan.number,
      slug: plan.slug,
      summary: planSummary(plan),
      command: `/w:plan-exec ${plan.file}`,
      started: plan.tasks_done > 0 || plan.phases_validated > 0,
    });
  }
  for (const session of sessions) {
    if (session.state !== "active" || !session.has_checkpoint) continue;
    if (session.linked_doc !== null) continue;
    items.push({
      kind: "checkpoint-orphan",
      priority: 4,
      file: session.folder,
      number: session.code,
      slug: session.folder,
      summary: session.summary,
      command: `aw session-resume --code ${session.folder} --reopen`,
      started: true,
    });
  }
  return items.sort(comparePipeline);
}

function specItem(
  spec: IndexedSpec,
  priority: 1 | 2,
  kind: PipelineKind,
  command: string,
): PipelineItem {
  return {
    kind,
    priority,
    file: spec.file,
    number: spec.number,
    slug: spec.slug,
    summary: `spec ${spec.number} — ${spec.status}`,
    command: `${command} ${spec.file}`,
  };
}

function planSummary(plan: IndexedPlan): string {
  const phases =
    plan.phases_total > 0 ? `, fases ${plan.phases_validated}/${plan.phases_total}` : "";
  const blocked = plan.phases_blocked > 0 ? `, ${plan.phases_blocked} bloqueada(s)` : "";
  return `plan ${plan.number} — ${plan.progress_pct}%${phases}${blocked}`;
}

/**
 * Priority first, then started-before-untouched, then document number. The last
 * key is presentation only — two items that reach it are still a tie for the
 * caller, which is why `resume` compares priority and `started`, never order.
 */
function comparePipeline(a: PipelineItem, b: PipelineItem): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const started = Number(b.started ?? false) - Number(a.started ?? false);
  if (started !== 0) return started;
  return (a.number ?? "").localeCompare(b.number ?? "");
}

function isString(value: string | null): value is string {
  return value !== null;
}

// ── workspace ────────────────────────────────────────────────────────────────

async function readWorkspace(
  fs: FileSystemPort,
  paths: PathsService,
  cwd: string,
): Promise<IndexedWorkspace> {
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
  return { name, path: cwd, initialized: await safeExists(fs, paths.cwdRoot()) };
}

// ── specs ────────────────────────────────────────────────────────────────────

const SPEC_RE = /^(\d{3})-spec(?:-(.+))?\.md$/i;

async function readSpecs(fs: FileSystemPort, cwd: string, now: Date): Promise<IndexedSpec[]> {
  const files = dedupeRefined(await listMarkdown(fs, join(cwd, "docs", "specs"), SPEC_RE));
  const out: IndexedSpec[] = [];
  for (const f of files) {
    try {
      const text = await fs.readText(f.path);
      const status = resolveSpecStatus(text);
      const ts = await resolveTimestamp(fs, f.path, undefined, now);
      out.push({
        file: relFromCwd(f.path, cwd),
        number: f.number,
        slug: f.slug,
        status,
        refined: status === "ready-for-plan",
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

/**
 * The only two trace sections that marked a spec as worked-through before the
 * frontmatter `status` existed. `## Decisions` is NOT one of them: it belongs
 * to the current spec schema and proves nothing about the refine gate.
 *
 * Exported so the doctrine guard can check this list against the marks the
 * bundle documents — the two drifted apart once, and a spec nobody refined
 * reached PLAN because of it.
 */
export const LEGACY_READY_MARKS = ["Refinement decisions", "Q&A traceability"];

/**
 * Spec maturity. A declared frontmatter governs alone: an empty, unknown or
 * unterminated declaration reads `draft` — never a legacy inference, which
 * would send work to PLAN on a gate `spec-refine` never ran. Legacy
 * compatibility runs only on a spec that carries no frontmatter at all.
 */
function resolveSpecStatus(text: string): SpecStatus {
  const frontmatter = parseSpecFrontmatter(text);
  if (frontmatter.kind === "malformed") return "draft";
  if (frontmatter.kind === "present") {
    const declared = (frontmatter.status ?? "").toLowerCase();
    return isSpecStatus(declared) ? declared : "draft";
  }
  return hasLegacyReadyMark(text) ? "ready-for-plan" : "draft";
}

function hasLegacyReadyMark(text: string): boolean {
  return LEGACY_READY_MARKS.some((h) => parseMdSectionLoose(text, h) !== undefined);
}

function isSpecStatus(value: string): value is SpecStatus {
  return (SPEC_STATUSES as readonly string[]).includes(value);
}

const FRONTMATTER_FENCE = "---";
const FRONTMATTER_ENTRY = /^([A-Za-z0-9_-]+):\s*(.*)$/;

/**
 * `absent` (no block at the top) · `present` (block opened and closed) ·
 * `malformed` (opened, never closed). The three are not interchangeable: a
 * broken declaration is a declaration, and only `absent` may fall back.
 */
type SpecFrontmatter =
  | { kind: "absent" | "malformed" }
  | { kind: "present"; status: string | undefined };

/**
 * Classify the `---` block at the top of the file and read its `status` scalar.
 * Specs only carry flat scalars there, so this stays a few lines instead of
 * pulling a YAML dependency into the CLI.
 */
function parseSpecFrontmatter(text: string): SpecFrontmatter {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== FRONTMATTER_FENCE) return { kind: "absent" };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === FRONTMATTER_FENCE);
  if (end === -1) return { kind: "malformed" };
  return { kind: "present", status: readScalar(lines.slice(1, end), "status") };
}

function readScalar(lines: string[], key: string): string | undefined {
  for (const line of lines) {
    const m = FRONTMATTER_ENTRY.exec(line);
    if (m?.[1] !== key) continue;
    const value = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

// ── plans ────────────────────────────────────────────────────────────────────

const PLAN_RE = /^(\d{3})-plan(?:-(.+))?\.md$/i;

async function readPlans(
  fs: FileSystemPort,
  cwd: string,
  specs: IndexedSpec[],
  now: Date,
): Promise<IndexedPlan[]> {
  const files = await listMarkdown(fs, join(cwd, "docs", "plans"), PLAN_RE);
  const byNumber = new Map(specs.map((s) => [s.number, s]));
  const out: IndexedPlan[] = [];
  for (const f of files) {
    try {
      const text = await fs.readText(f.path);
      const t = parseTasks(text);
      const p = parsePhases(text);
      const planState = derivePlanState(parsePlanStatus(text).declared, t, p);
      const ts = await resolveTimestamp(fs, f.path, undefined, now);
      out.push({
        file: relFromCwd(f.path, cwd),
        number: f.number,
        slug: f.slug,
        tasks_total: t.total,
        tasks_done: t.closed,
        progress_pct: t.progress_pct,
        phases_total: p.total,
        phases_validated: p.validated,
        plan_state: planState,
        phases_blocked: p.blocked,
        blocked_phases: p.items
          .filter((phase) => phase.state === "bloqueada")
          .map((phase) => ({ number: phase.n, name: phase.name, blocker: phase.blocker })),
        final_validation_pending:
          planState === "open" && p.total > 0 && p.validated === p.total && t.closed === t.total,
        spec: resolveSpecRelation(text, byNumber),
        date: ts.date,
        relative: ts.relative,
      });
    } catch {
      // skip unreadable plan
    }
  }
  return sortByNumber(out);
}

function resolveSpecRelation(text: string, specs: Map<string, IndexedSpec>): SpecRelation {
  const parsed = parseSpecRelation(text);
  if (parsed.status === "absent") return { status: "unknown", reason: "no-evidence" };
  if (parsed.status === "ambiguous") {
    return { status: "ambiguous", numbers: parsed.numbers, evidence: parsed.evidence };
  }
  const spec = specs.get(parsed.number);
  // The plan names a spec that is not in the workspace: evidence exists but
  // proves nothing here, and inventing a match by slug is exactly the guess
  // this resolution exists to remove.
  if (spec === undefined) return { status: "unknown", reason: "spec-not-found" };
  return {
    status: "resolved",
    number: parsed.number,
    file: spec.file,
    evidence: parsed.evidence,
  };
}

/**
 * The three axes reconciled into one closure state. The rules, in order:
 *
 * - a plan that declares nothing, or declares `open`, IS open — including the
 *   case where every box is ticked and every phase is validated: that plan is
 *   waiting on its final validation, not finished (`final_validation_pending`);
 * - a plan that declares `done` is `done` only when the counters agree — every
 *   task closed and, under the phase contract, every phase validated;
 * - any other combination is `inconsistent`: the document says one thing and
 *   shows another, and nothing but a human repairs that.
 *
 * A plan with no phase marks predates the contract (`phases_total: 0`) and is
 * judged by its checkboxes alone — it never acquires fictitious phases, and
 * `done` on such a plan stays legitimate when its boxes are all ticked.
 */
function derivePlanState(
  declared: ParsedPlanStatus["declared"],
  tasks: ParsedTasks,
  phases: ParsedPhases,
): PlanState {
  if (declared === "unknown") return "inconsistent";
  if (declared !== "done") return "open";
  if (tasks.closed !== tasks.total) return "inconsistent";
  // Legacy contract (`legacy-tasks`): no phase marks, so the checkboxes decide.
  if (phases.total === 0) return "done";
  return phases.validated === phases.total ? "done" : "inconsistent";
}

// ── sessions ─────────────────────────────────────────────────────────────────

const LINKED_DOC_RE = /docs\/(?:specs|plans)\/\d{3}-(?:spec|plan)[^\s`)"']*\.md/;

async function readSessions(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  now: Date,
): Promise<IndexedSession[]> {
  let list: Awaited<ReturnType<SessionsService["list"]>>;
  try {
    list = await new SessionsService(fs, env, paths).list({ state: "all", verbose: true });
  } catch {
    return [];
  }

  const out: IndexedSession[] = [];
  for (const s of list.sessions) {
    const primary = (await findArtifact(s.path, "session", fs)) ?? s.path;
    const ts = await resolveTimestamp(fs, primary, s.date, now);
    const checkpoint = await findArtifact(s.path, "checkpoint", fs);
    out.push({
      code: s.code,
      folder: s.folder,
      path: s.path,
      type: s.type ?? null,
      summary: s.summary ?? s.folder,
      state: s.state === "closed" ? "closed" : "active",
      has_checkpoint: checkpoint !== null && checkpoint !== undefined,
      linked_doc: await readLinkedDoc(fs, primary),
      date: ts.date,
      relative: ts.relative,
    });
  }
  return out;
}

/** The spec/plan a session's `## Origin` points at — `null` when it points at none. */
async function readLinkedDoc(fs: FileSystemPort, sessionFile: string): Promise<string | null> {
  try {
    const origin = parseMdSectionBilingual(await fs.readText(sessionFile), "Origin");
    return origin === undefined ? null : (LINKED_DOC_RE.exec(origin)?.[0] ?? null);
  } catch {
    return null;
  }
}

// ── discarded ────────────────────────────────────────────────────────────────

async function readDiscarded(
  fs: FileSystemPort,
  sessions: IndexedSession[],
  cwd: string,
  now: Date,
): Promise<IndexedDiscarded[]> {
  const out: IndexedDiscarded[] = [];
  for (const s of sessions) {
    await collectDiscarded(fs, s, "backlog", "Deferred", "deferred", cwd, now, out);
    await collectDiscarded(fs, s, "checkpoint", "Excluded", "excluded", cwd, now, out);
  }
  return out;
}

async function collectDiscarded(
  fs: FileSystemPort,
  session: IndexedSession,
  artifact: "backlog" | "checkpoint",
  heading: string,
  kind: DiscardedKind,
  cwd: string,
  now: Date,
  out: IndexedDiscarded[],
): Promise<void> {
  try {
    const path = await findArtifact(session.path, artifact, fs);
    if (!path) return;
    const items = listItems(parseMdSectionLoose(await fs.readText(path), heading));
    if (items.length === 0) return;
    const ts = await resolveTimestamp(fs, path, undefined, now);
    for (const text of items) {
      out.push({
        source: session.code ?? session.folder,
        source_path: relFromCwd(session.path, cwd),
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
  return { date: localDateIso(when), relative: humanizeRelativeEs(when, now) };
}

function dateOnlyToNoon(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
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
 * (`## Excluded (list):`, `## Deferred (text):`) — ignores a trailing
 * `(...)` / `:`; needed for legacy artifacts that still carry the suffix.
 */
const parseMdSectionLoose = (text: string, heading: string): string | undefined =>
  parseMdSection(text, heading, normalizeHeading);

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
