import { ARTIFACT_PREFIX, isArtifactId } from "./identity.js";
import type { CatalogEntry, DesignCatalog, DesignManifest } from "./manifest.js";
import { NAMING, type NamedKind, revisionSegment } from "./naming.js";
import type { DesignFailure } from "./validation.js";

/**
 * Changing published normative content.
 *
 * The rule has one shape: you never edit a published revision, you mint the
 * next one. Everything else follows — the previous file keeps its name, every
 * reference to it keeps resolving, and `supersedes` records the succession
 * without rewriting what came before.
 *
 * This module answers the two questions that operation asks: *what is the next
 * revision and where does it go*, and afterwards *did anything published
 * disappear*. Writing the files is publication's job (F5); this is the arithmetic
 * and the proof.
 */

const KIND_LIST: Record<NamedKind, keyof DesignCatalog> = {
  flow: "flows",
  screen: "screens",
  rule: "rules",
  token: "tokens",
  rendition: "renditions",
};

export interface PlannedRevision {
  id: string;
  revision: number;
  /** Package-relative path the new revision must be written to. */
  path: string;
  /** `DES-001/FLW-001@r1`, or null when this is the first revision. */
  supersedes: string | null;
  /** Published paths this operation must leave byte-for-byte alone. */
  preserves: string[];
}

export type RevisionPlan =
  | { ok: true; value: PlannedRevision }
  | { ok: false; failure: DesignFailure };

/**
 * The next revision of `id`, or the first one when the artifact is new.
 * `slug` only shapes the file name; identity never derives from it.
 */
export function planNextRevision(
  manifest: DesignManifest,
  kind: NamedKind,
  id: string,
  slug: string,
  artifact: string,
): RevisionPlan {
  // The id shapes the PATH this function returns, so validating the cosmetic
  // slug and not the identity would let `../../evil` out of here as a path.
  if (!isArtifactId(id, kind)) {
    return {
      ok: false,
      failure: {
        code: "DESIGN_FIELD_INVALID",
        artifact,
        message: `'${id}' no es un id de ${kind}`,
        action: `usá ${ARTIFACT_PREFIX[kind]}-NNN`,
      },
    };
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    return {
      ok: false,
      failure: {
        code: "DESIGN_FIELD_INVALID",
        artifact,
        message: `'${slug}' no es un slug: solo minúsculas, números y guiones`,
        action: "usá algo como 'alta-miembro'",
      },
    };
  }

  const existing = (manifest.catalog[KIND_LIST[kind]] as CatalogEntry[]).filter((e) => e.id === id);
  const highest = existing.reduce((max, e) => Math.max(max, e.revision), 0);
  const revision = highest + 1;
  const rule = NAMING[kind];
  const path = `${rule.dir}/${id}-${revisionSegment(revision)}-${slug}${rule.suffix}`;

  // No collision check here on purpose: `revision` is always max+1 and the
  // revision is part of the path, so the new file CANNOT be one the catalog
  // already holds. The impossibility is structural — an `if` would only be
  // dead code pretending to be a safeguard.

  return {
    ok: true,
    value: {
      id,
      revision,
      path,
      supersedes: highest === 0 ? null : `${manifest.id}/${id}@r${highest}`,
      preserves: existing.map((e) => e.path).sort(),
    },
  };
}

export interface HistoryLoss {
  /** `DES-001/FLW-001@r1` or `DES-001@r2`. */
  ref: string;
  /** What happened: it vanished, moved, or its content changed under the same id. */
  kind: "removed" | "moved" | "rewritten";
  /** The field that changed, when the change is in place rather than in the path. */
  field?: string;
  before: string;
  after: string | null;
}

/**
 * What a publication lost, comparing the manifest before and after.
 *
 * A published revision may gain nothing and lose nothing: not its path, and —
 * for a baseline — not its digest. Anything else means a reference somebody
 * already wrote now resolves to different bytes, which is the one thing the
 * whole revision model exists to prevent.
 */
export function findHistoryLoss(before: DesignManifest, after: DesignManifest): HistoryLoss[] {
  return [
    ...artifactLosses(before, after),
    ...baselineLosses(before, after),
    ...addressedLosses(before, after),
  ];
}

/**
 * Assets and governance records are addressed by content and by id: an asset
 * that leaves the catalog breaks whatever depended on that digest, and a review
 * that changes its target changes what it approved.
 */
function artifactLosses(before: DesignManifest, after: DesignManifest): HistoryLoss[] {
  const losses: HistoryLoss[] = [];
  const current = publishedArtifacts(after);

  for (const [ref, entry] of publishedArtifacts(before)) {
    const now = current.get(ref);
    if (now === undefined) {
      losses.push({ ref, kind: "removed", before: entry.path, after: null });
      continue;
    }
    if (now.path !== entry.path) {
      losses.push({ ref, kind: "moved", before: entry.path, after: now.path });
    }
    // Promoting a published revision in place is a mutation of what someone
    // already pinned: `outline` and `handoff` mean different things to a gate,
    // so the promotion is the NEXT revision, never an edit of this one.
    for (const field of ["maturity", "supersedes"] as const) {
      const was = entry[field] ?? null;
      const is = now[field] ?? null;
      if (was === is) continue;
      losses.push({
        ref,
        kind: "rewritten",
        field,
        before: String(was),
        after: is === null ? null : String(is),
      });
    }
  }
  return losses;
}

function baselineLosses(before: DesignManifest, after: DesignManifest): HistoryLoss[] {
  const losses: HistoryLoss[] = [];
  // Changing a package's identity orphans every reference ever written to it —
  // the largest history loss there is, and the one nobody would think to look for.
  if (before.id !== after.id) {
    losses.push({
      ref: before.id,
      kind: "rewritten",
      field: "id",
      before: before.id,
      after: after.id,
    });
  }
  for (const baseline of before.baselines) {
    const ref = `${before.id}@r${baseline.revision}`;
    const now = after.baselines.find((b) => b.revision === baseline.revision);
    if (now === undefined) {
      losses.push({ ref, kind: "removed", before: baseline.path, after: null });
      continue;
    }
    if (now.path !== baseline.path) {
      losses.push({ ref, kind: "moved", before: baseline.path, after: now.path });
    }
    if (now.digest !== baseline.digest) {
      losses.push({ ref, kind: "rewritten", before: baseline.digest, after: now.digest });
    }
  }
  return losses;
}

function addressedLosses(before: DesignManifest, after: DesignManifest): HistoryLoss[] {
  return [...assetLosses(before, after), ...governanceLosses(before, after)];
}

/** An asset that leaves the catalog breaks whatever depended on that digest. */
function assetLosses(before: DesignManifest, after: DesignManifest): HistoryLoss[] {
  const losses: HistoryLoss[] = [];
  for (const asset of before.catalog.assets) {
    const now = after.catalog.assets.find((a) => a.digest === asset.digest);
    if (now === undefined) {
      losses.push({ ref: asset.digest, kind: "removed", before: asset.path, after: null });
    } else if (now.path !== asset.path) {
      losses.push({ ref: asset.digest, kind: "moved", before: asset.path, after: now.path });
    }
  }
  return losses;
}

/** A review that changes its target changes what it approved. */
function governanceLosses(before: DesignManifest, after: DesignManifest): HistoryLoss[] {
  const losses: HistoryLoss[] = [];
  for (const key of ["reviews", "revocations"] as const) {
    for (const record of before.governance[key]) {
      const now = after.governance[key].find((g) => g.id === record.id);
      if (now === undefined) {
        losses.push({ ref: record.id, kind: "removed", before: record.path, after: null });
        continue;
      }
      for (const field of ["digest", "target"] as const) {
        if (now[field] === record[field]) continue;
        losses.push({
          ref: record.id,
          kind: "rewritten",
          field,
          before: record[field],
          after: now[field],
        });
      }
    }
  }
  return losses;
}

/** Turn a loss into the diagnostic a publication should refuse with. */
export function historyLossFailure(loss: HistoryLoss, artifact: string): DesignFailure {
  const what = loss.field ?? "digest";
  const message = {
    removed: `${loss.ref} estaba publicada y ya no está en el catálogo`,
    moved: `${loss.ref} cambió de path: '${loss.before}' → '${loss.after}'`,
    rewritten: `${loss.ref} cambió de ${what}: '${loss.before}' → '${String(loss.after)}'`,
  }[loss.kind];
  return {
    code: "DESIGN_HISTORY_MUTATED",
    artifact,
    message,
    action: "una revisión publicada no se toca: creá la siguiente y dejá la anterior como está",
  };
}

function publishedArtifacts(manifest: DesignManifest): Map<string, CatalogEntry> {
  const out = new Map<string, CatalogEntry>();
  for (const key of Object.values(KIND_LIST)) {
    for (const entry of manifest.catalog[key] as CatalogEntry[]) {
      out.set(`${manifest.id}/${entry.id}@r${entry.revision}`, entry);
    }
  }
  return out;
}
