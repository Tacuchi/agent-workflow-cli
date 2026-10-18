import { join } from "node:path";
import { proposalDigest } from "../../domain/proposal.js";
import type { ByteIdentity } from "../../ports/archive.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { PathsService } from "../paths-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import type { CompactionDeps } from "./inventory.js";
import { catalogRelative, compactionError, inside, operationRelative } from "./paths.js";
import { type CompactionProposal, compactionId, parseCompactionInput } from "./proposal.js";

export type OriginalState =
  | "pending"
  | "staged"
  | "retained"
  | "quarantined"
  | "archived"
  | "restored";
const ORIGINAL_STATES: OriginalState[] = [
  "pending",
  "staged",
  "retained",
  "quarantined",
  "archived",
  "restored",
];
export interface ArchiveProgress {
  path: string;
  state: OriginalState;
  compressed: ByteIdentity | null;
}
export interface CompactionManifest {
  version: 1;
  proposal: CompactionProposal;
  status: "preparing" | "published" | "complete";
  view_published: boolean;
  entries: ArchiveProgress[];
  restorations?: { proposal: RestoreProposal; complete: boolean }[];
  digest: string;
}

export interface RestoreProposal {
  id: string;
  paths: string[];
  bases: { path: string; sha256: string | null }[];
  manifest_digest: string;
  view: { path: string; action: "preserve" };
  digest: string;
}

export function assertIdentity(actual: ByteIdentity, expected: ByteIdentity) {
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw compactionError("STALE", "El archivo cambió respecto de los bytes aprobados");
  }
}

export async function saveManifest(deps: CompactionDeps, manifest: CompactionManifest) {
  const { digest: _old, ...body } = manifest;
  manifest.digest = semanticDigest(body);
  const destination = await inside(
    deps.fs,
    deps.paths.hubDir(),
    `${manifest.proposal.catalog}/manifest.json`,
  );
  await deps.fs.writeText(destination, JSON.stringify(manifest, null, 2));
}

function validateManifest(manifest: CompactionManifest, paths: PathsService, id: string) {
  const { digest, ...body } = manifest;
  if (
    manifest.version !== 1 ||
    digest !== semanticDigest(body) ||
    !["preparing", "published", "complete"].includes(manifest.status)
  ) {
    throw compactionError("CATALOG", "Manifiesto incompatible o corrupto");
  }
  const p = manifest.proposal;
  const request = parseCompactionInput(p.request);
  if (
    p.id !== id ||
    compactionId(request) !== id ||
    p.catalog !== operationRelative(paths, id) ||
    p.local.digest !== proposalDigest(p.local) ||
    p.inventory.root !== paths.hubDir() ||
    p.originals.length !== request.selection.length ||
    manifest.entries.length !== p.originals.length
  ) {
    throw compactionError(
      "CATALOG",
      "La propuesta del catálogo no coincide con su sello y alcance",
    );
  }
  for (const [index, original] of p.originals.entries()) {
    const entry = p.inventory.entries.find((e) => e.path === original.path);
    const progress = manifest.entries[index];
    if (
      original.path !== request.selection[index] ||
      original.archive !== `${p.catalog}/originals/${index}.gz` ||
      progress?.path !== original.path ||
      !ORIGINAL_STATES.includes(progress.state) ||
      entry?.disposition !== "eligible" ||
      entry.bytes !== original.bytes ||
      entry.sha256 !== original.sha256 ||
      !Number.isSafeInteger(original.bytes) ||
      original.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(original.sha256)
    ) {
      throw compactionError("CATALOG", "Original o ruta de archivo incompatible");
    }
  }
}

export async function readManifest(
  fs: FileSystemPort,
  paths: PathsService,
  id: string,
): Promise<CompactionManifest | null> {
  const path = await inside(fs, paths.hubDir(), `${operationRelative(paths, id)}/manifest.json`);
  if (!(await fs.exists(path))) return null;
  if ((await fs.stat(path)).size > 64 * 1024 * 1024)
    throw compactionError("CATALOG", "Manifiesto fuera del límite de 64 MiB");
  try {
    const manifest = JSON.parse(await fs.readText(path)) as CompactionManifest;
    validateManifest(manifest, paths, id);
    return manifest;
  } catch (error) {
    throw compactionError("CATALOG", `Manifiesto ilegible o inválido: ${(error as Error).message}`);
  }
}

export interface CatalogOriginal {
  operation: string;
  path: string;
  bytes: number;
  sha256: string;
  state: OriginalState;
  archive: string;
  integrity: "unchecked" | "missing";
  query: string;
}

/** Metadata-only reader shared by session queries and exports; never restores. */
export async function catalogOriginals(
  fs: FileSystemPort,
  paths: PathsService,
  prefix: string,
): Promise<CatalogOriginal[]> {
  const root = await inside(fs, paths.hubDir(), catalogRelative(paths));
  if (!(await fs.exists(root))) return [];
  const originals: CatalogOriginal[] = [];
  for (const item of (await fs.list(root)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.type !== "dir")
      throw compactionError("CATALOG", `Entrada no interpretable: ${item.name}`);
    const manifest = await readManifest(fs, paths, item.name);
    if (!manifest) throw compactionError("CATALOG", `Operación sin manifiesto: ${item.name}`);
    originals.push(...(await manifestOriginals(fs, paths, prefix, manifest)));
  }
  return originals;
}

async function manifestOriginals(
  fs: FileSystemPort,
  paths: PathsService,
  prefix: string,
  manifest: CompactionManifest,
): Promise<CatalogOriginal[]> {
  const originals: CatalogOriginal[] = [];
  for (const [index, original] of manifest.proposal.originals.entries()) {
    if (!original.path.startsWith(`${prefix}/`)) continue;
    const entry = manifest.entries[index];
    if (!entry) throw compactionError("CATALOG", "Falta el progreso del original");
    const location =
      entry.state === "archived" || entry.state === "quarantined"
        ? original.archive
        : original.path;
    const archive = await inside(fs, paths.hubDir(), location);
    originals.push({
      operation: manifest.proposal.id,
      ...original,
      state: entry.state,
      integrity: (await fs.exists(archive)) ? "unchecked" : "missing",
      query: `aw hub-compact inspect ${manifest.proposal.id} --path ${JSON.stringify(original.path)}`,
    });
  }
  return originals;
}

export async function storedBytes(fs: FileSystemPort, path: string): Promise<number> {
  let bytes = 0;
  for (const entry of await fs.list(path)) {
    if ((await fs.lstat(entry.path))?.isSymlink)
      throw compactionError("PATH", "Enlace en el catálogo");
    bytes +=
      entry.type === "dir"
        ? await storedBytes(fs, entry.path)
        : (await fs.stat(join(path, entry.name))).size;
  }
  return bytes;
}
