/** Advisory at prompt start; the edit-time branch check remains the enforcement. */
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { runCheckBranch } from "./check-branch-service.js";
import { locateRun, readRun } from "./flow/run-state-service.js";
import { parseHookPayload } from "./hook-common.js";
import { readWorkspaceBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { resolveSessionTarget } from "./session-resolver.js";

export async function runTurnStartHook(input: {
  stdin: string;
  fs: FileSystemPort;
  env: EnvPort;
  git: GitPort;
  paths: PathsService;
}): Promise<{ exitCode: 0; stdout?: string }> {
  if (!(await input.fs.exists(input.paths.cwdSessionsDir()))) return { exitCode: 0 };
  const payload = parseHookPayload(input.stdin);
  const contextId = typeof payload?.session_id === "string" ? payload.session_id : null;
  if (!contextId) return { exitCode: 0 };
  const resolved = await resolveSessionTarget(input.fs, input.paths, {
    intent: "read",
    contextId,
    bind: false,
  });
  if (resolved.outcome !== "resolved") return { exitCode: 0 };
  const run = await readRun(input.fs, locateRun(input.paths, resolved.session.folder));
  if (!run.ok) return { exitCode: 0 };
  const block = await readWorkspaceBlock(
    input.fs,
    input.paths.workspaceDir(),
    input.paths.blockMarkers(),
  );
  const aliases =
    run.state.flow === "plan-exec" && run.state.scope?.isolation === "in-place"
      ? run.state.scope.sources
      : run.state.flow === "quick"
        ? (block?.fuentes.map((source) => source.alias) ?? [])
        : [];
  const notices: string[] = [];
  for (const alias of aliases) {
    if (alias === "workspace") continue;
    const verdict = await runCheckBranch(input.fs, input.env, input.git, input.paths, {
      alias,
      sessionCode: resolved.session.folder,
    });
    if (
      verdict.reason === "on_development_branch" ||
      (verdict.match === false &&
        verdict.current_branch &&
        verdict.expected_work_branch &&
        !verdict.actual_unit)
    )
      notices.push(
        `${alias}: checkout en '${verdict.current_branch}'${verdict.expected_work_branch ? `; rama del documento '${verdict.expected_work_branch}'` : ""}. No edites antes de corregir la rama con consentimiento.`,
      );
  }
  return notices.length
    ? {
        exitCode: 0,
        stdout: `[Workline] Aviso de rama al empezar el turno:\n${notices.join("\n")}\n`,
      }
    : { exitCode: 0 };
}
