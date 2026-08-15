import { join } from "node:path";
import type { DesignDocKind } from "../../domain/design/artifact-body.js";
import { type ScreenArtifact, validateDesignArtifact } from "../../domain/design/artifact.js";
import type { CatalogEntry, DesignFailure, DesignManifest } from "../../domain/design/manifest.js";
import { gateDesignDocument } from "../../domain/design/maturity.js";
import { type DesignRendition, validateDesignRendition } from "../../domain/design/rendition.js";
import { crossVisualEvidence } from "../../domain/design/visual-evidence.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { DesignPackageEntry } from "./design-index-service.js";

/**
 * The content gate over an ALREADY published package.
 *
 * `readDesignIndex` answers the structural question — the manifest reads, the
 * baseline line holds together. It says nothing about what the cataloged
 * documents CLAIM: a package sealed through a path that never ran the gates
 * reads `ok: true` while its current flow and screen revisions violate the
 * maturity contract (`gateDesignDocument`) or cite visual evidence that does
 * not hold (`crossVisualEvidence`). This service is the answer `aw designs`
 * owes to "is my package fine?".
 *
 * Only CURRENT revisions are judged. A superseded one was gated by whatever
 * ruled when it was published and is immutable history now — re-judging it
 * would report a problem nobody can act on. The manifest's `currentness`
 * decides which revision is current; where it is empty or contradictory for an
 * artifact, the highest cataloged revision stands in, which is the same answer
 * a correct currentness derives.
 */
export async function gatePackageContent(
  fs: FileSystemPort,
  workspace: string,
  entry: DesignPackageEntry,
): Promise<DesignFailure[]> {
  // A package with no readable manifest is already reported by the index: the
  // structural diagnosis is its own, and there is no catalog to gate here.
  if (entry.manifest === null) return [];
  const manifest = entry.manifest;

  const flows = currentEntries(manifest, "flows");
  const screens = currentEntries(manifest, "screens");
  const documents = await readDocuments(fs, workspace, entry.path, [...flows, ...screens]);
  const renditions = await readRenditions(fs, workspace, entry.path, manifest.catalog.renditions);

  const failures: DesignFailure[] = [];
  for (const catalogEntry of flows) {
    failures.push(...gateDocument(documents, catalogEntry, "flow", entry.path));
  }
  for (const catalogEntry of screens) {
    failures.push(...gateDocument(documents, catalogEntry, "screen", entry.path));
    failures.push(
      ...crossScreenEvidence(documents, catalogEntry, entry.path, manifest, renditions),
    );
  }
  return failures;
}

/**
 * The revision of each artifact the gate answers for: the one `currentness`
 * declares current, or — when no revision or several are declared — the
 * highest cataloged one, the same answer a correct currentness derives.
 *
 * Exported because the maturity ceiling asks the identical question, and the
 * two answers have to be one. Filtering the catalog by the entries `currentness`
 * MARKS drops every artifact it does not enumerate — legal, and what
 * `manifest-maximal.json` does with its screen — so a second implementation of
 * "which revision is current" reported `handoff` over a package holding an
 * `outline` one. Note the shape this guarantees: exactly one entry per
 * catalogued id, so an empty result means an empty catalog and nothing else.
 */
export function currentEntries(manifest: DesignManifest, key: "flows" | "screens"): CatalogEntry[] {
  const declared = new Map(manifest.currentness.map((c) => [c.ref, c.state]));
  const byId = new Map<string, CatalogEntry[]>();
  for (const entry of manifest.catalog[key]) {
    byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
  }
  const out: CatalogEntry[] = [];
  for (const revisions of byId.values()) {
    const marked = revisions.filter(
      (e) => declared.get(`${manifest.id}/${e.id}@r${e.revision}`) === "current",
    );
    const only = marked.length === 1 ? marked[0] : undefined;
    out.push(only ?? revisions.reduce((a, b) => (b.revision > a.revision ? b : a)));
  }
  return out;
}

/** The document gate over one current revision, or the missing-file diagnosis. */
function gateDocument(
  documents: ReadonlyMap<string, string>,
  entry: CatalogEntry,
  kind: DesignDocKind,
  packagePath: string,
): DesignFailure[] {
  const text = documents.get(entry.path);
  if (text === undefined) return [missingFile(entry.path, packagePath)];
  return gateDesignDocument(text, kind, `${packagePath}/${entry.path}`).failures;
}

/**
 * The other half of a screen's `handoff` claim: whether the renditions it
 * cites actually show what it says they show. Runs only when the document
 * validates — an invalid one was already reported by the document gate, and
 * its classification matrix could not be read either.
 */
function crossScreenEvidence(
  documents: ReadonlyMap<string, string>,
  entry: CatalogEntry,
  packagePath: string,
  manifest: DesignManifest,
  renditions: ReadonlyMap<string, DesignRendition>,
): DesignFailure[] {
  const text = documents.get(entry.path);
  if (text === undefined) return [];
  const path = `${packagePath}/${entry.path}`;
  const parsed = validateDesignArtifact(text, "screen", path);
  if (!parsed.ok || parsed.value === null) return [];
  return crossVisualEvidence(
    manifest.catalog.renditions,
    parsed.value as ScreenArtifact,
    path,
    (p) => renditions.get(p) ?? null,
  );
}

/**
 * One read pass over the documents being judged: the gates ask their questions
 * per artifact, and reading per question would read the package once per
 * answer.
 */
async function readDocuments(
  fs: FileSystemPort,
  workspace: string,
  packagePath: string,
  entries: readonly CatalogEntry[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of entries) {
    const absolute = join(workspace, packagePath, entry.path);
    if (await fs.exists(absolute)) out.set(entry.path, await fs.readText(absolute));
  }
  return out;
}

/**
 * Every cataloged rendition, pre-read and validated: the evidence cross takes
 * a SYNCHRONOUS reader and cannot await mid-walk. An unreadable or invalid one
 * is simply absent — a citation of it then reports as dangling, which is what
 * it is.
 */
async function readRenditions(
  fs: FileSystemPort,
  workspace: string,
  packagePath: string,
  entries: readonly CatalogEntry[],
): Promise<Map<string, DesignRendition>> {
  const out = new Map<string, DesignRendition>();
  for (const entry of entries) {
    const absolute = join(workspace, packagePath, entry.path);
    if (!(await fs.exists(absolute))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readText(absolute));
    } catch {
      continue;
    }
    const validation = validateDesignRendition(parsed, entry.path);
    if (validation.ok && validation.value !== null) out.set(entry.path, validation.value);
  }
  return out;
}

/** The same diagnosis the publish path gives: the catalog names bytes that are not there. */
function missingFile(path: string, packagePath: string): DesignFailure {
  return {
    code: "DESIGN_REFERENCE_FILE_MISSING",
    artifact: `${packagePath}/${path}`,
    message: `el catálogo declara '${path}' y el archivo no está`,
    action: "restauralo o quitalo del catálogo: un baseline sella bytes que existen",
  };
}
