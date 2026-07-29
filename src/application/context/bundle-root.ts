import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import { resolveBundledSkillPath } from "../self/install-skill.js";
import { MANIFEST_REL_PATH } from "./manifest.js";

/** Which tree a measurement or a receipt actually read. */
export type BundleRootOrigin = "explicit" | "packaged";

export interface ResolvedBundleRoot {
  root: string;
  origin: BundleRootOrigin;
}

export class BundleRootError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BundleRootError";
  }
}

/**
 * The bundle a context command measures.
 *
 * `--root <path>` points at any tree — a repo checkout for the CI gate, or the
 * tree a host actually installed. With no flag the answer is the PACKAGED
 * bundle, which is the same tree `self install` copies out, so the default is
 * both deterministic and the honest proxy for an installation of this version.
 *
 * Detecting which host is installed where is deliberately NOT done here: that
 * is spec 010's surface, and guessing it would make the receipt's `root` depend
 * on a heuristic instead of on what the caller asked for.
 */
export async function resolveBundleRoot(
  fs: FileSystemPort,
  explicitRoot?: string,
): Promise<ResolvedBundleRoot> {
  if (explicitRoot !== undefined) {
    await assertBundle(fs, explicitRoot, "explicit");
    return { root: explicitRoot, origin: "explicit" };
  }
  const packaged = await resolveBundledSkillPath();
  if (packaged === null) {
    throw new BundleRootError(
      "CONTEXT_ROOT_NOT_FOUND",
      "No se encontró el bundle empaquetado junto a la CLI. Pasá --root <path> con el árbol a medir.",
    );
  }
  await assertBundle(fs, packaged, "packaged");
  return { root: packaged, origin: "packaged" };
}

async function assertBundle(
  fs: FileSystemPort,
  root: string,
  origin: BundleRootOrigin,
): Promise<void> {
  if (!(await fs.exists(join(root, MANIFEST_REL_PATH)))) {
    throw new BundleRootError(
      "CONTEXT_ROOT_NOT_A_BUNDLE",
      `'${root}' (${origin}) no trae ${MANIFEST_REL_PATH}: no es un bundle w medible`,
    );
  }
}
