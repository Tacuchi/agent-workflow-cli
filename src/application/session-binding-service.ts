import { createHash } from "node:crypto";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";

/**
 * Durable conversation→session association.
 *
 * The registry lives at `.workflow/sessions/.bindings.json` — machine-local
 * state, gitignored along with the sessions dir. Keys are the SHA-256 of the
 * host's opaque conversation id (the raw id is NEVER persisted); values are
 * canonical session folder names.
 *
 * Every function here is **lock-free**: the caller owns the workspace lock so
 * one operation = one lock boundary (no nested acquisition). Reads are safe
 * without the lock because `writeText` renames atomically onto the path.
 *
 * Validation is manual (DEC-001: no Zod) and **fail-closed**: an unreadable,
 * malformed or unknown-version registry is reported as invalid and never
 * overwritten — repairing it automatically would silently drop associations.
 */

/** Only this schema version is accepted. */
export const BINDINGS_VERSION = 1;

export interface BindingRegistry {
  version: number;
  bindings: Record<string, string>;
}

export type RegistryRead = { ok: true; registry: BindingRegistry } | { ok: false; reason: string };

export type BindingLookup =
  | { status: "unbound" }
  | { status: "bound"; folder: string }
  | { status: "invalid"; reason: string };

export type BindingWrite = { ok: true; changed: boolean } | { ok: false; reason: string };

/** SHA-256 of the opaque conversation id — the only form that reaches disk. */
export function hashContextId(contextId: string): string {
  return createHash("sha256").update(contextId, "utf8").digest("hex");
}

function parseBindingRegistry(raw: string): RegistryRead {
  if (raw.trim().length === 0) return { ok: true, registry: emptyRegistry() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "el registro de bindings no es JSON válido" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "el registro de bindings no es un objeto JSON" };
  }
  const { version, bindings } = parsed as { version?: unknown; bindings?: unknown };
  if (version !== BINDINGS_VERSION) {
    return { ok: false, reason: `versión de registro no soportada: ${String(version)}` };
  }
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) {
    return { ok: false, reason: "el campo 'bindings' no es un mapa" };
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(bindings as Record<string, unknown>)) {
    if (key.length === 0 || typeof value !== "string" || value.length === 0) {
      return { ok: false, reason: `entrada de binding inválida en la clave '${key}'` };
    }
    entries[key] = value;
  }
  return { ok: true, registry: { version: BINDINGS_VERSION, bindings: entries } };
}

export async function readBindingRegistry(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<RegistryRead> {
  const path = paths.cwdSessionBindingsFile();
  if (!(await fs.exists(path))) return { ok: true, registry: emptyRegistry() };
  let raw: string;
  try {
    raw = await fs.readText(path);
  } catch {
    return { ok: false, reason: `no se pudo leer el registro de bindings (${path})` };
  }
  return parseBindingRegistry(raw);
}

/** Which session this conversation is associated with, if any. */
export async function lookupBinding(
  fs: FileSystemPort,
  paths: PathsService,
  contextId: string,
): Promise<BindingLookup> {
  const read = await readBindingRegistry(fs, paths);
  if (!read.ok) return { status: "invalid", reason: read.reason };
  const folder = read.registry.bindings[hashContextId(contextId)];
  return folder === undefined ? { status: "unbound" } : { status: "bound", folder };
}

/**
 * Associate this conversation with `folder`, replacing only its own entry.
 * `changed: false` when the association already pointed there (no write).
 */
export async function bindContextToSession(
  fs: FileSystemPort,
  paths: PathsService,
  contextId: string,
  folder: string,
): Promise<BindingWrite> {
  const read = await readBindingRegistry(fs, paths);
  if (!read.ok) return { ok: false, reason: read.reason };
  const key = hashContextId(contextId);
  if (read.registry.bindings[key] === folder) return { ok: true, changed: false };
  const bindings = { ...read.registry.bindings, [key]: folder };
  await writeBindingRegistry(fs, paths, bindings);
  return { ok: true, changed: true };
}

/**
 * Drop every association pointing at `folder` (session closed). Other
 * conversations keep theirs — a closed session never redirects to another line.
 */
export async function invalidateBindingsTo(
  fs: FileSystemPort,
  paths: PathsService,
  folder: string,
): Promise<{ ok: true; removed: number } | { ok: false; reason: string }> {
  const read = await readBindingRegistry(fs, paths);
  if (!read.ok) return { ok: false, reason: read.reason };
  const kept: Record<string, string> = {};
  let removed = 0;
  for (const [key, value] of Object.entries(read.registry.bindings)) {
    if (value === folder) removed += 1;
    else kept[key] = value;
  }
  if (removed > 0) await writeBindingRegistry(fs, paths, kept);
  return { ok: true, removed };
}

function emptyRegistry(): BindingRegistry {
  return { version: BINDINGS_VERSION, bindings: {} };
}

async function writeBindingRegistry(
  fs: FileSystemPort,
  paths: PathsService,
  bindings: Record<string, string>,
): Promise<void> {
  // Keys sorted so the file is byte-stable across runs regardless of insertion
  // order (diffable, golden-friendly).
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(bindings).sort()) {
    const value = bindings[key];
    if (value !== undefined) sorted[key] = value;
  }
  const payload: BindingRegistry = { version: BINDINGS_VERSION, bindings: sorted };
  await fs.mkdirp(paths.cwdSessionsDir());
  await fs.writeText(paths.cwdSessionBindingsFile(), `${JSON.stringify(payload, null, 2)}\n`);
}
