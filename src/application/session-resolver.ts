import { join } from "node:path";
import type { SessionState } from "../domain/types.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { localDateIso } from "./dates.js";
import { withCwdLock } from "./lock-service.js";
import { firstNonEmptyLine, parseMdSectionBilingual, parseMdValueBilingual } from "./markdown.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { findArtifact } from "./session-artifacts.js";
import { bindContextToSession, lookupBinding } from "./session-binding-service.js";

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
  /**
   * `## Type` from SESSION/OBJECTIVE (legacy artifacts), else derived from the
   * folder's `<slug>-<flow>` suffix. Absent when neither declares it.
   */
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
  const type = requirement.type ?? typeFromNameSuffix(folder);

  const entry: SessionEntry = {
    code,
    name,
    folder,
    path: sessionPath,
    state,
    ...(type ? { type } : {}),
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

// ---------------------------------------------------------------------------
// Canonical session resolution
//
// ONE target for every session-scoped operation, with a fixed precedence:
//   valid explicit identity → durable conversation binding → sole active session.
// An invalid explicit identity ENDS the resolution — it never falls through to
// the binding or the fallback. Nothing is ever chosen by name order, recency or
// age: several active sessions without an association is `SESSION_AMBIGUOUS`,
// not "the first one".
// ---------------------------------------------------------------------------

export type SessionErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_CLOSED"
  | "SESSION_AMBIGUOUS"
  | "SESSION_BINDING_INVALID";

/** Which precedence step produced the target (drives who establishes a binding). */
export type ResolutionVia = "explicit" | "binding" | "sole_active";

export interface SessionCandidate {
  folder: string;
  /** Numeric identity when the folder carries one (see `sessionNumericCode`). */
  code: string | null;
  state: SessionState;
}

export interface SessionResolutionError {
  outcome: "error";
  code: SessionErrorCode;
  message: string;
  candidates: SessionCandidate[];
  /** One valid next move the caller can surface verbatim. */
  action: string;
}

export type SessionResolution =
  | { outcome: "resolved"; via: ResolutionVia; session: SessionEntry }
  | SessionResolutionError;

export interface SessionResolveRequest {
  /** Explicit identity: `NNN`, `NNN-<slug>`, legacy code, or `sessionNNN-<slug>`. */
  code?: string;
  /** Opaque conversation id, already extracted by the CLI context adapter. */
  contextId?: string;
  /**
   * Accept a closed session as the target. Read paths and `session-close` set
   * it; write paths leave it off so a closed line is never mutated by accident.
   * It never relaxes the fallback: a closed session is not a "sole active" one.
   */
  allowClosed?: boolean;
  /**
   * Establish the conversation association on success. Set by operations that
   * own no other lock boundary; `session-create`, `session-resume --reopen` and
   * `session-close` bind inside their own `withCwdLock` instead, so the lock is
   * acquired once per operation.
   */
  bind?: boolean;
}

/**
 * Request shape shared by every session-scoped READ: an optional explicit
 * identity, the conversation's own association as the fallback, a closed target
 * accepted (reading a finished line is legitimate), and the association
 * established so later operations in the same conversation stay on this line.
 *
 * `exactOptionalPropertyTypes` is on, hence the spreads instead of assigning
 * `undefined`.
 */
export function sessionReadRequest(input: {
  code?: string;
  contextId?: string;
}): SessionResolveRequest {
  return {
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    allowClosed: true,
    bind: true,
  };
}

/**
 * Numeric identity of a session folder: `044` for `044-<slug>`, `007` for the
 * legacy `session007-<slug>`, `null` when the folder carries no numeric prefix.
 *
 * Deliberately distinct from `parseSessionFolder().code`, which returns the
 * WHOLE folder name for current-model folders — HISTORY rows and the commit
 * advisor key off that shape, so it stays as it is.
 */
export function sessionNumericCode(folder: string): string | null {
  const m = folder.match(/^(?:session)?(\d+)-/);
  return m?.[1] ?? null;
}

/**
 * The slug a session folder carries: `roles-ficha` for `067-roles-ficha-plan-new`.
 *
 * The folder is `NNN-<slug>-<flow>` by construction — that is the name
 * `session-create` is told to use, and the loops spell it that way — so the slug
 * is a fact the engine already holds rather than something a run has to narrate.
 * The flow is passed in and matched as a SUFFIX instead of being guessed: a slug
 * may itself end in a word a flow name starts with, and the flow the state knows
 * is the only unambiguous place to cut.
 *
 * `null` for a folder that does not fit the shape, and null is the point of the
 * return type: a slug this function had to invent would end up in a filename.
 */
export function sessionSlug(folder: string, flow: string): string | null {
  const rest = folder.match(/^(?:session)?\d+-(.+)$/)?.[1];
  const suffix = `-${flow}`;
  if (rest === undefined || !rest.endsWith(suffix)) return null;
  const slug = rest.slice(0, -suffix.length);
  return slug.length > 0 ? slug : null;
}

export async function resolveSessionTarget(
  fs: FileSystemPort,
  paths: PathsService,
  request: SessionResolveRequest,
): Promise<SessionResolution> {
  const resolution = await walkPrecedence(fs, paths, request);
  if (resolution.outcome !== "resolved" || request.bind !== true) return resolution;
  return (await establishBinding(fs, paths, request.contextId, resolution)) ?? resolution;
}

async function walkPrecedence(
  fs: FileSystemPort,
  paths: PathsService,
  request: SessionResolveRequest,
): Promise<SessionResolution> {
  const folders = await listSessionFolders(fs, paths.cwdSessionsDir());
  const scanned = await scanFolders(fs, folders);

  const code = request.code?.trim() ?? "";
  if (code.length > 0) {
    return resolveExplicit(fs, scanned, code, request.allowClosed === true);
  }

  const contextId = request.contextId?.trim() ?? "";
  if (contextId.length > 0) {
    const viaBinding = await resolveFromBinding(fs, paths, scanned, contextId);
    if (viaBinding !== null) return viaBinding;
  }

  return resolveSoleActive(fs, scanned);
}

/**
 * Persist the association a successful resolution implies. Both an explicit
 * selection and the sole-active fallback establish it (`via: "binding"` already
 * IS the association, and a conversation with no id has nothing to associate).
 * Returns an error to replace the resolution when the registry cannot be
 * written — fail-closed: a caller must never believe it got associated when it
 * did not. `null` = nothing to report.
 */
async function establishBinding(
  fs: FileSystemPort,
  paths: PathsService,
  contextId: string | undefined,
  resolution: { via: ResolutionVia; session: SessionEntry },
): Promise<SessionResolutionError | null> {
  const id = contextId?.trim() ?? "";
  if (id.length === 0 || resolution.via === "binding") return null;
  // Never associate a conversation with a closed session: the binding path
  // treats a closed target as stale, so writing one would poison the next read.
  if (resolution.session.state === "closed") return null;

  // Optimistic, and deliberately so. The common case is an association that
  // already points here — a loop re-running `--code NNN` every turn. Reading is
  // lock-free, so an ordinary session-scoped read neither contends for the
  // workspace lock nor starts failing while another operation holds it.
  const current = await lookupBinding(fs, paths, id);
  if (current.status === "bound" && current.folder === resolution.session.folder) return null;
  if (current.status === "invalid") return bindingFailure(resolution.session, current.reason);

  const written = await withCwdLock(fs, paths, () =>
    bindContextToSession(fs, paths, id, resolution.session.folder),
  );
  if ("error" in written) return bindingFailure(resolution.session, written.error);
  return written.ok ? null : bindingFailure(resolution.session, written.reason);
}

function bindingFailure(session: SessionEntry, reason: string): SessionResolutionError {
  return {
    outcome: "error",
    code: "SESSION_BINDING_INVALID",
    message: `no se pudo asociar la conversación a '${session.folder}': ${reason}`,
    candidates: [
      { folder: session.folder, code: sessionNumericCode(session.folder), state: session.state },
    ],
    action: "inspeccioná o retirá `.workflow/sessions/.bindings.json` y reintentá",
  };
}

interface ScannedFolder {
  name: string;
  path: string;
  code: string | null;
  state: SessionState;
}

async function scanFolders(
  fs: FileSystemPort,
  folders: { name: string; path: string }[],
): Promise<ScannedFolder[]> {
  const out: ScannedFolder[] = [];
  for (const folder of folders) {
    out.push({
      name: folder.name,
      path: folder.path,
      code: sessionNumericCode(folder.name),
      state: await stateFromClosedMarker(fs, folder.path),
    });
  }
  return out;
}

async function resolveExplicit(
  fs: FileSystemPort,
  scanned: ScannedFolder[],
  code: string,
  allowClosed: boolean,
): Promise<SessionResolution> {
  const matches = scanned.filter((s) => matchesIdentity(s.name, code));
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only === undefined) {
    return matches.length === 0
      ? resolutionError(
          "SESSION_NOT_FOUND",
          `no existe una sesión que coincida con '${code}'`,
          scanned,
          "revisá `aw sessions` y reintentá con un código o carpeta existente",
        )
      : resolutionError(
          "SESSION_AMBIGUOUS",
          `'${code}' coincide con ${matches.length} sesiones`,
          matches,
          "reintentá con el nombre exacto de la carpeta",
        );
  }
  if (only.state === "closed" && !allowClosed) {
    return resolutionError(
      "SESSION_CLOSED",
      `la sesión '${only.name}' está cerrada`,
      [only],
      "reabrila con `aw session-resume --code <NNN> --reopen` o elegí una sesión activa",
    );
  }
  return {
    outcome: "resolved",
    via: "explicit",
    session: await buildSessionEntry(fs, only.path, only.name),
  };
}

/** `null` = this conversation has no association; keep walking the precedence. */
async function resolveFromBinding(
  fs: FileSystemPort,
  paths: PathsService,
  scanned: ScannedFolder[],
  contextId: string,
): Promise<SessionResolution | null> {
  const lookup = await lookupBinding(fs, paths, contextId);
  if (lookup.status === "unbound") return null;
  if (lookup.status === "invalid") {
    return resolutionError(
      "SESSION_BINDING_INVALID",
      lookup.reason,
      scanned,
      "inspeccioná o retirá `.workflow/sessions/.bindings.json`, o indicá la sesión con --code",
    );
  }
  // A stale association fails closed. Redirecting it to another active session
  // is exactly the session mixing this resolver exists to prevent.
  const target = scanned.find((s) => s.name === lookup.folder);
  if (target === undefined) {
    return resolutionError(
      "SESSION_BINDING_INVALID",
      `la conversación está asociada a '${lookup.folder}', que ya no existe`,
      scanned,
      "reasociá la conversación reanudando explícitamente con --code",
    );
  }
  if (target.state === "closed") {
    return resolutionError(
      "SESSION_BINDING_INVALID",
      `la conversación está asociada a '${lookup.folder}', que está cerrada`,
      scanned,
      "reasociá la conversación con `aw session-resume --code <NNN> --reopen`",
    );
  }
  return {
    outcome: "resolved",
    via: "binding",
    session: await buildSessionEntry(fs, target.path, target.name),
  };
}

async function resolveSoleActive(
  fs: FileSystemPort,
  scanned: ScannedFolder[],
): Promise<SessionResolution> {
  const actives = scanned.filter((s) => s.state === "active");
  const only = actives.length === 1 ? actives[0] : undefined;
  if (only !== undefined) {
    return {
      outcome: "resolved",
      via: "sole_active",
      session: await buildSessionEntry(fs, only.path, only.name),
    };
  }
  if (actives.length === 0) {
    return resolutionError(
      "SESSION_NOT_FOUND",
      "no hay sesiones activas en el workspace",
      scanned,
      "creá una con `aw session-create` o indicá una existente con --code",
    );
  }
  return resolutionError(
    "SESSION_AMBIGUOUS",
    `hay ${actives.length} sesiones activas y la conversación no tiene una asociación`,
    actives,
    "indicá cuál con --code <NNN>",
  );
}

/**
 * Identity match, anchored on a `-` word boundary so `100` never matches
 * `1000-…` nor `01` matches `012-…`. A numeric identity also reaches the legacy
 * `sessionNNN-…` layout, so one code resolves a session in either format.
 */
function matchesIdentity(folder: string, input: string): boolean {
  if (folder === input) return true;
  const digits = numericIdentity(input);
  if (digits !== null) {
    return folder.startsWith(`${digits}-`) || folder.startsWith(`session${digits}-`);
  }
  return folder.startsWith(`${input}-`);
}

function numericIdentity(input: string): string | null {
  if (/^\d+$/.test(input)) return input.padStart(3, "0");
  const legacy = input.match(/^session(\d+)/);
  return legacy?.[1] ? legacy[1].padStart(3, "0") : null;
}

function resolutionError(
  code: SessionErrorCode,
  message: string,
  candidates: ScannedFolder[],
  action: string,
): SessionResolutionError {
  return {
    outcome: "error",
    code,
    message,
    candidates: candidates.map((s) => ({ folder: s.name, code: s.code, state: s.state })),
    action,
  };
}

/**
 * Fallback when SESSION.md carries no `## Type` (no longer rendered): derive
 * the type from the descriptor's `<slug>-<flow>` suffix. Unknown suffix →
 * undefined (same as before: type stays absent).
 */
export function typeFromNameSuffix(folder: string): string | undefined {
  if (/-(spec-refine|plan-new|plan-refine)$/.test(folder)) return "refine";
  if (folder.endsWith("-plan-exec")) return "exec";
  if (folder.endsWith("-quick")) return "quick";
  return undefined;
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
