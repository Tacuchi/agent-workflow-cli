/**
 * The precondition of sealing a governance decision.
 *
 * `record` is the one operation that makes a statement ABOUT a revision rather
 * than about content, so what it must not do is seal an approval over evidence
 * that already moved. The hole this closes was left open on purpose at the end
 * of B2 and written down: a rendition published in the SAME revision as its
 * source screen can carry a `source_digest` that is no longer that screen's —
 * generate the preview, touch the screen again before publishing, and the image
 * is of the draft. The package-level cross-check verifies the REFERENCE
 * (`sources` names `SCR-NNN@rN`), never the digest, so nothing noticed.
 *
 * The check is derived, not declared: every rendition's `source_digest` is
 * recomputable from the bytes of the artifacts it names, which is why a stale
 * one can be caught at all. Reading the current state off disk is the half a
 * governance record cannot supply about itself.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DesignManifest } from "../../domain/design/manifest.js";
import type { DesignRendition } from "../../domain/design/rendition.js";
import { validateDesignRendition } from "../../domain/design/rendition.js";
import { checkStale, staleFailure } from "../../domain/design/rendition.js";
import type { DesignFailure } from "../../domain/design/validation.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { readDesignIndex, resolveDesignPackage } from "./design-index-service.js";

export interface RecordPrecondition {
  ok: boolean;
  /** Renditions whose sources moved after they were cut. */
  stale: string[];
  failures: DesignFailure[];
}

/**
 * Check every rendition the package catalogs against the bytes on disk today.
 *
 * A rendition that cannot be read or parsed is NOT reported as stale: "the file
 * is broken" and "the picture is out of date" are different problems, and
 * merging them would send whoever reads the failure to fix the wrong one.
 */
export async function checkRecordPrecondition(
  fs: FileSystemPort,
  workspace: string,
  packageId: string,
): Promise<RecordPrecondition> {
  const index = await readDesignIndex(fs, workspace);
  const entry = resolveDesignPackage(index, packageId);
  if (entry === null || entry.manifest === null) {
    return {
      ok: false,
      stale: [],
      failures: [
        {
          code: "DESIGN_PACKAGE_NOT_FOUND",
          artifact: packageId,
          message: `no hay ningún package válido con identidad ${packageId}`,
          action: `revisá 'aw designs' para ver las identidades publicadas bajo ${index.root}/`,
        },
      ],
    };
  }

  const catalog = entry.manifest.catalog;
  const current = await currentDigests(fs, join(workspace, entry.path), catalog);

  const stale: string[] = [];
  const failures: DesignFailure[] = [];
  for (const member of catalog.renditions) {
    const rendition = await readRendition(fs, join(workspace, entry.path), member.path);
    if (rendition === null) continue;
    const verdict = checkStale(rendition, current);
    if (verdict === null) continue;
    stale.push(member.id);
    failures.push(staleFailure(verdict, `${member.path}/rendition.json`));
  }

  return { ok: failures.length === 0, stale, failures };
}

/** Digest of every catalogued artifact, keyed by the reference a rendition uses. */
async function currentDigests(
  fs: FileSystemPort,
  packageRoot: string,
  catalog: DesignManifest["catalog"],
): Promise<Map<string, string>> {
  const current = new Map<string, string>();
  for (const group of [catalog.flows, catalog.screens, catalog.rules, catalog.tokens]) {
    for (const member of group) {
      const absolute = join(packageRoot, member.path);
      if (!(await fs.exists(absolute))) continue;
      current.set(`${member.id}@r${member.revision}`, digestOf(await fs.readBytes(absolute)));
    }
  }
  return current;
}

/**
 * Read one rendition, or null.
 *
 * Null covers "absent", "unparseable" and "invalid" on purpose: a broken file
 * and an out-of-date picture are different problems, and reporting the first as
 * the second would send whoever reads the failure to fix the wrong thing.
 */
async function readRendition(
  fs: FileSystemPort,
  packageRoot: string,
  memberPath: string,
): Promise<DesignRendition | null> {
  const absolute = join(packageRoot, memberPath, "rendition.json");
  if (!(await fs.exists(absolute))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readText(absolute));
  } catch {
    return null;
  }
  const validation = validateDesignRendition(parsed, `${memberPath}/rendition.json`);
  return validation.ok ? validation.value : null;
}

function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
