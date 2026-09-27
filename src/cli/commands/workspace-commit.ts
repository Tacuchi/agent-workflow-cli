import {
  type WorkspaceCommitResult,
  runWorkspaceCommit,
} from "../../application/workspace-commit-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const workspaceCommitCommand: CliCommand<WorkspaceCommitResult> = {
  name: "workspace-commit",
  flags: { known: ["code", "export", "approval"] },
  describe:
    "Prepare an exact workspace commit, or apply only after approval. Usage: aw workspace-commit prepare --code <sesión>|--export <docs/ruta> · aw workspace-commit apply --code <sesión>|--export <docs/ruta> --approval <digest>.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<WorkspaceCommitResult>> {
    const action = args.rest[0];
    if (action !== "prepare" && action !== "apply")
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "indicá prepare o apply" },
        exitCode: 1,
      };
    if (action === "apply" && !args.values.get("approval"))
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "apply exige --approval" },
        exitCode: 1,
      };
    if (action === "prepare" && args.values.has("approval"))
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "la aprobación pertenece a apply" },
        exitCode: 1,
      };
    const code = args.values.get("code");
    const exportPath = args.values.get("export");
    const approval = args.values.get("approval");
    const result = await runWorkspaceCommit(ctx.fs, ctx.git, ctx.process, ctx.paths, {
      ...(code !== undefined ? { code } : {}),
      ...(exportPath !== undefined ? { exportPath } : {}),
      ...(approval !== undefined ? { approval } : {}),
    });
    if ("error" in result)
      return {
        ok: false,
        error: { code: "WORKSPACE_COMMIT_BLOCKED", message: result.error },
        exitCode: 1,
      };
    return { ok: true, data: result, exitCode: 0 };
  },
  renderHuman(result: CommandResult<WorkspaceCommitResult>): string {
    if (!result.data || !("proposal" in result.data)) return "";
    const { proposal, committed } = result.data;
    return `${[
      committed ? `Commit ${committed.after}` : `Commit propuesto: ${proposal.message}`,
      `  Repositorio: ${proposal.repo} · rama ${proposal.branch}`,
      ...proposal.paths.map((path) => `  incluir  ${path}`),
      ...proposal.excluded.map((path) => `  excluir  ${path}`),
      ...(committed ? [] : [`  Aprobación: ${proposal.approval}`]),
    ].join("\n")}\n`;
  },
};
