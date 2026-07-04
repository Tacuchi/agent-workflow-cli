import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { parseMdSection, parseMdSectionBilingual, parseMdValue } from "./markdown.js";
import type { PathsService } from "./paths-service.js";
import { type ArtifactKind, listExistingArtifacts } from "./session-artifacts.js";
import { CLOSED_MARKER, listSessionFolders, parseSessionFolder } from "./session-resolver.js";

const PLACEHOLDER_MARKER = "_[AI:";
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
    ultimo: parseMdSectionBilingual(text, "Lo último que hice") ?? null,
    proximo: parseMdSectionBilingual(text, "Próximo paso") ?? null,
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

export interface CheckpointReadError {
  error: string;
}

export async function runCheckpointRead(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  code: string | undefined,
): Promise<CheckpointReadOutput | CheckpointReadError> {
  const folder = await resolveTargetSession(fs, env, paths, code);
  if (!folder) return { error: "no hay sesión activa única; especificá --code" };
  const sessionPath = join(paths.cwdSessionsDir(), folder);
  const cp = await readLatestCheckpoint(fs, sessionPath);
  if (!cp) {
    return { session: folder, checkpoint: null, reason: "CHECKPOINT.md no existe" };
  }
  return { session: folder, checkpoint: cp };
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

async function resolveTargetSession(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  code: string | undefined,
): Promise<string | null> {
  if (code) {
    const sessionsDir = paths.cwdSessionsDir();
    if (!(await fs.exists(sessionsDir))) return null;
    const entries = await fs.list(sessionsDir);
    const norm = code.replace("session", "").split("-")[0]?.padStart(3, "0") ?? code;
    for (const entry of entries) {
      if (entry.type !== "dir") continue;
      const m = entry.name.match(/^session(\d{3})-/);
      if (m?.[1] === norm) return entry.name;
    }
    return null;
  }
  void env;
  const actives = await findActiveSessions(fs, paths);
  return actives.length === 1 ? (actives[0]?.folder ?? null) : null;
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
}

const DEFAULT_RECENT_DAYS = 7;

export async function runResumeSummary(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  options: ResumeSummaryOptions = {},
): Promise<ResumeSummaryOutput> {
  void env;
  const actives = await findActiveSessions(fs, paths);
  const target = actives[0];
  if (!target) {
    const baseEmpty: ResumeSummaryOutput = {
      active_sessions: [],
      primary_session: null,
      checkpoint_present: false,
      checkpoint_status: "missing",
      unfilled_placeholders: [],
      needs_ai_action: false,
    };
    if (options.includeRecentClosed === true) {
      baseEmpty.recent_closed_with_artifacts = await findRecentClosedWithArtifacts(
        fs,
        paths,
        actives.map((a) => a.folder),
        options.recentDays ?? DEFAULT_RECENT_DAYS,
      );
    }
    return baseEmpty;
  }

  const sessionPath = join(paths.cwdSessionsDir(), target.folder);
  const cp = await readLatestCheckpoint(fs, sessionPath);
  const cpStatus = await computeCheckpointStatus(fs, sessionPath);

  const codeMatch = target.folder.split("-", 1)[0]?.replace("session", "");

  const summary: ResumeSummaryOutput = {
    active_sessions: actives.map((a) => a.folder),
    primary_session: target.folder,
    primary_session_code: codeMatch && codeMatch.length > 0 ? codeMatch : null,
    checkpoint_present: cp !== null,
    checkpoint_path: cpStatus.checkpoint_path,
    checkpoint_status: cpStatus.status,
    checkpoint_age_seconds: cpStatus.age_seconds,
    unfilled_placeholders: cpStatus.unfilled_placeholders,
    needs_ai_action: cpStatus.needs_ai_action,
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

  if (options.includeRecentClosed === true) {
    summary.recent_closed_with_artifacts = await findRecentClosedWithArtifacts(
      fs,
      paths,
      actives.map((a) => a.folder),
      options.recentDays ?? DEFAULT_RECENT_DAYS,
    );
  }

  return summary;
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
    const { code } = parseSessionFolder(folder.name);
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

  out.sort((a, b) => b.code.localeCompare(a.code));
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
