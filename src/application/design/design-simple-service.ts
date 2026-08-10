/**
 * The simple route: from a title and one authored document to a published design.
 *
 * Everything a package administers — the identity, the folder, the revision, the
 * digest, the manifest, the archive of the outgoing revision — is derived HERE,
 * from facts the CLI already holds. That is the whole content of "el host no
 * administra manifests, IDs, revisiones ni madurez": not a rule somebody follows,
 * but a surface that never asks.
 *
 * Two moments, and they are deliberately apart. {@link resolveSimpleTarget} runs
 * BEFORE anything is authored: it fixes where the document will land so the
 * destination can travel in the request as an allowlist, which is what keeps the
 * write boundary a property of the protocol. {@link buildSimpleProposal} runs
 * after, over the bytes that came back, and produces the complete set of files
 * one approval covers.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  DESIGNS_DIR,
  DESIGN_MANIFEST_FILE,
  DESIGN_MANIFEST_SCHEMA_ID,
  type DesignFailure,
  type DesignManifest,
} from "../../domain/design/manifest.js";
import {
  SIMPLE_DESIGN_FILE,
  archivedDesignPath,
  designFolder,
  designSlug,
  nextPackageId,
  validateSimpleDesign,
} from "../../domain/design/simple.js";
import type { ProposalArtifact, ProposalBase } from "../../domain/proposal.js";
import { baseDigest } from "../../domain/proposal.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { DesignIndex } from "./design-index-service.js";

/** Where a simple design is about to be written, and under which identity. */
export interface SimpleTarget {
  packageId: string;
  /** Workspace-relative package folder. */
  path: string;
  /** The revision this publication will mint: 1 for a new design. */
  revision: number;
  /** The revision currently in force, or null for a design that never published. */
  supersedes: number | null;
  /** The existing manifest, when this continues a package. */
  manifest: DesignManifest | null;
}

export type SimpleResolution =
  | { ok: true; value: SimpleTarget }
  | { ok: false; failure: DesignFailure };

/**
 * The identity and the destination, decided before a single byte is authored.
 *
 * `create` mints; `update` continues. The two are one route with a different
 * compare-and-swap base, exactly as the capability contract says — so the only
 * thing that differs here is where the folder comes from.
 */
export function resolveSimpleTarget(
  index: DesignIndex,
  operation: string,
  inputs: { title: string | null; packageId: string | null },
): SimpleResolution {
  if (operation === "create") {
    const title = inputs.title ?? "";
    if (title.trim().length === 0) {
      return {
        ok: false,
        failure: {
          code: "DESIGN_FIELD_INVALID",
          artifact: DESIGNS_DIR,
          message: "un diseño nuevo necesita un título",
          action: "pasá 'title' con el nombre humano del diseño: de ahí salen la carpeta y el id",
        },
      };
    }
    const packageId = nextPackageId(index.packages.map((p) => p.id ?? p.declared_id));
    return {
      ok: true,
      value: {
        packageId,
        path: designFolder(index.root, packageId, designSlug(title)),
        revision: 1,
        supersedes: null,
        manifest: null,
      },
    };
  }

  const id = (inputs.packageId ?? "").trim();
  if (id.length === 0) {
    return {
      ok: false,
      failure: {
        code: "DESIGN_FIELD_INVALID",
        artifact: DESIGNS_DIR,
        message: "actualizar un diseño necesita la identidad del que se continúa",
        action: "pasá 'package' con su id, por ejemplo DES-007",
      },
    };
  }
  const found = index.packages.find((p) => p.id === id) ?? null;
  if (found === null || found.manifest === null) {
    return {
      ok: false,
      failure: {
        code: "DESIGN_PACKAGE_NOT_FOUND",
        artifact: DESIGNS_DIR,
        message: `no hay ningún diseño ${id} legible bajo ${index.root}/`,
        action: `revisá 'aw designs' para ver las identidades publicadas bajo ${index.root}/`,
      },
    };
  }
  if (found.mode !== "simple") {
    return {
      ok: false,
      failure: {
        code: "DESIGN_FIELD_INVALID",
        artifact: found.manifest_path,
        message: `${id} es un package completo, no un diseño simple`,
        action:
          "actualizalo por la ruta ampliada: reducirlo a un documento descartaría sus flows, screens y madurez",
      },
    };
  }
  const current = found.manifest.current_baseline?.revision ?? 0;
  return {
    ok: true,
    value: {
      packageId: id,
      path: found.path,
      revision: current + 1,
      supersedes: current === 0 ? null : current,
      manifest: found.manifest,
    },
  };
}

export interface SimpleProposalInput {
  target: SimpleTarget;
  /** The authored `DESIGN.md`, exactly as it came back. */
  document: string;
  /** Publication date. Passed in: this layer never reads the clock. */
  published: string;
}

export interface SimpleProposal {
  artifacts: ProposalArtifact[];
  /** The manifest this revision was computed from, for the compare-and-swap. */
  base: ProposalBase | null;
  /** The digest the reference of this revision will pin. */
  digest: string;
  revision: number;
  packageId: string;
  title: string;
}

export type SimpleProposalResult =
  | { ok: true; value: SimpleProposal }
  | { ok: false; failures: DesignFailure[] };

/**
 * Every file one approval covers, from the one document a person wrote.
 *
 * The archive is the reason this is a SET and not a single write. A published
 * revision pins exact bytes, so overwriting `DESIGN.md` with r2 would silently
 * take r1 away from everything that referenced it. Copying the outgoing bytes to
 * `revisions/DESIGN-r00N.md` inside the same sealed proposal is what keeps the
 * readable current document AND the history the references need — and doing it
 * in the same proposal is what keeps it from being a second, unapproved step.
 */
export async function buildSimpleProposal(
  fs: FileSystemPort,
  workspace: string,
  input: SimpleProposalInput,
): Promise<SimpleProposalResult> {
  const { target } = input;
  const documentPath = `${target.path}/${SIMPLE_DESIGN_FILE}`;

  const parsed = validateSimpleDesign(input.document, documentPath);
  if (!parsed.ok || parsed.value === null) return { ok: false, failures: parsed.failures };

  const digest = `sha256:${createHash("sha256").update(input.document, "utf8").digest("hex")}`;
  const artifacts: ProposalArtifact[] = [];

  // The outgoing revision first: it has to exist at its archived path before the
  // manifest starts saying that is where it lives.
  if (target.supersedes !== null && target.manifest !== null) {
    const previousAbs = join(workspace, documentPath);
    if (!(await fs.exists(previousAbs))) {
      return {
        ok: false,
        failures: [
          {
            code: "DESIGN_REFERENCE_FILE_MISSING",
            artifact: documentPath,
            message: `el manifest de ${target.packageId} dice que r${target.supersedes} vive en '${documentPath}' y ese archivo no está`,
            action: "restauralo antes de publicar la revisión siguiente: sin él se perdería",
          },
        ],
      };
    }
    artifacts.push({
      path: `${target.path}/${archivedDesignPath(target.supersedes)}`,
      content: await fs.readText(previousAbs),
      overwrite: false,
    });
  }

  artifacts.push({
    path: documentPath,
    content: input.document,
    overwrite: target.supersedes !== null,
  });

  const manifest = nextManifest(target, parsed.value.title, digest, input.published);
  artifacts.push({
    path: `${target.path}/${DESIGN_MANIFEST_FILE}`,
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    overwrite: target.manifest !== null,
  });

  return {
    ok: true,
    value: {
      artifacts,
      base: await manifestBase(fs, workspace, target),
      digest,
      revision: target.revision,
      packageId: target.packageId,
      title: parsed.value.title,
    },
  };
}

/**
 * The manifest after this publication.
 *
 * Every baseline already published keeps its digest and only moves its `path` to
 * the archive: the digest is the identity of a revision and the path is where it
 * happens to be, so repointing one is a re-index and never a rewrite of history.
 */
function nextManifest(
  target: SimpleTarget,
  title: string,
  digest: string,
  published: string,
): DesignManifest {
  const previous = target.manifest;
  const baselines = (previous?.baselines ?? []).map((b) => ({
    ...b,
    path: archivedDesignPath(b.revision),
  }));
  baselines.push({
    revision: target.revision,
    path: SIMPLE_DESIGN_FILE,
    digest,
    parent_baseline:
      target.supersedes === null ? null : `${target.packageId}@r${target.supersedes}`,
    published,
  });

  return {
    schema: previous?.schema ?? DESIGN_MANIFEST_SCHEMA_ID,
    id: target.packageId,
    mode: "simple",
    title,
    created: previous?.created ?? published,
    derived_from: previous?.derived_from ?? null,
    current_baseline: { revision: target.revision, path: SIMPLE_DESIGN_FILE, digest },
    baselines,
    catalog: { flows: [], screens: [], rules: [], tokens: [], renditions: [], assets: [] },
    currentness: [],
    governance: previous?.governance ?? { reviews: [], revocations: [] },
    relations: previous?.relations ?? { specs: [], plans: [] },
  };
}

/**
 * The compare-and-swap base: the manifest as it stood when this was computed.
 *
 * Null for a brand-new design — there is nothing to have moved. The publication
 * of a first revision is protected by its destinations not existing, which
 * `applyLocalProposal` enforces through `overwrite: false`.
 */
async function manifestBase(
  fs: FileSystemPort,
  workspace: string,
  target: SimpleTarget,
): Promise<ProposalBase | null> {
  if (target.manifest === null) return null;
  const path = `${target.path}/${DESIGN_MANIFEST_FILE}`;
  const absolute = join(workspace, path);
  if (!(await fs.exists(absolute))) return null;
  return { path, digest: baseDigest(await fs.readText(absolute)) };
}
