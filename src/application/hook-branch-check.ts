import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { expectedWorkBranch, findOwningSource } from "./branch-resolver.js";
import { parseHookPayload } from "./hook-common.js";
import { type ProjectFuente, readWorkspaceBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";

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
  paths: PathsService;
  /**
   * Display name used as message prefix (e.g., "acme-core", "agent-workflow").
   * Defaults to "agent-workflow" when omitted.
   */
  displayName?: string;
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
  const payload = parseHookPayload(input.stdin);
  if (!payload) return null;

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (!TOOLS_OF_INTEREST.has(toolName)) return null;
  const filePath = extractFilePath(payload.tool_input);
  if (!filePath) return null;

  const block = await readWorkspaceBlock(input.fs, input.env.cwd(), input.paths.blockMarkers());
  if (!block) return null;
  const source = findOwningSource(block.fuentes, filePath);
  if (!source) return null;

  // Expected = the source's declared WORKING branch (from the WORKSPACE block).
  // No declared working branch → no expectation → no-op (allow).
  const expected = expectedWorkBranch(source, block.working_branches);
  if (expected === null) return null;
  return { source, expected };
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
      displayName: input.displayName ?? "agent-workflow",
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

interface BlockMessageInput {
  alias: string;
  path: string;
  current: string;
  expected: string;
  dirty: boolean;
  changedFiles: string[];
  displayName: string;
}

function formatBlockMessage(info: BlockMessageInput): string {
  const lines: string[] = [
    `[${info.displayName}] Rama de trabajo incorrecta para esta fuente.`,
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
