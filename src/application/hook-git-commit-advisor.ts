import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { parseHookPayload } from "./hook-common.js";
import type { PathsService } from "./paths-service.js";
import { CLOSED_MARKER, listSessionFolders, parseSessionFolder } from "./session-resolver.js";

const REFERENCE_DOC = "skills/session/references/commits-policy.md";
const GIT_COMMIT_RE = /\bgit\s+commit\b/;
const COMMIT_MSG_RE = /\s-m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/;
const SESSION_TAG_RE = /session\d{3}/i;

export interface GitCommitAdvisorResult {
  exitCode: 0;
  stderr?: string;
}

export interface GitCommitAdvisorInput {
  stdin: string;
  fs: FileSystemPort;
  env: EnvPort;
  paths: PathsService;
  /** Display name used as message prefix (e.g., "acme-core", "agent-workflow"). */
  displayName?: string;
}

export async function runGitCommitAdvisor(
  input: GitCommitAdvisorInput,
): Promise<GitCommitAdvisorResult> {
  if ((input.env.get("AW_COMMIT_ADVISOR") ?? "").toLowerCase() === "off") {
    return { exitCode: 0 };
  }

  const payload = parseHookPayload(input.stdin);
  if (!payload) return { exitCode: 0 };

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (toolName !== "Bash") return { exitCode: 0 };

  const command = extractCommand(payload.tool_input);
  if (!command || !GIT_COMMIT_RE.test(command)) return { exitCode: 0 };

  const message = extractCommitMessage(command);
  if (message === null) return { exitCode: 0 };

  // Discover the active session from the sessions dir (non-`.closed` folder).
  // Sessions are no longer registered in the project block. Single unique active
  // session → advise; otherwise no-op.
  const activeFolder = await findUniqueActiveSession(input.fs, input.paths);
  if (!activeFolder) return { exitCode: 0 };

  const { code: sessionCode } = parseSessionFolder(activeFolder);
  if (!sessionCode) return { exitCode: 0 };

  if (SESSION_TAG_RE.test(message)) return { exitCode: 0 };

  const display = input.displayName ?? "agent-workflow";
  return {
    exitCode: 0,
    stderr: formatAdvisorMessage({
      display,
      sessionCode,
      message,
      sessionFolder: activeFolder,
    }),
  };
}

async function findUniqueActiveSession(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<string | null> {
  const folders = await listSessionFolders(fs, paths.cwdSessionsDir());
  const active: string[] = [];
  for (const folder of folders) {
    if (await fs.exists(join(folder.path, CLOSED_MARKER))) continue;
    active.push(folder.name);
  }
  return active.length === 1 ? (active[0] ?? null) : null;
}

function extractCommand(toolInput: unknown): string | null {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const obj = toolInput as Record<string, unknown>;
  const cmd = obj.command;
  return typeof cmd === "string" && cmd.length > 0 ? cmd : null;
}

function extractCommitMessage(command: string): string | null {
  const m = command.match(COMMIT_MSG_RE);
  if (!m) return null;
  const msg = m[1] ?? m[2];
  if (msg === undefined) return null;
  return msg.replace(/\\(.)/g, "$1");
}

interface AdvisorInfo {
  display: string;
  sessionCode: string;
  message: string;
  sessionFolder: string;
}

function formatAdvisorMessage(info: AdvisorInfo): string {
  const truncMsg = info.message.length > 60 ? `${info.message.slice(0, 60)}...` : info.message;
  return `${[
    `[${info.display} git-commit-advisor] Sesión activa sin tag en commit message.`,
    `  Sesión:   session${info.sessionCode} (${info.sessionFolder})`,
    `  Mensaje:  "${truncMsg}"`,
    `  Esperado: incluir tag \`session${info.sessionCode}\` (ej. al final: "(session${info.sessionCode})")`,
    "",
    "Este advisor NO bloquea — el commit procederá. Sugerencia: ajustar el mensaje",
    "para incluir el tag de sesión y mantener trazabilidad con qtc:commits-policy.",
    "",
    "Bypass: AW_COMMIT_ADVISOR=off",
    `Referencia: ${REFERENCE_DOC}`,
    "",
  ].join("\n")}\n`;
}
