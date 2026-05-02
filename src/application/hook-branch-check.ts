// Mirror de core-workflow-plugin/scripts/branch-check.py.
import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import {
  type ProjectFuente,
  type ProjectSession,
  parseProjectBlock,
} from "./parsers/project-block.js";

const TOOLS_OF_INTEREST = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const REFERENCE_DOC = "skills/session/references/branch-verification.md";

export interface BranchCheckResult {
  exitCode: 0 | 2;
  stderr?: string;
}

export interface BranchCheckInput {
  stdin: string;
  fs: FileSystemPort;
  env: EnvPort;
  git: GitPort;
}

export async function runBranchCheckHook(input: BranchCheckInput): Promise<BranchCheckResult> {
  const target = await resolveBranchCheckTarget(input);
  if (!target) return { exitCode: 0 };
  return verifyBranch(input, target);
}

interface ResolvedTarget {
  source: ProjectFuente;
  expected: string;
}

async function resolveBranchCheckTarget(input: BranchCheckInput): Promise<ResolvedTarget | null> {
  const payload = parsePayload(input.stdin);
  if (!payload) return null;

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (!TOOLS_OF_INTEREST.has(toolName)) return null;
  const filePath = extractFilePath(payload.tool_input);
  if (!filePath) return null;

  const block = await readBlock(input.fs, input.env.cwd());
  if (!block) return null;
  const source = findOwningSource(block.fuentes, filePath);
  if (!source) return null;

  const sessionEntry = block.sessions[0] ?? null;
  const sessionBranches = sessionEntry?.branches ?? [];
  const flow = resolveFlow(sessionEntry);
  const expected = expectedWorkBranch(source, block.working_branches, sessionBranches, flow);
  if (expected === null) return null;
  return { source, expected };
}

function parsePayload(stdin: string): Record<string, unknown> | null {
  const raw = stdin.trim();
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function verifyBranch(
  input: BranchCheckInput,
  target: ResolvedTarget,
): Promise<BranchCheckResult> {
  const { source, expected } = target;
  if (!(await input.fs.exists(source.path))) return { exitCode: 0 };
  if (!(await input.git.isGitRepo(source.path))) return { exitCode: 0 };
  const current = (await input.git.currentBranch(source.path)) ?? null;
  if (current === null || current === expected) return { exitCode: 0 };
  const changedFiles = await safeChangedFiles(input.git, source.path);
  return {
    exitCode: 2,
    stderr: formatBlockMessage({
      alias: source.alias,
      path: source.path,
      current,
      expected,
      dirty: changedFiles.length > 0,
      changedFiles,
    }),
  };
}

async function safeChangedFiles(git: GitPort, repoPath: string): Promise<string[]> {
  try {
    return await git.changedFiles(repoPath);
  } catch {
    return [];
  }
}

function extractFilePath(toolInput: unknown): string | null {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const obj = toolInput as Record<string, unknown>;
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

async function readBlock(fs: FileSystemPort, cwd: string) {
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file));
    if (block) return block;
  }
  return null;
}

function findOwningSource(sources: ProjectFuente[], filePath: string): ProjectFuente | null {
  for (const s of sources) {
    if (filePath.startsWith(s.path)) return s;
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

interface BlockMessageInput {
  alias: string;
  path: string;
  current: string;
  expected: string;
  dirty: boolean;
  changedFiles: string[];
}

function formatBlockMessage(info: BlockMessageInput): string {
  const lines: string[] = [
    "[qtc-core] Rama de trabajo incorrecta para esta fuente.",
    `  Fuente:        ${info.alias} (${info.path})`,
    `  Rama actual:   ${info.current}`,
    `  Rama esperada: ${info.expected}`,
  ];
  if (info.dirty) {
    let preview = info.changedFiles.slice(0, 5).join(", ");
    if (info.changedFiles.length > 5) preview += ", ...";
    lines.push(`  Cambios sin commit (${info.changedFiles.length} archivo(s)): ${preview}`);
    lines.push("");
    lines.push(
      "Pausar y avisar al usuario. NO ejecutar git stash/reset/clean/checkout. " +
        "Esperar a que el usuario resuelva manualmente (commit / stash / discard) " +
        "y luego reintentar la edicion.",
    );
  } else {
    lines.push("");
    lines.push(
      `Pedir confirmacion al usuario para ejecutar \`git checkout ${info.expected}\` en esta fuente y luego reintentar la edicion.`,
    );
  }
  lines.push("");
  lines.push(`Referencia: ${REFERENCE_DOC}`);
  return `${lines.join("\n")}\n`;
}
