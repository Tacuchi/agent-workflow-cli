import { dirname } from "node:path";
import { acquireLock } from "../lock-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import {
  type CompactionManifest,
  type RestoreProposal,
  assertIdentity,
  readManifest,
  saveManifest,
} from "./catalog.js";
import type { CompactionDeps } from "./inventory.js";
import { compactionError, inside, safeRelative } from "./paths.js";
import { VIEW_PATH } from "./proposal.js";

async function requireManifest(deps: CompactionDeps, id: string) {
  const manifest = await readManifest(deps.fs, deps.paths, id);
  if (!manifest) throw compactionError("NOT_FOUND", `Compactación ausente: ${id}`);
  return manifest;
}

function selectPaths(manifest: CompactionManifest, paths?: string[]): string[] {
  const selected =
    paths === undefined ? manifest.proposal.originals.map((o) => o.path) : paths.map(safeRelative);
  if (
    new Set(selected).size !== selected.length ||
    selected.some((p) => !manifest.proposal.originals.some((o) => o.path === p))
  ) {
    throw compactionError("PATH", "Selección repetida o ajena a la compactación");
  }
  return [...selected].sort();
}

async function restorationBases(
  deps: CompactionDeps,
  manifest: CompactionManifest,
  paths: string[],
) {
  const bases: RestoreProposal["bases"] = [];
  for (const path of paths) {
    const original = manifest.proposal.originals.find((o) => o.path === path);
    if (!original) throw compactionError("CATALOG", "Original ausente en el manifiesto");
    const destination = await inside(deps.fs, deps.paths.hubDir(), path);
    const present = await deps.fs.exists(destination);
    if (present) assertIdentity(await deps.archive.identify(destination), original);
    else
      await deps.archive.verify(
        await inside(deps.fs, deps.paths.hubDir(), original.archive),
        original,
      );
    bases.push({ path, sha256: present ? original.sha256 : null });
  }
  return bases;
}

async function restorationProposal(
  deps: CompactionDeps,
  manifest: CompactionManifest,
  paths?: string[],
): Promise<RestoreProposal> {
  const selected = selectPaths(manifest, paths);
  const bases = await restorationBases(deps, manifest, selected);
  const body = {
    id: manifest.proposal.id,
    paths: selected,
    bases,
    manifest_digest: manifest.digest,
    view: { path: VIEW_PATH, action: "preserve" as const },
  };
  return { ...body, digest: semanticDigest(body) };
}

export async function prepareRestore(
  deps: CompactionDeps,
  id: string,
  paths?: string[],
): Promise<RestoreProposal> {
  return restorationProposal(deps, await requireManifest(deps, id), paths);
}

export async function applyRestore(
  deps: CompactionDeps,
  id: string,
  approval: string,
  paths?: string[],
) {
  if (!approval)
    throw compactionError("APPROVAL_REQUIRED", "Restaurar requiere el digest de su propuesta");
  const initial = await requireManifest(deps, id);
  const selected = selectPaths(initial, paths);
  const prior = initial.restorations?.find(
    (r) =>
      r.proposal.digest === approval &&
      semanticDigest(r.proposal.paths) === semanticDigest(selected),
  );
  const proposal = prior?.proposal ?? (await restorationProposal(deps, initial, selected));
  if (proposal.digest !== approval)
    throw compactionError("STALE", "La restauración cambió; revisá una propuesta nueva");
  const lock = await acquireLock(deps.paths.cwdLockFile(), deps.fs);
  try {
    const manifest = await requireManifest(deps, id);
    let receipt = manifest.restorations?.find((r) => r.proposal.digest === approval);
    if (!receipt) {
      const current = await restorationProposal(deps, manifest, selected);
      if (current.digest !== approval)
        throw compactionError("STALE", "La restauración cambió antes del bloqueo");
      receipt = { proposal: current, complete: false };
      manifest.restorations = [...(manifest.restorations ?? []), receipt];
      await saveManifest(deps, manifest);
    }
    // Check the whole set before the first publication; a later change still refuses exclusive create.
    await restorationBases(deps, manifest, selected);
    for (const path of selected) {
      const original = manifest.proposal.originals.find((o) => o.path === path);
      const progress = manifest.entries.find((e) => e.path === path);
      if (!original || !progress)
        throw compactionError("CATALOG", "Falta el original o su progreso");
      const destination = await inside(deps.fs, deps.paths.hubDir(), path);
      if (!(await deps.fs.exists(destination))) {
        await deps.fs.mkdirp(dirname(destination));
        await deps.archive.restore(
          await inside(deps.fs, deps.paths.hubDir(), original.archive),
          destination,
          original,
        );
      }
      assertIdentity(await deps.archive.identify(destination), original);
      progress.state = "restored";
      await saveManifest(deps, manifest);
    }
    receipt.complete = true;
    await saveManifest(deps, manifest);
    return {
      id,
      digest: approval,
      restored: selected,
      status: "complete",
      view: proposal.view,
      already_applied: prior?.complete === true,
    };
  } finally {
    await lock.release();
  }
}
