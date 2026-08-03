import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DesignFailure, DesignManifest } from "../../domain/design/manifest.js";
import {
  type ProposalReview,
  type ProposedDocument,
  reviewExternalProposal,
} from "../../domain/design/proposal.js";
import { validateRenderBundle } from "../../domain/design/render-bundle.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { readDesignIndex } from "./design-index-service.js";

/**
 * Taking an external result back: read, judge, report. Never write.
 *
 * The one place a proposal meets the filesystem, and the mirror of
 * `design-bundle-service`: cutting a bundle only reads, and so does this. That is
 * not a coincidence — a return path that could write is the silent overwrite the
 * whole phase exists to prevent, so the capability is absent rather than guarded.
 *
 * The bundle that comes back is untrusted by definition: it crossed a tool
 * boundary and may have been edited, truncated or hand-written. So it goes through
 * the full validator, seal included, before a single comparison is made — a
 * proposal anchored to a bundle nobody checked is anchored to nothing.
 */

export interface ReviewProposalInput {
  packageId: string;
  /** The bundle the tool was handed, as it came back — parsed but not trusted. */
  base: unknown;
  /** The edited documents. Their paths must be the ones the bundle handed out. */
  documents: readonly ProposedDocument[];
}

export type ReviewProposalResult =
  | { ok: true; value: ProposalReview }
  | { ok: false; failures: DesignFailure[] };

export async function reviewProposal(
  fs: FileSystemPort,
  workspace: string,
  input: ReviewProposalInput,
): Promise<ReviewProposalResult> {
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
          action: "una propuesta se reconcilia contra un package que resuelve",
        },
      ],
    };
  }
  const manifest = entry.manifest;

  const bundle = validateRenderBundle(input.base, `${entry.path}/render-bundle.json`);
  if (!bundle.ok || bundle.value === null) return { ok: false, failures: bundle.failures };
  if (bundle.value.package !== manifest.id) {
    return {
      ok: false,
      failures: [
        {
          code: "DESIGN_AUTHORITY_CONFLICT",
          artifact: `${entry.path}/render-bundle.json`,
          message: `la propuesta trae un bundle de ${bundle.value.package} y el package es ${manifest.id}`,
          action: "reconciliá la propuesta contra el package del que salió su bundle",
        },
      ],
    };
  }

  // El estado ACTUAL del package, leído del disco: es la mitad que la propuesta no
  // puede aportar, y la única forma de saber si la base se movió.
  const current = new Map<string, string>();
  const currentText = new Map<string, string>();
  for (const member of bundle.value.closure) {
    const absolute = join(workspace, entry.path, member.path);
    if (!(await fs.exists(absolute))) continue;
    current.set(member.ref, digestOf(await fs.readBytes(absolute)));
    if (isDocument(manifest, member.path)) {
      currentText.set(member.path, await fs.readText(absolute));
    }
  }

  return {
    ok: true,
    value: reviewExternalProposal({
      base: bundle.value,
      documents: input.documents,
      current,
      currentText,
    }),
  };
}

/** A flow or a screen — the two kinds whose delta can be read semantically. */
function isDocument(manifest: DesignManifest, path: string): boolean {
  return [...manifest.catalog.flows, ...manifest.catalog.screens].some((e) => e.path === path);
}

function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
