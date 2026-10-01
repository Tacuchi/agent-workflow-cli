import { dirname } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { documentOfSession, readDocBranches, resolveDocBranch } from "./doc-branch-ledger.js";
import { declaringHubs } from "./hub-registry.js";
import {
  type ProjectFuente,
  readWorkspaceBlock,
  requireSourcePath,
} from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { resolveSessionTarget } from "./session-resolver.js";

export interface SourcesInput {
  sessionCode?: string;
  contextId?: string;
  scope?: string[];
  skipGit?: boolean;
  verbose?: boolean;
}

export interface EnrichedSource extends ProjectFuente {
  expected_work_branch: string | null;
  expected_origin?: string;
  working_branch_notice?: string;
  current_branch: string | null;
  match: boolean | null;
  dirty: boolean | null;
  changed_files: string[];
  is_repo: boolean;
  error: string | null;
  error_code?: "SOURCE_PATH_MISSING";
  other_hubs?: Array<{ root: string; working_branch: string | null }>;
  shared_branch_warning?: string;
}

export interface DivergentSource {
  alias: string;
  current: string | null;
  expected: string | null;
}

export interface SourcesOutput {
  sources: Array<Partial<EnrichedSource>>;
  working_branches_from_status: Record<string, string>;
  cross_source_consistent: boolean;
  divergent_sources: DivergentSource[];
  doc_branch_unreadable?: number;
  session_code?: string;
  scope?: string[] | null;
  error?: string;
}

export async function runSources(
  fs: FileSystemPort,
  _env: EnvPort,
  git: GitPort,
  paths: PathsService,
  input: SourcesInput,
): Promise<SourcesOutput> {
  const cwd = paths.workspaceDir();
  const ownRoot = await fs.realPath(cwd).catch(() => cwd);
  const block = await readWorkspaceBlock(fs, cwd, paths.blockMarkers());
  const verbose = input.verbose === true;

  if (!block || block.fuentes.length === 0) {
    const empty: SourcesOutput = {
      sources: [],
      working_branches_from_status: {},
      cross_source_consistent: true,
      divergent_sources: [],
      error: "no_sources_declared",
    };
    return empty;
  }

  const sources = input.scope
    ? block.fuentes.filter((s) => input.scope?.includes(s.alias))
    : block.fuentes;
  // Expected work branch comes from WORKSPACE block working_branches per source;
  // decoupled from sessions/flow.
  const workingBranches = block.working_branches;
  const resolution = await resolveSessionTarget(fs, paths, {
    intent: "read",
    bind: false,
    ...(input.sessionCode ? { code: input.sessionCode } : {}),
    ...(input.contextId ? { contextId: input.contextId } : {}),
  });
  if (input.sessionCode !== undefined && resolution?.outcome !== "resolved") {
    return {
      sources: [],
      working_branches_from_status: workingBranches,
      cross_source_consistent: false,
      divergent_sources: [],
      error: resolution?.message ?? "sesión no resuelta",
    };
  }
  const document =
    resolution?.outcome === "resolved"
      ? await documentOfSession(fs, paths, resolution.session.folder)
      : { status: "none" as const };
  const ledger = await readDocBranches(fs, paths);

  const enriched: EnrichedSource[] = [];
  async function enrichSource(src: ProjectFuente): Promise<void> {
    const effective = await resolveDocBranch(fs, paths, src, block, document, ledger);
    const expected = effective.branch;
    const others =
      src.path === null
        ? []
        : (await declaringHubs(fs, dirname(paths.userRoot()), paths.namespace, src.path))
            .filter((hub) => hub.root !== ownRoot)
            .map((hub) => ({ root: hub.root, working_branch: hub.workingBranch }));
    if (input.skipGit === true) {
      // Mirror Python: skip_git produces only alias/path/main_branch/expected_work_branch.
      enriched.push({
        alias: src.alias,
        path: src.path,
        main_branch: src.main_branch,
        expected_work_branch: expected,
        expected_origin: effective.origin,
        ...(effective.origin === "none"
          ? {
              working_branch_notice: `rama de trabajo no declarada para ${src.alias}; usá 'aw set-working-branch ${src.alias} <rama>'`,
            }
          : {}),
        other_hubs: others,
      } as EnrichedSource);
    } else {
      const checked = await checkSourceBranch(fs, git, src, expected);
      enriched.push({
        ...checked,
        expected_origin: effective.origin,
        ...(effective.origin === "none"
          ? {
              working_branch_notice: `rama de trabajo no declarada para ${src.alias}; usá 'aw set-working-branch ${src.alias} <rama>'`,
            }
          : {}),
        other_hubs: others,
        ...(others.some(
          (hub) => hub.working_branch !== null && hub.working_branch === checked.current_branch,
        )
          ? {
              shared_branch_warning: `El checkout está en la rama de trabajo de otro workspace: ${others
                .filter((hub) => hub.working_branch === checked.current_branch)
                .map((hub) => hub.root)
                .join(", ")}`,
            }
          : {}),
      });
    }
  }
  for (const src of sources) {
    await enrichSource(src);
  }

  const { consistent, divergent } = computeCrossSourceConsistency(enriched);

  const payload: SourcesOutput = {
    sources: enriched.map((e) => compactSourceEntry(e, cwd, verbose)) as Array<
      Partial<EnrichedSource>
    >,
    working_branches_from_status: workingBranches,
    cross_source_consistent: consistent,
    divergent_sources: divergent,
    ...(ledger.unreadable > 0 ? { doc_branch_unreadable: ledger.unreadable } : {}),
  };

  if (verbose) {
    payload.session_code = input.sessionCode ?? "";
    payload.scope = input.scope ?? null;
  } else if (input.sessionCode !== undefined) {
    payload.session_code = input.sessionCode;
  }
  return payload;
}

async function checkSourceBranch(
  fs: FileSystemPort,
  git: GitPort,
  source: ProjectFuente,
  expected: string | null,
): Promise<EnrichedSource> {
  const base: EnrichedSource = {
    ...source,
    expected_work_branch: expected,
    current_branch: null,
    match: null,
    dirty: null,
    changed_files: [],
    is_repo: false,
    error: null,
  };
  let repo: string;
  try {
    repo = await requireSourcePath(fs, source);
  } catch (err) {
    base.error = (err as Error).message;
    base.error_code = "SOURCE_PATH_MISSING";
    return base;
  }
  if (!(await git.isGitRepo(repo))) {
    base.error = "Not a git repository";
    return base;
  }
  base.is_repo = true;
  const current = (await git.currentBranch(repo)) ?? null;
  base.current_branch = current;
  base.match = expected === null ? null : current === expected;
  try {
    const changed = await git.changedFiles(repo);
    base.changed_files = changed;
    base.dirty = changed.length > 0;
  } catch {
    base.changed_files = [];
    base.dirty = false;
  }
  return base;
}

function computeCrossSourceConsistency(sources: EnrichedSource[]): {
  consistent: boolean;
  divergent: DivergentSource[];
} {
  const candidates = sources.filter(
    (s) => s.is_repo && s.error === null && s.expected_work_branch !== null && s.match === false,
  );
  return {
    consistent: candidates.length === 0,
    divergent: candidates.map((s) => ({
      alias: s.alias,
      current: s.current_branch,
      expected: s.expected_work_branch,
    })),
  };
}

function compactSourceEntry(
  entry: EnrichedSource,
  cwd: string,
  verbose: boolean,
): Record<string, unknown> {
  if (verbose) return entry as unknown as Record<string, unknown>;
  // Build fresh dict without R1+R3 omissions (instead of using delete operator).
  const e: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === "error" && v === null) continue;
    if (k === "changed_files" && Array.isArray(v) && v.length === 0) continue;
    if (k === "is_repo" && v === true) continue;
    if (k === "path" && typeof v === "string") {
      e[k] = relpath(v, cwd);
      continue;
    }
    e[k] = v;
  }
  return e;
}
