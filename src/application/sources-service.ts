import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import type { ProcessPort } from "../ports/process.js";
import {
  type ProjectFuente,
  type ProjectSession,
  parseProjectBlock,
} from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";

export interface SourcesInput {
  sessionCode?: string;
  scope?: string[];
  skipGit?: boolean;
  flowOverride?: string;
  verbose?: boolean;
}

export interface EnrichedSource extends ProjectFuente {
  expected_work_branch: string | null;
  current_branch: string | null;
  match: boolean | null;
  dirty: boolean | null;
  changed_files: string[];
  is_repo: boolean;
  error: string | null;
}

export interface DivergentSource {
  alias: string;
  current: string | null;
  expected: string | null;
}

export interface SourcesOutput {
  workspace_mode: "project" | "hub";
  flow: string | null;
  sources: Array<Partial<EnrichedSource>>;
  session_branches: string[];
  working_branches_from_status: Record<string, string>;
  cross_source_consistent: boolean;
  divergent_sources: DivergentSource[];
  is_hub?: boolean;
  session_code?: string;
  scope?: string[] | null;
  error?: string;
}

export async function runSources(
  fs: FileSystemPort,
  env: EnvPort,
  git: GitPort,
  paths: PathsService,
  input: SourcesInput,
): Promise<SourcesOutput> {
  const cwd = env.cwd();
  const block = await readProjectBlock(fs, cwd, paths);
  const verbose = input.verbose === true;

  if (!block || block.fuentes.length === 0) {
    const empty: SourcesOutput = {
      workspace_mode: block?.mode ?? "project",
      flow: null,
      sources: [],
      session_branches: [],
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
  const sessionEntry = resolveSessionEntry(block.sessions, input.sessionCode);
  const sessionBranches = sessionEntry?.branches ?? [];
  const flow = input.flowOverride ?? resolveSessionFlow(sessionEntry);
  const workingBranches = block.working_branches;

  const enriched: EnrichedSource[] = [];
  for (const src of sources) {
    const expected = expectedWorkBranch(src, workingBranches, sessionBranches, flow);
    if (input.skipGit === true) {
      // Mirror Python: skip_git produces only alias/path/main_branch/expected_work_branch.
      enriched.push({
        alias: src.alias,
        path: src.path,
        main_branch: src.main_branch,
        expected_work_branch: expected,
      } as EnrichedSource);
    } else {
      enriched.push(await checkSourceBranch(fs, git, src, expected));
    }
  }

  const { consistent, divergent } = computeCrossSourceConsistency(enriched);

  const payload: SourcesOutput = {
    workspace_mode: block.mode,
    flow,
    sources: enriched.map((e) => compactSourceEntry(e, cwd, verbose)) as Array<
      Partial<EnrichedSource>
    >,
    session_branches: sessionBranches,
    working_branches_from_status: workingBranches,
    cross_source_consistent: consistent,
    divergent_sources: divergent,
  };

  if (verbose) {
    payload.is_hub = block.mode === "hub";
    payload.session_code = input.sessionCode ?? "";
    payload.scope = input.scope ?? null;
  } else if (input.sessionCode !== undefined) {
    payload.session_code = input.sessionCode;
  }
  return payload;
}

async function readProjectBlock(fs: FileSystemPort, cwd: string, paths: PathsService) {
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), paths.blockMarkers());
    if (block) return block;
  }
  return null;
}

function resolveSessionEntry(
  sessions: ProjectSession[],
  sessionCode: string | undefined,
): ProjectSession | null {
  if (!sessionCode) return sessions[0] ?? null;
  for (const s of sessions) {
    if (s.folder.startsWith(`session${sessionCode}`) || s.folder.includes(sessionCode)) {
      return s;
    }
  }
  return null;
}

function resolveSessionFlow(session: ProjectSession | null): string | null {
  if (!session) return null;
  const m = session.folder.match(/^session(\d{3})-([a-z]+)-/);
  if (!m || !m[2]) return null;
  return ["dev", "design", "analyze"].includes(m[2]) ? m[2] : null;
}

function expectedWorkBranch(
  source: ProjectFuente,
  workingBranches: Record<string, string>,
  sessionBranches: string[],
  flow: string | null,
): string | null {
  for (const entry of sessionBranches) {
    if (!entry.includes(":")) continue;
    const [a, b] = entry.split(":", 2);
    if (a?.trim() === source.alias && b?.trim()) return b.trim();
  }
  if (flow === "analyze") return source.main_branch;
  if (workingBranches[source.alias]) return workingBranches[source.alias] ?? null;
  return null;
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
  if (!(await fs.exists(source.path))) {
    base.error = `Path does not exist: ${source.path}`;
    return base;
  }
  if (!(await git.isGitRepo(source.path))) {
    base.error = "Not a git repository";
    return base;
  }
  base.is_repo = true;
  const current = (await git.currentBranch(source.path)) ?? null;
  base.current_branch = current;
  base.match = expected === null ? null : current === expected;
  try {
    const changed = await git.changedFiles(source.path);
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
  const candidates = sources.filter((s) => s.is_repo && s.error === null && s.current_branch);
  if (candidates.length < 2) return { consistent: true, divergent: [] };
  const branches = new Set(candidates.map((s) => s.current_branch));
  if (branches.size <= 1) return { consistent: true, divergent: [] };
  return {
    consistent: false,
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

// Re-export for command needs
export type { ProcessPort };
