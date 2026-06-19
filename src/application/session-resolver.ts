import { join } from "node:path";
import type { SessionState } from "../domain/types.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { firstNonEmptyLine, parseMdSectionBilingual, parseMdValueBilingual } from "./markdown.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { findArtifact } from "./session-artifacts.js";

/**
 * Legacy folder-name segments preserved only to split a leading segment off the
 * session name for backwards-compatible folder parsing. The value is informational
 * (no longer a typed Flow) and is ignored by state derivation.
 */
export const KNOWN_FLOWS: ReadonlyArray<string> = ["core", "dev", "design", "analyze"];
const SESSION_FOLDER_RE = /^session(\d{3})-(.+)$/;

/** Folder-local sentinel file marking a session as closed. */
export const CLOSED_MARKER = ".closed";

export interface SessionEntry {
  code: string | null;
  flow: string | null;
  name: string;
  folder: string;
  /** Absolute path to the session directory. */
  path: string;
  state: SessionState;
  /** Best-effort lifecycle phase from CHECKPOINT/STATUS; `requirement` when none. */
  phase: string;
  /** `## Type` del SESSION/OBJECTIVE. Ausente si no declarado. */
  type?: string;
  date?: string;
  summary?: string;
  branch?: string;
  legacy_source?: string;
  has_status?: boolean;
}

export function parseSessionFolder(folder: string): {
  code: string | null;
  flow: string | null;
  name: string;
} {
  const m = folder.match(SESSION_FOLDER_RE);
  if (!m || !m[1] || !m[2]) {
    // New-model slug folder (e.g. `003-spec-spec-refine`, `phase1-exec`): the folder
    // name IS the session identity. No numeric code / flow segment.
    return { code: folder, flow: null, name: folder };
  }
  const code = m[1];
  const rest = m[2];
  const parts = rest.split("-");
  const candidate = parts[0];
  if (parts.length >= 2 && candidate && KNOWN_FLOWS.includes(candidate)) {
    return { code, flow: candidate, name: parts.slice(1).join("-") };
  }
  return { code, flow: null, name: rest };
}

export interface BuildEntryOptions {
  legacySource?: string;
  verbose?: boolean;
}

export async function buildSessionEntry(
  fs: FileSystemPort,
  sessionPath: string,
  folder: string,
  options: BuildEntryOptions = {},
): Promise<SessionEntry> {
  const { code, flow, name } = parseSessionFolder(folder);

  const status = await readStatus(fs, sessionPath);
  const hasStatus = status !== null;
  const checkpointPhase = await readPhaseFromCheckpoint(fs, sessionPath);

  // Session state is derived solely from a folder-local `.closed` sentinel file
  // (locked decision): present = closed, absent = active. Type-agnostic.
  const state: SessionState = await stateFromClosedMarker(fs, sessionPath);

  let phase: string;
  if (checkpointPhase !== null) {
    phase = checkpointPhase;
  } else if (status) {
    phase = status.phase;
  } else {
    phase = "requirement";
  }

  const requirement = await readRequirement(fs, sessionPath);
  const date = requirement.date ?? (await mtimeAsDate(fs, sessionPath));
  const summary = requirement.summary ?? (name ? name.replace(/-/g, " ") : folder);

  const entry: SessionEntry = {
    code,
    flow,
    name,
    folder,
    path: sessionPath,
    state,
    phase,
    ...(requirement.type ? { type: requirement.type } : {}),
    ...(date ? { date } : {}),
    summary,
    ...(requirement.branch ? { branch: requirement.branch } : {}),
    ...(options.legacySource ? { legacy_source: options.legacySource } : {}),
  };
  if (options.verbose === true) {
    entry.has_status = hasStatus;
  }
  return entry;
}

export function serializeSessionEntry(
  entry: SessionEntry,
  cwd: string,
  options: { verbose?: boolean } = {},
): SessionEntry {
  const verbose = options.verbose === true;
  const { has_status: hasStatus, ...rest } = entry;
  const path = verbose ? entry.path : relpath(entry.path, cwd);
  if (!verbose) {
    return { ...rest, path };
  }
  // Verbose: preserve has_status in fixed position (last) like Python compact=False output.
  const result: SessionEntry & { has_status?: boolean } = { ...rest, path };
  if (hasStatus !== undefined) {
    result.has_status = hasStatus;
  }
  return result;
}

export async function listSessionFolders(
  fs: FileSystemPort,
  dir: string,
): Promise<{ name: string; path: string }[]> {
  if (!(await fs.exists(dir))) {
    return [];
  }
  const entries = await fs.list(dir);
  // New model: sessions are arbitrary slug folders under .workflow/sessions/.
  // List every directory (skipping dotfiles); identity is the folder name.
  return entries
    .filter((e) => e.type === "dir" && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: e.path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveSession(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  sessionCode: string | undefined,
  anyState = false,
): Promise<SessionEntry | null> {
  // env preserved in signature for symmetry with sibling services; the
  // sessions directory now resolves via paths so namespace flows through.
  void env;
  const dir = paths.cwdSessionsDir();
  const folders = await listSessionFolders(fs, dir);
  if (folders.length === 0) return null;

  folders.sort((a, b) => b.name.localeCompare(a.name));

  if (sessionCode !== undefined && sessionCode.length > 0) {
    const lookupCode = normalizeCode(sessionCode);
    for (const folder of folders) {
      const { code } = parseSessionFolder(folder.name);
      if (code === lookupCode || folder.name.startsWith(sessionCode)) {
        return buildSessionEntry(fs, folder.path, folder.name);
      }
    }
    return null;
  }

  for (const folder of folders) {
    const entry = await buildSessionEntry(fs, folder.path, folder.name);
    if (entry.state === "active") {
      return entry;
    }
  }

  if (anyState) {
    const first = folders[0];
    if (first) {
      return buildSessionEntry(fs, first.path, first.name);
    }
  }
  return null;
}

function normalizeCode(input: string): string {
  // Legacy numeric codes pad to 3 digits; legacy `sessionNNN-...` strips the prefix.
  // New-model slugs are used verbatim (the folder name is the identity).
  if (/^\d+$/.test(input)) {
    return input.padStart(3, "0");
  }
  if (/^session\d/.test(input)) {
    return input.replace("session", "").split("-")[0] ?? "";
  }
  return input;
}

/**
 * Derive session state from the folder-local `.closed` sentinel file:
 * present = closed, absent = active. Single canonical source of truth across
 * resolver / sessions-service / checkpoint-service. Type-agnostic.
 */
async function stateFromClosedMarker(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<SessionState> {
  return (await fs.exists(join(sessionPath, CLOSED_MARKER))) ? "closed" : "active";
}

async function readStatus(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<{ phase: string } | null> {
  const path = join(sessionPath, "STATUS.md");
  if (!(await fs.exists(path))) {
    return null;
  }
  const text = await fs.readText(path);
  const phaseRaw = parseMdValueBilingual(text, "Phase")?.toLowerCase();
  return { phase: phaseRaw && phaseRaw.length > 0 ? phaseRaw : "planning" };
}

async function readPhaseFromCheckpoint(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<string | null> {
  const path = join(sessionPath, "CHECKPOINT.md");
  if (!(await fs.exists(path))) return null;
  const text = await fs.readText(path);
  // EN canon: "- Current phase: execution (2/4)"
  // ES legacy: "- Fase actual: execution (2/4)"
  const raw =
    parseMdValueBilingual(text, "Current phase") ?? parseMdValueBilingual(text, "Fase actual");
  if (!raw) return null;
  const first = raw.trim().toLowerCase().split(/\s+/)[0];
  return first && first.length > 0 ? first : null;
}

async function readRequirement(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<{ date?: string; summary?: string; branch?: string; type?: string }> {
  // Dual-read: new-model SESSION.md first, then legacy OBJECTIVE.md, then a
  // direct REQUIREMENTS.md probe (pre-0.9 sessions; no longer a tracked kind).
  const legacyRequirements = join(sessionPath, "REQUIREMENTS.md");
  const path =
    (await findArtifact(sessionPath, "session", fs)) ??
    (await findArtifact(sessionPath, "objective", fs)) ??
    ((await fs.exists(legacyRequirements)) ? legacyRequirements : null);
  if (path === null) return {};

  const text = await fs.readText(path);
  const date = parseMdValueBilingual(text, "Fecha de inicio");
  const branch = parseMdValueBilingual(text, "Rama");
  const typeSection = parseMdSectionBilingual(text, "Type");
  const type = typeSection ? firstNonEmptyLine(typeSection)?.toLowerCase() : undefined;
  const section =
    parseMdSectionBilingual(text, "Requerimiento") ??
    parseMdSectionBilingual(text, "Brief") ??
    parseMdSectionBilingual(text, "Pregunta") ??
    parseMdSectionBilingual(text, "Descripción");
  const firstLine = section ? firstNonEmptyLine(section) : undefined;
  const summary = firstLine ? firstLine.slice(0, 100) : undefined;
  return {
    ...(date ? { date } : {}),
    ...(summary ? { summary } : {}),
    ...(branch ? { branch } : {}),
    ...(type ? { type } : {}),
  };
}

async function mtimeAsDate(fs: FileSystemPort, path: string): Promise<string | undefined> {
  try {
    const info = await fs.stat(path);
    return formatDateOnly(info.mtime);
  } catch {
    return undefined;
  }
}

function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
