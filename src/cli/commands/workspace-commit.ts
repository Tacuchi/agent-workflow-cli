import {
  type WorkspaceCommitResult,
  runWorkspaceCommit,
} from "../../application/workspace-commit-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const workspaceCommitCommand: CliCommand<WorkspaceCommitResult> = {
  name: "hub-commit",
  flags: {
    known: ["code", "export", "approval", "with-evidence"],
    exclusive: [["code", "export"]],
    actions: { prepare: { known: [] }, apply: { known: [] } },
  },
  help: {
    purpose: "Commit a session's or an export's hub files with an exact pathspec, after approval.",
    flags: {
      code: { value: "<code>", effect: "Commit the files of this session." },
      export: { value: "<docs-path>", effect: "Commit the files of this export under docs/." },
      approval: {
        value: "<digest>",
        effect: "Approval digest returned by prepare; required by apply, refused by prepare.",
      },
      "with-evidence": {
        effect:
          "Read by prepare with --code: include the scratchpad copies approved at the flow close.",
      },
    },
    actions: {
      prepare: {
        purpose: "Propose the exact commit (paths, exclusions, message) and its approval digest.",
        output: "{proposal {repo, branch, head, message, paths[], excluded[], approval}}.",
      },
      apply: {
        purpose: "Re-derive the proposal and commit it only if it still matches the approval.",
        output:
          "{proposal {repo, branch, head, message, paths[], excluded[], approval}, committed {branch, before, after, parents[]}}.",
      },
    },
    notes: ["Never stages with git add .; only the listed paths are committed."],
  },
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
    if (args.flags.has("--with-evidence") && (code === undefined || action !== "prepare"))
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "--with-evidence requiere prepare --code" },
        exitCode: 1,
      };
    const approval = args.values.get("approval");
    const result = await runWorkspaceCommit(ctx.fs, ctx.git, ctx.process, ctx.paths, {
      ...(code !== undefined ? { code } : {}),
      ...(exportPath !== undefined ? { exportPath } : {}),
      ...(approval !== undefined ? { approval } : {}),
      ...(args.flags.has("--with-evidence") ? { withEvidence: true } : {}),
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
