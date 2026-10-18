import { dirname, join } from "node:path";
import { acquireLock } from "../lock-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import {
  type ArchiveProgress,
  type CompactionManifest,
  assertIdentity,
  readManifest,
  saveManifest,
  storedBytes,
} from "./catalog.js";
import { type CompactionDeps, type HubInventory, inventoryHub } from "./inventory.js";
import { compactionError, inside, operationRelative } from "./paths.js";
import {
  type CompactionProposal,
  type SelectedOriginal,
  VIEW_PATH,
  compactionId,
  parseCompactionInput,
  prepareCompaction,
} from "./proposal.js";

function normalizeOriginals(p: CompactionProposal, current: HubInventory) {
  for (const original of p.originals) {
    const present = current.entries.find((e) => e.path === original.path);
    if (
      present &&
      (present.sha256 !== original.sha256 ||
        present.bytes !== original.bytes ||
        present.disposition !== "eligible")
    ) {
      throw compactionError("STALE", `Original cambiado o protegido: ${original.path}`);
    }
    if (!present) {
      const old = p.inventory.entries.find((e) => e.path === original.path);
      if (!old) throw compactionError("CATALOG", "Falta el original inventariado");
      current.entries.push(old);
    }
  }
}

async function verifyCurrentSources(deps: CompactionDeps, manifest: CompactionManifest) {
  const p = manifest.proposal;
  const current = await inventoryHub(deps);
  normalizeOriginals(p, current);
  const view = await inside(deps.fs, deps.paths.hubDir(), VIEW_PATH);
  const hasView = await deps.fs.exists(view);
  const ownView =
    hasView &&
    (await deps.fs.stat(view)).size === Buffer.byteLength(p.view) &&
    (await deps.fs.readText(view)) === p.view;
  if (manifest.view_published || ownView) {
    if (!ownView) {
      throw compactionError(
        "STALE",
        "La vista publicada fue modificada; se conserva el cambio posterior",
      );
    }
    current.entries = current.entries.filter((e) => e.path !== VIEW_PATH);
    const priorView = p.inventory.entries.find((e) => e.path === VIEW_PATH);
    if (priorView) current.entries.push(priorView);
  }
  const order = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  const expected = semanticDigest({
    entries: [...p.inventory.entries].sort(order),
    relationships: p.inventory.relationships,
  });
  const actual = semanticDigest({
    entries: current.entries.sort(order),
    relationships: current.relationships,
  });
  if (expected !== actual)
    throw compactionError(
      "STALE",
      "Las fuentes relevantes cambiaron; la operación permanece recuperable",
    );
}

async function createManifest(
  deps: CompactionDeps,
  proposal: CompactionProposal,
): Promise<CompactionManifest> {
  const manifest: CompactionManifest = {
    version: 1,
    proposal,
    status: "preparing",
    view_published: false,
    entries: proposal.originals.map((o) => ({ path: o.path, state: "pending", compressed: null })),
    digest: "",
  };
  const root = await inside(deps.fs, deps.paths.hubDir(), proposal.catalog);
  await deps.fs.mkdirp(root);
  // The first durable record precedes every archive and every original mutation.
  await saveManifest(deps, manifest);
  const immutable = proposal.local.artifacts.find((a) => a.path.endsWith("/proposal.json"));
  if (!immutable) throw compactionError("CATALOG", "Falta la propuesta sellada");
  await deps.fs.publishTextExclusive(join(root, "proposal.json"), immutable.content);
  await deps.fs.mkdirp(join(root, "originals"));
  await deps.fs.mkdirp(join(root, "recovery"));
  return manifest;
}

async function stageOriginal(
  deps: CompactionDeps,
  manifest: CompactionManifest,
  original: SelectedOriginal,
  progress: ArchiveProgress,
) {
  if (progress.state !== "pending") return;
  const source = await inside(deps.fs, deps.paths.hubDir(), original.path);
  const archive = await inside(deps.fs, deps.paths.hubDir(), original.archive);
  assertIdentity(await deps.archive.identify(source), original);
  if (!(await deps.fs.exists(archive))) await deps.archive.compress(source, archive);
  await deps.archive.verify(archive, original);
  assertIdentity(await deps.archive.identify(source), original);
  progress.compressed = await deps.archive.identify(archive);
  progress.state = progress.compressed.bytes < original.bytes ? "staged" : "retained";
  await saveManifest(deps, manifest);
  if (progress.state === "retained") await deps.fs.remove(archive);
}

async function publishView(deps: CompactionDeps, manifest: CompactionManifest) {
  if (manifest.view_published) return;
  const p = manifest.proposal;
  const path = await inside(deps.fs, deps.paths.hubDir(), VIEW_PATH);
  const old = p.inventory.entries.find((e) => e.path === VIEW_PATH);
  // A crash after atomic publication but before its receipt is an identical retry.
  if (await deps.fs.exists(path)) {
    if ((await deps.fs.readText(path)) === p.view) {
      manifest.view_published = true;
      await saveManifest(deps, manifest);
      return;
    }
    if (!old || old.sha256 === null || old.bytes === null)
      throw compactionError("CONFLICT", "El destino de la vista ya está ocupado");
    assertIdentity(await deps.archive.identify(path), { bytes: old.bytes, sha256: old.sha256 });
    await deps.fs.writeText(path, p.view);
  } else {
    if (old) throw compactionError("STALE", "Desapareció la vista anterior");
    await deps.fs.mkdirp(dirname(path));
    if (!(await deps.fs.publishTextExclusive(path, p.view)).created)
      throw compactionError("CONFLICT", "El destino de la vista fue ocupado");
  }
  manifest.view_published = true;
  manifest.status = "published";
  await saveManifest(deps, manifest);
}

async function retireOriginal(
  deps: CompactionDeps,
  manifest: CompactionManifest,
  original: SelectedOriginal,
  progress: ArchiveProgress,
  index: number,
) {
  if (
    progress.state === "retained" ||
    progress.state === "archived" ||
    progress.state === "restored"
  )
    return;
  const source = await inside(deps.fs, deps.paths.hubDir(), original.path);
  const recovery = await inside(
    deps.fs,
    deps.paths.hubDir(),
    `${manifest.proposal.catalog}/recovery/${index}`,
  );
  const archive = await inside(deps.fs, deps.paths.hubDir(), original.archive);
  await deps.archive.verify(archive, original);
  if (!(await deps.fs.exists(recovery)) && (await deps.fs.exists(source))) {
    assertIdentity(await deps.archive.identify(source), original);
    await deps.fs.rename(source, recovery);
  }
  if (await deps.fs.exists(recovery)) {
    // A concurrently changed file stays in recovery, never discarded as the approved original.
    try {
      assertIdentity(await deps.archive.identify(recovery), original);
    } catch {
      throw compactionError(
        "CONFLICT",
        `Cambio concurrente conservado en ${recovery}; requiere recuperación explícita`,
      );
    }
    progress.state = "quarantined";
    await saveManifest(deps, manifest);
    if (await deps.fs.exists(source))
      throw compactionError(
        "CONFLICT",
        `Contenido posterior en ${original.path}; recuperación: ${recovery}`,
      );
    await deps.fs.remove(recovery);
  }
  progress.state = "archived";
  await saveManifest(deps, manifest);
}

export async function compactionResult(
  deps: CompactionDeps,
  manifest: CompactionManifest,
  alreadyApplied: boolean,
) {
  const catalogBytes = await storedBytes(
    deps.fs,
    await inside(deps.fs, deps.paths.hubDir(), manifest.proposal.catalog),
  );
  const removed = manifest.entries.filter((e) => e.state === "archived");
  const removedBytes = removed.reduce(
    (sum, e) => sum + (manifest.proposal.originals.find((o) => o.path === e.path)?.bytes ?? 0),
    0,
  );
  const priorView =
    manifest.proposal.inventory.entries.find((e) => e.path === VIEW_PATH)?.bytes ?? 0;
  const viewBytes = Buffer.byteLength(manifest.proposal.view);
  return {
    id: manifest.proposal.id,
    digest: manifest.proposal.local.digest,
    status: manifest.status,
    already_applied: alreadyApplied,
    entries: manifest.entries,
    view: VIEW_PATH,
    storage: {
      unit: "file-bytes",
      removed_bytes: removedBytes,
      catalog_bytes: catalogBytes,
      view_bytes: viewBytes,
      previous_view_bytes: priorView,
      net_saved_bytes: removedBytes - catalogBytes - viewBytes + priorView,
    },
    context: {
      view_bytes: viewBytes,
      source_bytes: manifest.proposal.inventory.context.bytes,
      tokens: null,
      reason: "Bytes medidos; no hay medición de tokens ni promesa de ahorro",
    },
  };
}

export async function applyCompaction(deps: CompactionDeps, value: unknown, approval: string) {
  if (!approval)
    throw compactionError("APPROVAL_REQUIRED", "Se requiere aprobar el digest de prepare");
  const request = parseCompactionInput(value);
  const id = compactionId(request);
  await inside(deps.fs, deps.paths.hubDir(), operationRelative(deps.paths, id));
  // A rejected first invocation cannot create even a lock or hub runtime.
  const existing = await readManifest(deps.fs, deps.paths, id);
  const initial = existing?.proposal ?? (await prepareCompaction(deps, request));
  if (initial.local.digest !== approval)
    throw compactionError("APPROVAL_REQUIRED", "El digest no aprueba esta propuesta exacta");
  await deps.fs.mkdirp(deps.paths.cwdRoot());
  const lock = await acquireLock(deps.paths.cwdLockFile(), deps.fs);
  try {
    const prior = await readManifest(deps.fs, deps.paths, id);
    const proposal = prior?.proposal ?? (await prepareCompaction(deps, request));
    if (proposal.local.digest !== approval)
      throw compactionError("STALE", "La propuesta cambió antes del bloqueo");
    if (prior?.status === "complete") {
      await verifyCompletedArchives(deps, prior);
      return await compactionResult(deps, prior, true);
    }
    const manifest = prior ?? (await createManifest(deps, proposal));
    return await resumeCompaction(deps, manifest);
  } finally {
    await lock.release();
  }
}

async function verifyCompletedArchives(deps: CompactionDeps, manifest: CompactionManifest) {
  for (const [index, original] of manifest.proposal.originals.entries()) {
    if (manifest.entries[index]?.state !== "archived") continue;
    await deps.archive.verify(
      await inside(deps.fs, deps.paths.hubDir(), original.archive),
      original,
    );
  }
}

async function resumeCompaction(deps: CompactionDeps, manifest: CompactionManifest) {
  const proposal = manifest.proposal;
  await verifyCurrentSources(deps, manifest);
  await deps.fs.mkdirp(await inside(deps.fs, deps.paths.hubDir(), `${proposal.catalog}/originals`));
  await deps.fs.mkdirp(await inside(deps.fs, deps.paths.hubDir(), `${proposal.catalog}/recovery`));
  for (const [index, original] of proposal.originals.entries()) {
    const progress = manifest.entries[index];
    if (!progress) throw compactionError("CATALOG", "Falta el progreso del original");
    await stageOriginal(deps, manifest, original, progress);
  }
  await verifyCurrentSources(deps, manifest);
  await publishView(deps, manifest);
  for (const [index, original] of proposal.originals.entries()) {
    const progress = manifest.entries[index];
    if (!progress) throw compactionError("CATALOG", "Falta el progreso del original");
    await retireOriginal(deps, manifest, original, progress, index);
  }
  manifest.status = "complete";
  await saveManifest(deps, manifest);
  return compactionResult(deps, manifest, false);
}
