import { basename, join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import {
  firstNonEmptyLine,
  parseMdSection,
  parseMdSectionBilingual,
  parseMdValue,
  parseMdValueBilingual,
} from "./markdown.js";
import {
  type ProjectBlockMarkers,
  type ProjectSession,
  parseProjectBlock,
} from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { type ArtifactKind, findArtifact } from "./session-artifacts.js";

const PLACEHOLDER_MARKER = "_[AI:";
const DEFAULT_STALE_THRESHOLD_SECONDS = 300;

export interface CheckpointFields {
  path: string;
  actualizado: string | null;
  fase: string | null;
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
    fase: parseMdValueBilingual(text, "Fase actual") ?? null,
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
  let r = s.toLowerCase();
  r = r.replace(/á/g, "a");
  r = r.replace(/é/g, "e");
  r = r.replace(/í/g, "i");
  r = r.replace(/ó/g, "o");
  r = r.replace(/ú/g, "u");
  r = r.replace(/ü/g, "u");
  return r;
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

export async function findActiveSessions(
  fs: FileSystemPort,
  cwd: string,
  markers?: ProjectBlockMarkers,
): Promise<ProjectSession[]> {
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), markers);
    if (block) return block.sessions;
  }
  return [];
}

async function resolveTargetSession(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  code: string | undefined,
): Promise<string | null> {
  if (code) {
    // Look for matching folder.
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
  const actives = await findActiveSessions(fs, env.cwd(), paths.blockMarkers());
  return actives.length === 1 ? (actives[0]?.folder ?? null) : null;
}

export interface ResumeSummaryOutput {
  active_sessions: string[];
  primary_session: string | null;
  primary_session_code?: string | null;
  phase_from_qtc_project?: string | null;
  branches_from_qtc_project?: string[];
  checkpoint_present: boolean;
  checkpoint_path?: string | null;
  checkpoint_status: CheckpointStatus["status"];
  checkpoint_age_seconds?: number | null;
  unfilled_placeholders: string[];
  needs_ai_action: boolean;
  checkpoint?: {
    actualizado: string | null;
    fase: string | null;
    avance: string | null;
    proximo: string[] | null;
  };
}

export async function runResumeSummary(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
): Promise<ResumeSummaryOutput> {
  const cwd = env.cwd();
  const actives = await findActiveSessions(fs, cwd, paths.blockMarkers());
  if (actives.length === 0) {
    return {
      active_sessions: [],
      primary_session: null,
      checkpoint_present: false,
      checkpoint_status: "missing",
      unfilled_placeholders: [],
      needs_ai_action: false,
    };
  }

  const target = actives[0];
  if (!target) {
    return {
      active_sessions: [],
      primary_session: null,
      checkpoint_present: false,
      checkpoint_status: "missing",
      unfilled_placeholders: [],
      needs_ai_action: false,
    };
  }

  const sessionPath = join(paths.cwdSessionsDir(), target.folder);
  const cp = await readLatestCheckpoint(fs, sessionPath);
  const cpStatus = await computeCheckpointStatus(fs, sessionPath);

  const codeMatch = target.folder.split("-", 1)[0]?.replace("session", "");

  const summary: ResumeSummaryOutput = {
    active_sessions: actives.map((a) => a.folder),
    primary_session: target.folder,
    primary_session_code: codeMatch && codeMatch.length > 0 ? codeMatch : null,
    phase_from_qtc_project: target.phase,
    branches_from_qtc_project: target.branches,
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
      fase: cp.fase,
      avance: cp.avance,
      proximo: proximoLines && proximoLines.length > 0 ? proximoLines : null,
    };
  }

  return summary;
}

export interface CompressCheckpointOutput {
  session: string;
  candidates: Array<{
    file: string;
    lines: number;
    excess: number;
    head_excerpt: string;
    tail_excerpt: string;
  }>;
}

export interface CompressCheckpointError {
  error: string;
}

const COMPRESS_KINDS: ArtifactKind[] = ["findings", "evidence", "discovery", "problem"];
const DEFAULT_COMPRESS_THRESHOLD = 200;

export async function runCompressCheckpoint(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  options: { code?: string; threshold?: number } = {},
): Promise<CompressCheckpointOutput | CompressCheckpointError> {
  const folder = await resolveTargetSession(fs, env, paths, options.code);
  if (!folder) return { error: "no hay sesión activa única; especificá --code" };
  const sessionPath = join(paths.cwdSessionsDir(), folder);
  const threshold = options.threshold ?? DEFAULT_COMPRESS_THRESHOLD;

  const candidates: CompressCheckpointOutput["candidates"] = [];
  for (const kind of COMPRESS_KINDS) {
    const fpath = await findArtifact(sessionPath, kind, fs);
    if (!fpath) continue;
    const text = await fs.readText(fpath);
    const lines = text.split("\n");
    if (lines.length <= threshold) continue;
    candidates.push({
      file: basename(fpath),
      lines: lines.length,
      excess: lines.length - threshold,
      head_excerpt: (firstNonEmptyLine(text) ?? "").slice(0, 50),
      tail_excerpt: (lines[lines.length - 2] ?? "").slice(0, 50),
    });
  }
  return { session: folder, candidates };
}
