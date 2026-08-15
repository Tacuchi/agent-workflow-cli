import {
  type ResumeInput,
  type ResumeOutcome,
  type ResumeProposal,
  runResume,
} from "../../application/resume-service.js";
import { DEFAULT_CORE_DOCS_CANON } from "../../domain/docs-canon.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import type { CliContext } from "../types.js";

export const resumeCommand: CliCommand<ResumeOutcome> = {
  name: "resume",
  describe: `Qué retomar y con qué comando exacto, derivado del pipeline documental. Read-only: propone la ruta, nunca la ejecuta. Usage: aw resume [<${DEFAULT_CORE_DOCS_CANON.spec}|${DEFAULT_CORE_DOCS_CANON.plan} path | número>] [--code <sesión>] [--format human|json] [--detail].`,

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<ResumeOutcome>> {
    const target = args.rest[0];
    const code = args.values.get("code");
    if (target !== undefined && code !== undefined) {
      return {
        ok: false,
        error: {
          code: "ARGS_INVALID",
          message: "declará un solo target: un documento posicional o --code, no ambos",
        },
        exitCode: 1,
      };
    }

    // Env only — never stdin. `resume` is a user command; blocking on an idle
    // fd 0 is what made the hook reader need a bounded window in the first place.
    const contextId = readContextId(ctx.env);
    const input: ResumeInput = {
      ...(target !== undefined ? { target } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(contextId !== undefined ? { contextId } : {}),
    };

    const outcome = await runResume(ctx.fs, ctx.env, ctx.paths, { ...input, git: ctx.git });
    if (outcome.status === "invalid_target") {
      return {
        ok: false,
        error: { code: "RESUME_TARGET_INVALID", message: outcome.action },
        data: outcome,
        exitCode: 1,
      };
    }
    return { ok: true, data: outcome, exitCode: 0 };
  },

  renderHuman(result: CommandResult<ResumeOutcome>, context: HumanRenderContext): string {
    const outcome = result.data;
    if (outcome === undefined) return "";
    switch (outcome.status) {
      case "idle":
        return `${outcome.action}\n`;
      case "proposal":
        return `${renderProposal(outcome.proposal, context.detail)}\n`;
      case "candidates":
        return renderCandidates(outcome.candidates, outcome.action, context.detail);
      case "invalid_target":
        return `${outcome.action}\n`;
    }
  },
};

function renderProposal(proposal: ResumeProposal, detail: boolean): string {
  const lines = [
    `▸ ${proposal.objective}`,
    `  Progreso   ${proposal.progress}`,
    `  Siguiente  ${proposal.next}`,
    `  Comando    ${proposal.command}`,
  ];
  // Shown without `--detail`: a reference that does not resolve changes WHICH
  // command is next, so hiding it behind a flag would hide the actual blocker.
  for (const design of proposal.design ?? []) {
    lines.push(`  Diseño     [${design.state}] ${design.baseline}${because(design.detail)}`);
  }
  if (detail) lines.push(`  Ruta       ${proposal.file}`);
  return lines.join("\n");
}

function because(text: string | null): string {
  return text === null ? "" : ` — ${text}`;
}

function renderCandidates(candidates: ResumeProposal[], action: string, detail: boolean): string {
  const lines = [action, ""];
  for (const candidate of candidates) {
    lines.push(renderProposal(candidate, detail), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
