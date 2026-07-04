import { join } from "node:path";
import type { SessionState } from "../domain/types.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { localDateIso } from "./dates.js";
import { firstNonEmptyLine, parseMdSectionBilingual, parseMdValueBilingual } from "./markdown.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { findArtifact } from "./session-artifacts.js";

const SESSION_FOLDER_RE = /^session(\d{3})-(.+)$/;

/** Folder-local sentinel file marking a session as closed. */
export const CLOSED_MARKER = ".closed";

export interface SessionEntry {
  code: string | null;
  name: string;
  folder: string;
  /** Absolute path to the session directory. */
  path: string;
  state: SessionState;
  /** `## Type` from SESSION/OBJECTIVE. Absent when not declared. */
  type?: string;
  date?: string;
  summary?: string;
  branch?: string;
}

export function parseSessionFolder(folder: string): {
  code: string | null;
  name: string;
} {
  const m = folder.match(SESSION_FOLDER_RE);
  if (!m || !m[1] || !m[2]) {
    // New-model slug folder (e.g. `003-spec-spec-refine`, `phase1-exec`): the folder
    // name IS the session identity. No numeric code segment.
    return { code: folder, name: folder };
  }
  // Legacy `sessionNNN-...` folders: split off the leading numeric code for
  // back-compat. The remainder is the name verbatim (no flow-segment splitting).
  return { code: m[1], name: m[2] };
}

export async function buildSessionEntry(
  fs: FileSystemPort,
  sessionPath: string,
  folder: string,
): Promise<SessionEntry> {
  const { code, name } = parseSessionFolder(folder);

  // Session state is derived solely from a folder-local `.closed` sentinel file
  // (locked decision): present = closed, absent = active. Type-agnostic.
  const state: SessionState = await stateFromClosedMarker(fs, sessionPath);

  const requirement = await readRequirement(fs, sessionPath);
  const date = requirement.date ?? (await mtimeAsDate(fs, sessionPath));
  const summary = requirement.summary ?? (name ? name.replace(/-/g, " ") : folder);

  const entry: SessionEntry = {
    code,
    name,
    folder,
    path: sessionPath,
    state,
    ...(requirement.type ? { type: requirement.type } : {}),
    ...(date ? { date } : {}),
    summary,
    ...(requirement.branch ? { branch: requirement.branch } : {}),
  };
  return entry;
}

export function serializeSessionEntry(
  entry: SessionEntry,
  cwd: string,
  options: { verbose?: boolean } = {},
): SessionEntry {
  const verbose = options.verbose === true;
  const path = verbose ? entry.path : relpath(entry.path, cwd);
  return { ...entry, path };
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
      // Match the legacy numeric code, an exact new-model folder name, or a
      // prefix up to a `-` word boundary. The boundary matters: a bare
      // `startsWith(code)` lets "100" fuzzy-match "1000-…" (reachable once the
      // global counter passes 999 and 4-digit prefixes coexist with 3-digit
      // ones) or "01" match "012-…", silently resolving the wrong session.
      // Anchor on the normalized `lookupCode` so abbreviated numeric codes
      // (e.g. `--code 1`) resolve consistently too.
      if (
        code === lookupCode ||
        folder.name === lookupCode ||
        folder.name.startsWith(`${lookupCode}-`)
      ) {
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
    return localDateIso(info.mtime);
  } catch {
    return undefined;
  }
}
