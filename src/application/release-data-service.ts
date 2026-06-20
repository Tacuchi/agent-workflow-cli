import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ResolvedRuntime } from "../runtime/types.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { type GraduatedBundle, listGraduatedBundles } from "./release-data/bundles.js";
import { getDocsDir, getReleaseDir } from "./release-data/common.js";
import {
  type ReleaseSession,
  enrichSessionsWithLegacyMeta,
  listSessionsForRelease,
} from "./release-data/sessions.js";

export type { ReleaseSession } from "./release-data/sessions.js";
export type { GraduatedBundle } from "./release-data/bundles.js";
export type { SessionArtifactsResult } from "./release-data/artifacts.js";
export { listSessionsForRelease } from "./release-data/sessions.js";
export { readSessionArtifacts } from "./release-data/artifacts.js";
export { listGraduatedBundles } from "./release-data/bundles.js";

export interface ReleaseDataInput {
  since?: string;
  sourceAlias?: string;
  includeGraduated?: boolean;
  includeOpen?: boolean;
  includeClosed?: boolean;
  skipContent?: boolean;
  verbose?: boolean;
  sessions?: string[];
}

export interface ReleaseDataOutput {
  source_alias: string | null;
  docs_root: string;
  release_root: string;
  sessions: ReleaseSession[];
  sessions_count: number;
  legacy_sessions?: string[];
  since?: string;
  graduated_bundles?: GraduatedBundle[];
}

export interface ReleaseDataError {
  error: string;
}

export async function runReleaseData(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: ReleaseDataInput,
  runtime?: ResolvedRuntime,
): Promise<ReleaseDataOutput | ReleaseDataError> {
  const cwd = env.cwd();
  const verbose = input.verbose ?? false;

  let docsRoot: string;
  let releaseRoot: string;
  try {
    docsRoot = await getDocsDir(fs, cwd, paths, input.sourceAlias);
    releaseRoot = await getReleaseDir(fs, cwd, paths, input.sourceAlias);
  } catch (e) {
    return { error: (e as Error).message };
  }

  const sinceOpts: {
    since?: string;
    includeOpen?: boolean;
    includeClosed?: boolean;
    sessions?: string[];
  } = {
    includeOpen: input.includeOpen ?? true,
    includeClosed: input.includeClosed ?? true,
  };
  if (input.sessions !== undefined && input.sessions.length > 0) {
    sinceOpts.sessions = input.sessions;
  } else if (input.since !== undefined) {
    sinceOpts.since = input.since;
  }
  const sessions = await listSessionsForRelease(fs, cwd, paths, sinceOpts);
  const { enriched, legacy } = enrichSessionsWithLegacyMeta(sessions, cwd, runtime);

  const payload: ReleaseDataOutput = {
    source_alias: input.sourceAlias ?? null,
    docs_root: verbose ? docsRoot : relpath(docsRoot, cwd),
    release_root: verbose ? releaseRoot : relpath(releaseRoot, cwd),
    sessions: enriched,
    sessions_count: enriched.length,
  };
  // Verbose always reports legacy_sessions; compact mode only when non-empty.
  if (verbose || legacy.length > 0) payload.legacy_sessions = legacy;
  if (input.since !== undefined) payload.since = input.since;

  if (input.includeGraduated === true) {
    const opts: { sourceAlias?: string } = {};
    if (input.sourceAlias !== undefined) opts.sourceAlias = input.sourceAlias;
    payload.graduated_bundles = await listGraduatedBundles(fs, cwd, paths, opts);
  }
  return payload;
}
