import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import {
  type ProjectFuente,
  type ProjectSession,
  parseProjectBlock,
} from "./parsers/project-block.js";

export interface CheckBranchInput {
  alias?: string;
  pathArg?: string;
  fileArg?: string;
  sessionCode?: string;
  flowOverride?: string;
  strict?: boolean;
}

export interface CheckBranchOutput {
  match: boolean;
  reason?: string;
  alias?: string;
  path?: string;
  flow?: string | null;
  current_branch?: string | null;
  expected_work_branch?: string | null;
  dirty?: boolean | null;
  changed_files?: string[];
  is_repo?: boolean;
  error?: string | null;
  main_branch?: string;
  session_code?: string | null;
  work_branch?: string | null;
  exitCode?: number;
}

export async function runCheckBranch(
  fs: FileSystemPort,
  env: EnvPort,
  git: GitPort,
  input: CheckBranchInput,
): Promise<CheckBranchOutput> {
  const cwd = env.cwd();
  const block = await readBlock(fs, cwd);
  const sources = block?.fuentes ?? [];
  if (sources.length === 0) {
    return { match: true, reason: "no_sources_declared" };
  }

  const target = await resolveTarget(fs, sources, input);
  if (!target) {
    return { match: true, reason: "file_not_in_managed_source" };
  }

  const sessionEntry = resolveSessionEntry(block?.sessions ?? [], input.sessionCode);
  const sessionBranches = sessionEntry?.branches ?? [];
  const flow = input.flowOverride ?? resolveFlow(sessionEntry);
  const expected = expectedWorkBranch(target, block?.working_branches ?? {}, sessionBranches, flow);

  if (expected === null) {
    return {
      match: true,
      reason: "no_expected_branch_declared",
      alias: target.alias,
      path: target.path,
      flow,
    };
  }

  // Live git status
  if (!(await fs.exists(target.path))) {
    return {
      ...target,
      match: false,
      expected_work_branch: expected,
      current_branch: null,
      dirty: null,
      changed_files: [],
      is_repo: false,
      error: `Path does not exist: ${target.path}`,
      session_code: input.sessionCode ?? null,
      flow,
      work_branch: expected,
    };
  }
  if (!(await git.isGitRepo(target.path))) {
    return {
      ...target,
      match: false,
      expected_work_branch: expected,
      current_branch: null,
      dirty: null,
      changed_files: [],
      is_repo: false,
      error: "Not a git repository",
      session_code: input.sessionCode ?? null,
      flow,
      work_branch: expected,
    };
  }

  const current = (await git.currentBranch(target.path)) ?? null;
  const match = current === expected;
  let changed: string[] = [];
  try {
    changed = await git.changedFiles(target.path);
  } catch {
    changed = [];
  }
  return {
    ...target,
    expected_work_branch: expected,
    current_branch: current,
    match,
    dirty: changed.length > 0,
    changed_files: changed,
    is_repo: true,
    error: null,
    session_code: input.sessionCode ?? null,
    flow,
    work_branch: expected,
  };
}

async function readBlock(fs: FileSystemPort, cwd: string) {
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file));
    if (block) return block;
  }
  return null;
}

async function resolveTarget(
  _fs: FileSystemPort,
  sources: ProjectFuente[],
  input: CheckBranchInput,
): Promise<ProjectFuente | null> {
  if (input.alias) {
    return sources.find((s) => s.alias === input.alias) ?? null;
  }
  if (input.pathArg) {
    const target = sources.find((s) => s.path === input.pathArg);
    return target ?? null;
  }
  if (input.fileArg) {
    // Match if fileArg starts with the source path.
    for (const s of sources) {
      if (input.fileArg.startsWith(s.path)) return s;
    }
    return null;
  }
  return null;
}

function resolveSessionEntry(
  sessions: ProjectSession[],
  sessionCode: string | undefined,
): ProjectSession | null {
  if (!sessionCode) return sessions[0] ?? null;
  for (const s of sessions) {
    if (s.folder.startsWith(`session${sessionCode}`)) return s;
  }
  return null;
}

function resolveFlow(session: ProjectSession | null): string | null {
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
