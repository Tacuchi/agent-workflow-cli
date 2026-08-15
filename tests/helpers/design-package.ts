import {
  type PackageCandidate,
  type PublishFile,
  buildPackageCandidate,
} from "../../src/application/design/design-publish-service.js";
import type { DesignManifest } from "../../src/domain/design/manifest.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";

/**
 * The candidate the live route builds for a revision of a package on disk.
 *
 * `packageProposal` resolves the manifest by identity and hands it to
 * `buildPackageCandidate`; this reads the manifest off the same tree and calls
 * the same builder, so a test asserting on a candidate asserts on exactly what
 * production seals.
 *
 * It stops there on purpose. Writing is `applyLocalProposal`'s job behind an
 * approval, and a helper that published would be the retired shortcut — a
 * second publication path that skipped preview and approval — growing back
 * inside the test suite.
 */
export async function packageCandidate(
  fs: FileSystemPort,
  workspace: string,
  input: {
    /** Workspace-relative package folder. */
    packagePath: string;
    files: PublishFile[];
    published?: string;
    dataAuthorization?: string;
  },
): Promise<PackageCandidate> {
  const manifest = JSON.parse(
    await fs.readText(`${workspace}/${input.packagePath}/design-manifest.json`),
  ) as DesignManifest;
  return buildPackageCandidate(fs, workspace, {
    manifest,
    packagePath: input.packagePath,
    files: input.files,
    published: input.published ?? "2026-08-03",
    ...(input.dataAuthorization === undefined
      ? {}
      : { dataAuthorization: input.dataAuthorization }),
  });
}
