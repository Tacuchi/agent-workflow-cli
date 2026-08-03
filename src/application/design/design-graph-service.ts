import { join } from "node:path";
import {
  type SpecDesignReference,
  parseSpecDesignReferences,
  parseTaskDesignReferences,
} from "../../domain/design/reference.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { type DesignIndex, readDesignIndex } from "./design-index-service.js";
import { resolveBaselineReference } from "./design-resolver-service.js";

/**
 * The traceability graph `status` and `resume` project (AC-FLW-06).
 *
 * `spec → package → flow/screen → plan/task`, in the only direction that can be
 * computed from the documents: each spec and plan says which baseline it pinned,
 * and the package says where it lives now. The graph exists so nobody has to
 * open files to learn that a reference went bad — which is exactly the failure
 * a design that lives outside the document introduces.
 *
 * Four states, and they are four different problems:
 * - `valid` — resolves, and the hint still points at the baseline.
 * - `stale` — resolves by identity; the recorded path moved. Repairable, not broken.
 * - `missing` — does not resolve: unpublished, revised away, or digest changed.
 * - `orphaned` — a package under `docs/designs/` that no document references.
 */

export type DesignRefState = "valid" | "stale" | "missing";

export interface DesignGraphReference {
  /** Workspace-relative document that pins it. */
  from: string;
  kind: "spec" | "plan";
  /** `DES-001@r4`. */
  baseline: string;
  state: DesignRefState;
  /** Where the package lives RIGHT NOW; null when nothing resolved. */
  package_path: string | null;
  /** Why it is stale or missing, with its corrective action. Null when valid. */
  detail: string | null;
  /** The exact artifact roots this document's phases or tasks pin. */
  roots: string[];
}

export interface DesignGraphPackage {
  id: string | null;
  path: string;
  current_revision: number | null;
  /** `orphaned` = under `docs/designs/` and nothing references it. */
  state: "referenced" | "orphaned";
  ok: boolean;
}

export interface DesignGraph {
  root: string;
  packages: DesignGraphPackage[];
  references: DesignGraphReference[];
  counts: { valid: number; stale: number; missing: number; orphaned: number };
}

export interface GraphDocument {
  file: string;
  kind: "spec" | "plan";
}

export const EMPTY_DESIGN_GRAPH: DesignGraph = {
  root: "docs/designs",
  packages: [],
  references: [],
  counts: { valid: 0, stale: 0, missing: 0, orphaned: 0 },
};

/**
 * Never throws on a reachable workspace: a document that cannot be read
 * contributes no references rather than tanking the whole dashboard — the same
 * degradation rule the index it feeds already follows.
 */
export async function buildDesignGraph(
  fs: FileSystemPort,
  workspace: string,
  documents: readonly GraphDocument[],
): Promise<DesignGraph> {
  const index = await readDesignIndex(fs, workspace);
  if (index.packages.length === 0 && documents.length === 0) return EMPTY_DESIGN_GRAPH;

  const references: DesignGraphReference[] = [];
  for (const document of documents) {
    let text: string;
    try {
      text = await fs.readText(join(workspace, document.file));
    } catch {
      continue;
    }
    const declared = parseSpecDesignReferences(text, document.file);
    if (declared.references.length === 0) continue;
    const roots = parseTaskDesignReferences(text, document.file).references.map((r) => r.raw);
    for (const reference of declared.references) {
      references.push(edge(index, document, reference, roots));
    }
  }

  const packages = statedPackages(index, references);
  return {
    root: index.root,
    packages,
    references,
    counts: {
      valid: references.filter((r) => r.state === "valid").length,
      stale: references.filter((r) => r.state === "stale").length,
      missing: references.filter((r) => r.state === "missing").length,
      orphaned: packages.filter((p) => p.state === "orphaned").length,
    },
  };
}

/** One `document → baseline` edge, with the state that resolution gave it. */
function edge(
  index: DesignIndex,
  document: GraphDocument,
  reference: SpecDesignReference,
  roots: readonly string[],
): DesignGraphReference {
  const resolved = resolveBaselineReference(index, reference, document.file);
  return {
    from: document.file,
    kind: document.kind,
    baseline: `${reference.baseline.package}@r${reference.baseline.revision}`,
    roots: roots.filter((raw) => raw.startsWith(`${reference.baseline.package}@`)),
    ...(resolved.ok
      ? {
          state: resolved.value.hint,
          package_path: resolved.value.package_path,
          detail:
            resolved.value.hint === "stale"
              ? `el hint apunta a '${resolved.value.declared_hint}' y hoy vive en '${resolved.value.path}'`
              : null,
        }
      : {
          state: "missing" as const,
          package_path: null,
          detail: `${resolved.failure.message} → ${resolved.failure.action}`,
        }),
  };
}

function statedPackages(
  index: DesignIndex,
  references: readonly DesignGraphReference[],
): DesignGraphPackage[] {
  // A package is referenced when some document resolved AGAINST it — by
  // identity, not by path: a stale hint still means somebody depends on it.
  const referenced = new Set(
    references.filter((r) => r.state !== "missing").map((r) => r.baseline.split("@")[0]),
  );
  return index.packages.map((pkg) => ({
    id: pkg.id,
    path: pkg.path,
    current_revision: pkg.current_baseline?.revision ?? null,
    state: pkg.id !== null && referenced.has(pkg.id) ? "referenced" : "orphaned",
    ok: pkg.ok,
  }));
}
