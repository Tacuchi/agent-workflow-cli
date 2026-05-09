import { join } from "node:path";
import type { Flow, Phase, SessionState } from "../domain/types.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import {
  firstNonEmptyLine,
  parseMdSectionBilingual,
  parseMdValue,
  parseMdValueBilingual,
} from "./markdown.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { findArtifact } from "./session-artifacts.js";

export const KNOWN_FLOWS: ReadonlyArray<Flow> = ["core", "dev", "design", "analyze"];
const SESSION_FOLDER_RE = /^session(\d{3})-(.+)$/;

export interface SessionEntry {
  code: string | null;
  flow: Flow | null;
  name: string;
  folder: string;
  /** Absolute path to the session directory. */
  path: string;
  state: SessionState;
  phase: Phase | "requirement";
  date?: string;
  summary?: string;
  branch?: string;
  legacy_source?: string;
  has_status?: boolean;
}

export function parseSessionFolder(folder: string): {
  code: string | null;
  flow: Flow | null;
  name: string;
} {
  const m = folder.match(SESSION_FOLDER_RE);
  if (!m || !m[1] || !m[2]) {
    return { code: null, flow: null, name: folder };
  }
  const code = m[1];
  const rest = m[2];
  const parts = rest.split("-");
  const candidate = parts[0];
  if (
    parts.length >= 2 &&
    candidate &&
    (KNOWN_FLOWS as ReadonlyArray<string>).includes(candidate)
  ) {
    return { code, flow: candidate as Flow, name: parts.slice(1).join("-") };
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
  let state: SessionState;
  let phase: Phase | "requirement";
  if (status) {
    state = status.state;
    phase = status.phase;
  } else {
    state = await stateFromLegacyHeuristic(fs, sessionPath);
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
  return entries
    .filter((e) => e.type === "dir" && SESSION_FOLDER_RE.test(e.name))
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
  if (/^\d+$/.test(input)) {
    return input.padStart(3, "0");
  }
  return input.replace("session", "").split("-")[0] ?? "";
}

async function stateFromLegacyHeuristic(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<SessionState> {
  if (!(await fs.exists(sessionPath))) return "active";
  const entries = await fs.list(sessionPath);
  let hasMt = false;
  let hasMf = false;
  for (const e of entries) {
    if (e.type !== "file") continue;
    if (e.name.startsWith("MT-") && e.name.endsWith(".md")) hasMt = true;
    if (e.name.startsWith("MF-") && e.name.endsWith(".md")) hasMf = true;
  }
  return hasMt && hasMf ? "closed" : "active";
}

async function readStatus(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<{ state: SessionState; phase: Phase } | null> {
  const path = join(sessionPath, "STATUS.md");
  if (!(await fs.exists(path))) {
    return null;
  }
  const text = await fs.readText(path);
  const stateRaw = parseMdValue(text, "State")?.toLowerCase();
  const phaseRaw = parseMdValue(text, "Phase")?.toLowerCase();
  const state: SessionState = stateRaw === "closed" ? "closed" : "active";
  const phase: Phase = isPhase(phaseRaw) ? phaseRaw : "planning";
  return { state, phase };
}

async function readRequirement(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<{ date?: string; summary?: string; branch?: string }> {
  const path =
    (await findArtifact(sessionPath, "objective", fs)) ??
    (await findArtifact(sessionPath, "requirements", fs));
  if (path === null) return {};

  const text = await fs.readText(path);
  const date = parseMdValueBilingual(text, "Fecha de inicio");
  const branch = parseMdValueBilingual(text, "Rama");
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

function isPhase(value: string | undefined): value is Phase {
  return (
    value === "planning" || value === "execution" || value === "validation" || value === "closure"
  );
}

function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
