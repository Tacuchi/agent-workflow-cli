import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { type CheckBranchOutput, runCheckBranch } from "./check-branch-service.js";
import { parseHookPayload } from "./hook-common.js";
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

/**
 * The git-safe invariant at the moment of the edit.
 *
 * The verdict is NOT computed here: it is `aw check-branch`'s, so the hook and
 * the command can never drift into two different answers about the same file.
 * What lives here is the hook's own half — which tools to watch, how to read the
 * payload, and how to say "no" in a way whoever is blocked can act on.
 */
export async function runBranchCheckHook(input: BranchCheckInput): Promise<BranchCheckResult> {
  const payload = parseHookPayload(input.stdin);
  if (!payload) return { exitCode: 0 };

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (!TOOLS_OF_INTEREST.has(toolName)) return { exitCode: 0 };
  const filePath = extractFilePath(payload.tool_input);
  if (!filePath) return { exitCode: 0 };

  // The conversation's own identity travels in the SAME payload the tool call
  // arrives in, so reading it costs nothing extra — and it is what tells one
  // concurrent flow's unit from another's.
  const contextId = typeof payload.session_id === "string" ? payload.session_id : undefined;

  const verdict = await runCheckBranch(input.fs, input.env, input.git, input.paths, {
    fileArg: filePath,
    ...(contextId !== undefined && contextId.length > 0 ? { contextId } : {}),
  });
  if (verdict.match) return { exitCode: 0 };
  // A source that is missing or is not a repo is not something an edit can fix,
  // and blocking on it would make an unrelated misconfiguration look like a
  // branch violation. That case stayed permissive before this feature; it stays.
  if (verdict.is_repo === false) return { exitCode: 0 };

  return {
    exitCode: 2,
    stderr: formatBlockMessage(verdict, input.displayName ?? "agent-workflow"),
  };
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

/**
 * Why the edit is refused and what unblocks it.
 *
 * Every branch here ends in an action, because a hook that only says "no" makes
 * the invariant hostile: the agent that is blocked has to be handed the exact
 * command, not a rule to go and look up.
 */
function formatBlockMessage(verdict: CheckBranchOutput, displayName: string): string {
  const head = `[${displayName}]`;
  const source = `  Fuente:        ${verdict.alias} (${verdict.path})`;

  if (verdict.reason === "outside_unit") {
    return [
      `${head} Esta fuente se está editando por unidad de aislamiento, y este archivo queda fuera.`,
      source,
      `  Unidad esperada: ${verdict.expected_unit?.path ?? "(la de tu sesión)"}`,
      `  Rama:            ${verdict.expected_unit?.branch ?? "aw/<sesión>"}`,
      "",
      `Obtené tu unidad y volvé a editar dentro de ella:\n  ${verdict.remedy}`,
      "",
      `Referencia: ${REFERENCE_DOC}`,
      "",
    ].join("\n");
  }

  if (verdict.reason === "other_session_unit") {
    return [
      `${head} Ese árbol es la unidad de aislamiento de OTRA sesión.`,
      source,
      `  Unidad ajena:  ${verdict.actual_unit?.path} (sesión ${verdict.actual_unit?.session})`,
      `  Tu unidad:     ${verdict.expected_unit?.path ?? "(todavía no existe)"}`,
      "",
      `Editá en la tuya:\n  ${verdict.remedy}`,
      "",
      `Referencia: ${REFERENCE_DOC}`,
      "",
    ].join("\n");
  }

  const lines: string[] = [
    `${head} Rama de trabajo incorrecta para esta fuente.`,
    source,
    `  Rama actual:   ${verdict.current_branch}`,
    `  Rama esperada: ${verdict.expected_work_branch}`,
  ];
  const changed = verdict.changed_files ?? [];
  if (changed.length > 0) {
    let preview = changed.slice(0, 5).join(", ");
    if (changed.length > 5) preview += ", ...";
    lines.push(`  Cambios sin commit (${changed.length} archivo(s)): ${preview}`);
    lines.push("");
    lines.push(
      "Pausar y avisar al usuario. NO ejecutar git stash/reset/clean/checkout. " +
        "Esperar a que el usuario resuelva manualmente (commit / stash / discard) " +
        "y luego reintentar la edicion.",
    );
  } else {
    lines.push("");
    lines.push(
      `Pedir confirmacion al usuario para ejecutar \`git checkout ${verdict.expected_work_branch}\` en esta fuente y luego reintentar la edicion.`,
    );
  }
  lines.push("");
  lines.push(`Referencia: ${REFERENCE_DOC}`);
  return `${lines.join("\n")}\n`;
}
