import { join } from "node:path";
import type { AdapterProfile } from "../../domain/design/adapter.js";
import { bundleAdapterOf, declaredLosses } from "../../domain/design/adapter.js";
import { type DesignArtifact, validateDesignArtifact } from "../../domain/design/artifact.js";
import { type ClosureMember, computeClosure } from "../../domain/design/closure.js";
import { parseArtifactRef } from "../../domain/design/identity.js";
import type { DesignFailure, DesignManifest } from "../../domain/design/manifest.js";
import { gateDesignDocument } from "../../domain/design/maturity.js";
import {
  type BundleObligation,
  type DataClassification,
  type RenderBundle,
  buildRenderBundle,
} from "../../domain/design/render-bundle.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { readDesignIndex } from "./design-index-service.js";

/**
 * Cutting a Render Context Bundle from a package that is on disk.
 *
 * Everything semantic already exists: the closure walks the graph, the maturity
 * gate reads the obligations a document states, the adapter declares what it can
 * do. This service is the assembly — and, deliberately, the ONLY place that reads
 * the filesystem for a bundle. The domain builder receives bytes through a reader
 * and has no way to write at all, which is how "the bundle never modifies the
 * canonical authority" is a property of the code rather than a promise in a
 * comment.
 */

export interface CutBundleInput {
  packageId: string;
  /** The selection: exact references, anchors allowed. */
  roots: string[];
  adapter: AdapterProfile;
  /** Defaults to `synthetic`: real material is an authorization, not a default. */
  dataClassification?: DataClassification;
  /** YYYY-MM-DD, passed in: no layer of this reads the clock. */
  generated: string;
}

export type CutBundleResult =
  | { ok: true; value: RenderBundle }
  | { ok: false; failures: DesignFailure[] };

export async function cutRenderBundle(
  fs: FileSystemPort,
  workspace: string,
  input: CutBundleInput,
): Promise<CutBundleResult> {
  const index = await readDesignIndex(fs, workspace);
  const entry = index.packages.find((p) => p.id === input.packageId);
  if (entry === undefined || entry.manifest === null) {
    return {
      ok: false,
      failures: [
        {
          code: "DESIGN_REFERENCE_MISSING",
          artifact: index.root,
          message: `no hay un package ${input.packageId} con manifest válido bajo ${index.root}/`,
          action: "revisá 'aw designs --detail': un bundle se corta de un package que resuelve",
        },
      ],
    };
  }
  const manifest = entry.manifest;
  const baseline = manifest.current_baseline;
  if (baseline === null) {
    return {
      ok: false,
      failures: [
        {
          code: "DESIGN_BASE_STALE",
          artifact: entry.manifest_path,
          message: `${manifest.id} no tiene ninguna revisión publicada`,
          action: "publicá una revisión: un bundle entrega bytes sellados, no un borrador",
        },
      ],
    };
  }

  const content = await readPackage(fs, workspace, entry.path, manifest);
  const closure = computeClosure(
    manifest,
    input.roots,
    (path) => content.documents.get(path) ?? null,
  );

  return buildRenderBundle({
    manifest,
    baseline: { revision: baseline.revision, digest: baseline.digest },
    adapter: bundleAdapterOf(input.adapter),
    roots: input.roots,
    closure,
    readBytes: (path) => content.bytes.get(path) ?? null,
    accessibility: accessibilityOf(manifest, closure.members, content.texts),
    losses: declaredLosses(input.adapter),
    dataClassification: input.dataClassification ?? "synthetic",
    generated: input.generated,
  });
}

/**
 * What the accessibility half of the bundle carries.
 *
 * Read off the SAME gate the maturity profile uses, never re-derived here: an
 * obligation is what a document demands and an implementation owes, and having
 * two places decide what counts as one is how they start disagreeing. A section
 * the document waived is not an obligation — the gate already knows that.
 */
function accessibilityOf(
  manifest: DesignManifest,
  members: readonly ClosureMember[],
  texts: Map<string, string>,
): BundleObligation[] {
  const out: BundleObligation[] = [];
  for (const member of members) {
    if (member.kind !== "screen" && member.kind !== "flow") continue;
    const path = pathOf(manifest, member.ref);
    const text = path === null ? undefined : texts.get(path);
    if (path === null || text === undefined) continue;
    for (const obligation of gateDesignDocument(text, member.kind, path).obligations) {
      if (obligation.key !== "accessibility") continue;
      out.push({ ref: member.ref, statement: obligation.statement });
    }
  }
  return out;
}

/** The catalog path of a `DES-001/SCR-001@r2` reference. */
function pathOf(manifest: DesignManifest, ref: string): string | null {
  const parsed = parseArtifactRef(ref);
  if (parsed === null) return null;
  for (const key of ["flows", "screens", "rules", "tokens", "renditions"] as const) {
    const hit = manifest.catalog[key].find(
      (e) => e.id === parsed.artifact && e.revision === parsed.revision,
    );
    if (hit !== undefined) return hit.path;
  }
  return null;
}

interface PackageContent {
  /** Bytes of every catalogued file, for the digests the bundle seals. */
  bytes: Map<string, Uint8Array>;
  /** Text of the flow and screen documents, for the gate that reads obligations. */
  texts: Map<string, string>;
  documents: Map<string, DesignArtifact>;
}

/**
 * One pass over the package. The closure walks synchronously and cannot await
 * mid-traversal, so everything it may reach is read up front — and read ONCE, or
 * a package with thirteen screens would be re-read per root.
 */
async function readPackage(
  fs: FileSystemPort,
  workspace: string,
  packagePath: string,
  manifest: DesignManifest,
): Promise<PackageContent> {
  const content: PackageContent = { bytes: new Map(), texts: new Map(), documents: new Map() };
  const root = join(workspace, packagePath);

  const DOC_KIND = { flows: "flow", screens: "screen" } as const;
  for (const key of ["flows", "screens", "rules", "tokens", "renditions"] as const) {
    for (const catalogued of manifest.catalog[key]) {
      await readOne(fs, root, catalogued.path, DOC_KIND[key as "flows" | "screens"], content);
    }
  }
  for (const asset of manifest.catalog.assets) {
    await readOne(fs, root, asset.path, undefined, content);
  }
  return content;
}

/** One catalogued file: bytes always, text and a parse only for a document kind. */
async function readOne(
  fs: FileSystemPort,
  root: string,
  path: string,
  kind: "flow" | "screen" | undefined,
  into: PackageContent,
): Promise<void> {
  const absolute = join(root, path);
  if (!(await fs.exists(absolute))) return;
  into.bytes.set(path, await fs.readBytes(absolute));
  if (kind === undefined) return;
  const text = await fs.readText(absolute);
  into.texts.set(path, text);
  const parsed = validateDesignArtifact(text, kind, path);
  if (parsed.ok && parsed.value !== null) into.documents.set(path, parsed.value);
}
