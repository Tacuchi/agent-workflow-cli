import { join } from "node:path";
import { compareCorrelatives } from "../domain/correlative.js";
import type { FileSystemPort } from "../ports/file-system.js";
import {
  type LifecycleTarget,
  resolveLifecycleTarget,
  unresolvedDetail,
} from "./lifecycle-target.js";
import { parseMdSection, parseMdSectionBilingual, parseMdValue } from "./markdown.js";
import type { PathsService } from "./paths-service.js";
import { type ArtifactKind, listExistingArtifacts } from "./session-artifacts.js";
import {
  CLOSED_MARKER,
  type SessionCandidate,
  type SessionEntry,
  type SessionResolutionError,
  listSessionFolders,
  resolveSessionTarget,
  sessionNumericCode,
  sessionReadRequest,
} from "./session-resolver.js";

/**
 * What an unfilled CHECKPOINT section still says.
 *
 * Exported because it is not this module's private business: a line that still
 * carries it is the TEMPLATE asking to be written, and any reader that presents
 * it as content is reporting a fact nobody stated. `computeCheckpointStatus`
 * calls such a checkpoint `draft`; everything else has to be able to agree.
 *
 * This is now the ONLY declaration of the marker, and classifying a draft is the
 * only thing it means. `checkpoint-write-service.ts` used to declare its own
 * copy and read it as permission to overwrite the file — a second, opposite
 * meaning for the same string, which the write path resolved by destroying
 * whatever had been written into the template.
 */
export const PLACEHOLDER_MARKER = "_[AI:";
const DEFAULT_STALE_THRESHOLD_SECONDS = 300;

export interface CheckpointFields {
  path: string;
  actualizado: string | null;
  avance: string | null;
  ultimo: string | null;
  proximo: string | null;
  decisiones: string | null;
  archivos: string | null;
  contexto: string | null;
  refs: string | null;
  raw: string;
}

export interface CheckpointStatus {
  status: "missing" | "draft" | "stale" | "complete";
  checkpoint_path: string | null;
  unfilled_placeholders: string[];
  needs_ai_action: boolean;
  age_seconds: number | null;
}

/**
 * The three sections a CHECKPOINT really has today, whatever it is called.
 *
 * The artifact's contract is `## Completed` · `## Pending / Next` · `## Open
 * questions`, and every reader in this codebase used to resolve headings on its
 * own: this file asked for `Lo último que hice` and `Próximo paso` — the shape the
 * template abandoned — so every field it returned came back `null` for every
 * modern session, while `resume` read the canonical headings with a private
 * parser and got the real thing. Two readers, two answers, and the one wired into
 * `checkpoint-read` and the post-compact payload was the blind one.
 *
 * One reader now, canonical first and the historic names as fallbacks. Fallback
 * and not migration: a session written before the redesign is still readable, and
 * nothing rewrites it to make it so.
 */
export interface CheckpointNarrative {
  path: string;
  /** What is already done — `## Completed`, or the older "last action". */
  completed: string | null;
  /** What comes next — `## Pending / Next`, or the older "next step". */
  pending: string | null;
  /** Live doubts, when the artifact carries the section at all. */
  openQuestions: string | null;
}

/** `## Completed`, with the headings that meant the same thing before it. */
function readCompleted(text: string): string | null {
  return (
    parseMdSectionBilingual(text, "Completed") ??
    parseMdSectionBilingual(text, "Lo último que hice") ??
    parseMdSectionBilingual(text, "Last action") ??
    null
  );
}

/** `## Pending / Next`, with its predecessors. */
function readPending(text: string): string | null {
  return (
    parseMdSectionBilingual(text, "Pending / Next") ??
    parseMdSectionBilingual(text, "Pending") ??
    parseMdSectionBilingual(text, "Próximo paso") ??
    parseMdSectionBilingual(text, "Next step") ??
    null
  );
}

export async function readCheckpointNarrative(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<CheckpointNarrative | null> {
  const path = join(sessionPath, "CHECKPOINT.md");
  if (!(await fs.exists(path))) return null;
  const text = await fs.readText(path);
  return {
    path,
    completed: readCompleted(text),
    pending: readPending(text),
    openQuestions: parseMdSectionBilingual(text, "Open questions") ?? null,
  };
}

export async function readLatestCheckpoint(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<CheckpointFields | null> {
  const path = join(sessionPath, "CHECKPOINT.md");
  if (!(await fs.exists(path))) return null;
  const text = await fs.readText(path);
  return {
    path,
    actualizado: parseMdValue(text, "Actualizado") ?? null,
    avance: parseMdValue(text, "Avance") ?? null,
    // The canonical sections answer the same two questions the legacy ones did,
    // so they fill the same fields instead of a parallel pair nobody reads.
    ultimo: readCompleted(text),
    proximo: readPending(text),
    decisiones: parseMdSectionBilingual(text, "Decisiones recientes") ?? null,
    archivos:
      parseMdSectionBilingual(text, "Archivos tocados (post-último-commit)") ??
      parseMdSectionBilingual(text, "Archivos tocados") ??
      null,
    contexto: parseMdSectionBilingual(text, "Contexto crítico para retomar") ?? null,
    refs: parseMdSection(text, "Refs") ?? null,
    raw: text,
  };
}

export async function computeCheckpointStatus(
  fs: FileSystemPort,
  sessionPath: string,
  options: { staleThresholdSeconds?: number; now?: Date } = {},
): Promise<CheckpointStatus> {
  const threshold = options.staleThresholdSeconds ?? DEFAULT_STALE_THRESHOLD_SECONDS;
  const now = options.now ?? new Date();
  const path = join(sessionPath, "CHECKPOINT.md");
  if (!(await fs.exists(path))) {
    return {
      status: "missing",
      checkpoint_path: null,
      unfilled_placeholders: [],
      needs_ai_action: true,
      age_seconds: null,
    };
  }
  const text = await fs.readText(path);
  const placeholders = findUnfilledPlaceholders(text);
  const actualizado = parseMdValue(text, "Actualizado") ?? parseMdValue(text, "Updated");
  const ts = parseActualizado(actualizado);
  const age = ts !== null ? Math.max(0, Math.floor((now.getTime() - ts.getTime()) / 1000)) : null;

  let status: CheckpointStatus["status"];
  if (placeholders.length > 0) status = "draft";
  else if (age !== null && age > threshold) status = "stale";
  else status = "complete";

  return {
    status,
    checkpoint_path: path,
    unfilled_placeholders: placeholders,
    needs_ai_action: status !== "complete",
    age_seconds: age,
  };
}

function findUnfilledPlaceholders(text: string): string[] {
  if (!text.includes(PLACEHOLDER_MARKER)) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const [header, body] of splitSections(text)) {
    if (!body.includes(PLACEHOLDER_MARKER)) continue;
    const field = sectionToField(header);
    if (field && !seen.has(field)) {
      seen.add(field);
      found.push(field);
    }
  }
  return found;
}

function splitSections(text: string): [string, string][] {
  const sections: [string, string][] = [];
  let currentHeader: string | null = null;
  let currentBody: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      if (currentHeader !== null) {
        sections.push([currentHeader, currentBody.join("\n")]);
      }
      currentHeader = line.slice(3).trim();
      currentBody = [];
    } else if (currentHeader !== null) {
      currentBody.push(line);
    }
  }
  if (currentHeader !== null) {
    sections.push([currentHeader, currentBody.join("\n")]);
  }
  return sections;
}

function sectionToField(header: string): string | null {
  const h = stripAccentsLower(header);
  // The artifact's own headings, first: a placeholder left inside `Completed` or
  // `Pending / Next` used to map to nothing, so a half-written CHECKPOINT read as
  // `complete`. Same three names the narrative reader resolves.
  if (h === "completed") return "ultimo";
  if (h.startsWith("pending")) return "proximo";
  if (h.startsWith("open questions")) return "contexto";
  // EN canon (R3) — emitted by current write paths.
  if (h === "last action" || h.startsWith("last action")) return "ultimo";
  if (h === "next step" || h.startsWith("next step")) return "proximo";
  if (h.startsWith("files touched")) return "archivos_proposito";
  if (h.startsWith("critical context")) return "contexto";
  // ES legacy — preserved for sessions written pre-R3.
  if (h.includes("lo ultimo que hice") || h === "lo ultimo") return "ultimo";
  if (h.includes("proximo paso")) return "proximo";
  if (h.startsWith("archivos tocados")) return "archivos_proposito";
  if (h.includes("contexto critico")) return "contexto";
  if (h === "refs") return "skills";
  return null;
}

function stripAccentsLower(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function parseActualizado(value: string | undefined): Date | null {
  if (!value) return null;
  const s = value.trim();
  // Match Python formats: %Y-%m-%d %H:%M:%S, %Y-%m-%d %H:%M
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m || !m[1] || !m[2] || !m[3] || !m[4] || !m[5]) return null;
  const date = new Date(
    Number.parseInt(m[1], 10),
    Number.parseInt(m[2], 10) - 1,
    Number.parseInt(m[3], 10),
    Number.parseInt(m[4], 10),
    Number.parseInt(m[5], 10),
    m[6] ? Number.parseInt(m[6], 10) : 0,
  );
  return Number.isFinite(date.getTime()) ? date : null;
}

export interface CheckpointReadOutput {
  session: string;
  checkpoint: CheckpointFields | null;
  reason?: string;
}

export type CheckpointReadResult = CheckpointReadOutput | { sessionError: SessionResolutionError };

export async function runCheckpointRead(
  fs: FileSystemPort,
  paths: PathsService,
  input: { code?: string; contextId?: string },
): Promise<CheckpointReadResult> {
  const resolution = await resolveSessionTarget(fs, paths, sessionReadRequest(input));
  if (resolution.outcome !== "resolved") return { sessionError: resolution };
  const session = resolution.session;
  const cp = await readLatestCheckpoint(fs, session.path);
  if (!cp) {
    return { session: session.folder, checkpoint: null, reason: "CHECKPOINT.md no existe" };
  }
  return { session: session.folder, checkpoint: cp };
}

export interface ActiveSession {
  folder: string;
}

/**
 * Active sessions are non-`.closed` folders under `.workflow/sessions/`.
 * Sessions are no longer registered in the project block; state derives solely
 * from the folder-local `.closed` sentinel (type-agnostic).
 */
export async function findActiveSessions(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<ActiveSession[]> {
  const folders = await listSessionFolders(fs, paths.cwdSessionsDir());
  const active: ActiveSession[] = [];
  for (const folder of folders) {
    if (await fs.exists(join(folder.path, CLOSED_MARKER))) continue;
    active.push({ folder: folder.name });
  }
  return active;
}

export interface RecentClosedEntry {
  code: string;
  folder: string;
  closed_age_seconds: number;
  complete: boolean;
  artifact_signal: string;
}

export interface ResumeSummaryOutput {
  active_sessions: string[];
  primary_session: string | null;
  primary_session_code?: string | null;
  checkpoint_present: boolean;
  checkpoint_path?: string | null;
  checkpoint_status: CheckpointStatus["status"];
  checkpoint_age_seconds?: number | null;
  unfilled_placeholders: string[];
  needs_ai_action: boolean;
  /** `degraded` = no state is restored until the target is resolved. */
  continuity: "ok" | "degraded";
  candidates?: SessionCandidate[];
  action?: string;
  checkpoint?: {
    actualizado: string | null;
    avance: string | null;
    proximo: string[] | null;
  };
  recent_closed_with_artifacts?: RecentClosedEntry[];
}

export interface ResumeSummaryOptions {
  includeRecentClosed?: boolean;
  recentDays?: number;
  code?: string;
  contextId?: string;
}

const DEFAULT_RECENT_DAYS = 7;

/**
 * PostCompact payload. It used to present `actives[0]` — the OLDEST active
 * session — as the primary one, so a compacted conversation could be handed
 * another conversation's checkpoint. The target is now the canonical one, and
 * an unresolvable target degrades: `primary_session: null` plus candidates,
 * never an arbitrary session. PostCompact never blocks — the host already
 * compacted; what it must not do is restore the wrong line.
 */
export async function runResumeSummary(
  fs: FileSystemPort,
  paths: PathsService,
  options: ResumeSummaryOptions = {},
): Promise<ResumeSummaryOutput> {
  // Deliberately an aggregated read: it may list N sessions and turns none of
  // them into the conversation's association (AC-09).
  const actives = await findActiveSessions(fs, paths);
  const activeFolders = actives.map((a) => a.folder);

  // Does NOT bind, which is what the paragraph above always claimed and the
  // code did not do: presenting a session is not claiming it. PostCompact only
  // restores; the association it reports was established by whoever wrote.
  const target = await resolveLifecycleTarget(
    fs,
    paths,
    {
      ...(options.code !== undefined ? { code: options.code } : {}),
      ...(options.contextId !== undefined ? { contextId: options.contextId } : {}),
    },
    "read-only",
  );

  const summary =
    target.outcome === "resolved"
      ? await summarizeResolved(fs, activeFolders, target.session)
      : degradedSummary(activeFolders, target);

  if (options.includeRecentClosed === true) {
    summary.recent_closed_with_artifacts = await findRecentClosedWithArtifacts(
      fs,
      paths,
      activeFolders,
      options.recentDays ?? DEFAULT_RECENT_DAYS,
    );
  }
  return summary;
}

async function summarizeResolved(
  fs: FileSystemPort,
  activeFolders: string[],
  session: SessionEntry,
): Promise<ResumeSummaryOutput> {
  const cp = await readLatestCheckpoint(fs, session.path);
  const cpStatus = await computeCheckpointStatus(fs, session.path);
  const code = sessionNumericCode(session.folder);

  const summary: ResumeSummaryOutput = {
    active_sessions: activeFolders,
    primary_session: session.folder,
    primary_session_code: code,
    checkpoint_present: cp !== null,
    checkpoint_path: cpStatus.checkpoint_path,
    checkpoint_status: cpStatus.status,
    checkpoint_age_seconds: cpStatus.age_seconds,
    unfilled_placeholders: cpStatus.unfilled_placeholders,
    needs_ai_action: cpStatus.needs_ai_action,
    continuity: "ok",
  };

  if (cp) {
    const proximoLines = cp.proximo
      ? cp.proximo
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .slice(0, 3)
      : null;
    summary.checkpoint = {
      actualizado: cp.actualizado,
      avance: cp.avance,
      proximo: proximoLines && proximoLines.length > 0 ? proximoLines : null,
    };
  }
  return summary;
}

function degradedSummary(
  activeFolders: string[],
  target: Extract<LifecycleTarget, { outcome: "degraded" | "blocked" }>,
): ResumeSummaryOutput {
  const detail = unresolvedDetail(target);
  return {
    active_sessions: activeFolders,
    primary_session: null,
    primary_session_code: null,
    checkpoint_present: false,
    checkpoint_status: "missing",
    unfilled_placeholders: [],
    // Nothing to do when there is no session at all; with candidates present,
    // resolving the target IS the pending action.
    needs_ai_action: activeFolders.length > 0,
    continuity: "degraded",
    candidates: detail.candidates,
    action: detail.action,
  };
}

/**
 * Finds closed sessions (`.closed` sentinel present) within the `recentDays`
 * window (folder mtime) that carry new-model closure artifacts (CONCLUSIONS.md
 * or ANALYSIS-FILE.md). Type-agnostic: no longer depends on the flow.
 *
 * Sorted by code descending (most recent first).
 */
export async function findRecentClosedWithArtifacts(
  fs: FileSystemPort,
  paths: PathsService,
  activeFolders: readonly string[],
  recentDays: number,
): Promise<RecentClosedEntry[]> {
  const sessionsDir = paths.cwdSessionsDir();
  const folders = await listSessionFolders(fs, sessionsDir);
  if (folders.length === 0) return [];

  const activeSet = new Set(activeFolders);
  const windowMs = recentDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const out: RecentClosedEntry[] = [];

  for (const folder of folders) {
    if (activeSet.has(folder.name)) continue;
    const code = sessionNumericCode(folder.name);
    if (code === null) continue;
    if (!(await fs.exists(join(folder.path, CLOSED_MARKER)))) continue;
    let mtimeMs: number;
    try {
      const st = await fs.stat(folder.path);
      mtimeMs = st.mtime.getTime();
    } catch {
      continue;
    }
    const ageMs = now - mtimeMs;
    if (ageMs < 0 || ageMs > windowMs) continue;

    const present = await listExistingArtifacts(folder.path, fs);
    const { complete, signal } = evaluateArtifactCompleteness(present);
    if (!complete) continue;

    out.push({
      code,
      folder: folder.name,
      closed_age_seconds: Math.floor(ageMs / 1000),
      complete: true,
      artifact_signal: signal,
    });
  }

  out.sort((a, b) => compareCorrelatives(b.code, a.code) || a.folder.localeCompare(b.folder));
  return out;
}

function evaluateArtifactCompleteness(present: Record<ArtifactKind, string | null>): {
  complete: boolean;
  signal: string;
} {
  if (present.conclusions !== null) return { complete: true, signal: "CONCLUSIONS" };
  if (present.analysis_file !== null) return { complete: true, signal: "ANALYSIS-FILE" };
  return { complete: false, signal: "no-closure-artifact" };
}
