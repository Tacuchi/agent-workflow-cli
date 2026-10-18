import { assertIdentity, readManifest } from "./catalog.js";
import type { CompactionDeps } from "./inventory.js";
import { compactionError, inside } from "./paths.js";

const READ_LIMIT = 1024 * 1024;

async function originalLocation(deps: CompactionDeps, id: string, path: string) {
  const manifest = await readManifest(deps.fs, deps.paths, id);
  if (!manifest) throw compactionError("NOT_FOUND", `Compactación ausente: ${id}`);
  const original = manifest.proposal.originals.find((o) => o.path === path);
  const reference = manifest.proposal.inventory.entries.find((e) => e.path === path);
  if (!reference || reference.bytes === null || reference.sha256 === null)
    throw compactionError("NOT_FOUND", "Referencia ajena al inventario aprobado");
  const expected = { bytes: reference.bytes, sha256: reference.sha256 };
  const progress = manifest.entries.find((e) => e.path === path);
  const index = manifest.proposal.originals.findIndex((o) => o.path === path);
  const recovery =
    index < 0
      ? null
      : await inside(
          deps.fs,
          deps.paths.hubDir(),
          `${manifest.proposal.catalog}/recovery/${index}`,
        );
  const recoveryPath = recovery && (await deps.fs.exists(recovery)) ? recovery : null;
  const source = await inside(deps.fs, deps.paths.hubDir(), path);
  const archive = original ? await inside(deps.fs, deps.paths.hubDir(), original.archive) : null;
  const useArchive =
    original && (progress?.state === "archived" || progress?.state === "quarantined");
  const location = useArchive ? archive : source;
  return { expected, progress, source, location, recoveryPath, useArchive };
}

async function inspectOriginal(
  deps: CompactionDeps,
  id: string,
  path: string,
  includeContent: boolean,
) {
  const { expected, progress, source, location, recoveryPath, useArchive } = await originalLocation(
    deps,
    id,
    path,
  );
  if (!location || !(await deps.fs.exists(location)))
    return {
      path,
      integrity: "missing",
      state: progress?.state ?? "in-place",
      location,
      recovery_path: recoveryPath,
    };
  try {
    if (useArchive) await deps.archive.verify(location, expected);
    else assertIdentity(await deps.archive.identify(source), expected);
    const content =
      includeContent && expected.bytes <= READ_LIMIT
        ? Buffer.from(
            useArchive
              ? await deps.archive.read(location, expected, READ_LIMIT)
              : await deps.fs.readBytes(source),
          ).toString("base64")
        : null;
    return {
      path,
      integrity: "verified",
      state: progress?.state ?? "in-place",
      location,
      recovery_path: recoveryPath,
      bytes: expected.bytes,
      sha256: expected.sha256,
      content_base64: content,
      content_limit_bytes: READ_LIMIT,
      query: `aw hub-compact restore ${id} --path ${JSON.stringify(path)}`,
    };
  } catch (error) {
    return {
      path,
      integrity: "corrupt",
      state: progress?.state ?? "in-place",
      location,
      error: (error as Error).message,
    };
  }
}

export async function inspectCompaction(deps: CompactionDeps, id: string, path?: string) {
  const manifest = await readManifest(deps.fs, deps.paths, id);
  if (!manifest) throw compactionError("NOT_FOUND", `Compactación ausente: ${id}`);
  const originals = [];
  for (const item of path === undefined ? manifest.proposal.originals.map((o) => o.path) : [path]) {
    originals.push(await inspectOriginal(deps, id, item, path !== undefined));
  }
  return {
    id,
    manifest,
    originals,
    integrity: originals.every((o) => o.integrity === "verified")
      ? "verified"
      : "unavailable-or-corrupt",
    complete: manifest.status === "complete" && originals.every((o) => o.integrity === "verified"),
  };
}
