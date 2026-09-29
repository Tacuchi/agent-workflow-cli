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
  flags: { known: ["code"] },
  help: {
    purpose: "Say what to resume next and the exact command that re-enters it.",
    args: `[<${DEFAULT_CORE_DOCS_CANON.spec}|${DEFAULT_CORE_DOCS_CANON.plan} path|number>]`,
    flags: {
      code: { value: "<code>", effect: "Resume this session; not with a positional document." },
    },
    output:
      "{status: proposal|candidates|idle, proposal? {kind, file, number, objective, progress, next, action, command, warning?}, candidates[]?, action?, ready_to_close[]?, paused_sessions[]?, abandoned_sessions[]?, unreadable_sources[]?, isolation_error?}.",
    notes: [
      "Read-only: it proposes the route and never runs it. Without a target it derives the priority from the document pipeline. An unresolvable target fails with RESUME_TARGET_INVALID.",
    ],
  },

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
    const readyNotice = (outcome.ready_to_close ?? [])
      .map((item) => `  ${item.session}: criterios completos → ${item.command}\n`)
      .join("");
    const stateNotice =
      outcome.paused_sessions?.length || outcome.abandoned_sessions?.length
        ? `\nSesiones apartadas: ${outcome.paused_sessions?.length ?? 0} pausada(s), ${outcome.abandoned_sessions?.length ?? 0} abandonada(s)\n`
        : "";
    const notice = `${readyNotice ? `\nSesiones listas para cerrar:\n${readyNotice}` : ""}${stateNotice}${
      outcome.unreadable_sources?.length || outcome.isolation_error
        ? `\nFuentes sin ruta o unidades no verificables:\n${(outcome.unreadable_sources ?? []).map((item) => `  ${item.alias}: ${item.error}\n`).join("")}${outcome.isolation_error ? `  ${outcome.isolation_error}\n` : ""}`
        : ""
    }`;
    switch (outcome.status) {
      case "idle":
      case "invalid_target":
        return `${outcome.action}\n${notice}`;
      case "proposal":
        return renderRecommendation(outcome.proposal, outcome.candidates, context.detail) + notice;
      case "candidates":
        return renderCandidates(outcome.candidates, outcome.action, context.detail) + notice;
    }
  },
};

function renderProposal(proposal: ResumeProposal, detail: boolean): string {
  const command =
    proposal.command === null
      ? `Bloqueado · ${proposal.action.kind === "blocked" ? proposal.action.action : proposal.next}`
      : proposal.command;
  const lines = [
    `▸ ${proposal.objective}`,
    `  Progreso   ${proposal.progress}`,
    `  Siguiente  ${proposal.next}`,
    `  Comando    ${command}`,
  ];
  if (detail) {
    if (proposal.postponed !== undefined) {
      lines.push(`  Postergado ${proposal.postponed.reason}`);
    }
    if (proposal.warning !== undefined) {
      lines.push(`  Aviso      ${proposal.warning.code}: ${proposal.warning.message}`);
    }
    lines.push(`  Ruta       ${proposal.file}`);
  }
  return lines.join("\n");
}

/**
 * The recommendation, and then the rest of what is pending.
 *
 * The others are printed because they ARE the offer: leaving them in the JSON
 * only would put the choice one surface away from the reading that produced it,
 * which is the split this command exists to close. Nothing is truncated.
 */
function renderRecommendation(
  proposal: ResumeProposal,
  candidates: ResumeProposal[] | undefined,
  detail: boolean,
): string {
  const others = (candidates ?? []).filter((c) => c.file !== proposal.file);
  const lines = [renderProposal(proposal, detail)];
  if (others.length > 0) {
    lines.push("", `También pendiente (${others.length}), en el orden del CLI:`, "");
    for (const other of others) lines.push(renderProposal(other, detail), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderCandidates(candidates: ResumeProposal[], action: string, detail: boolean): string {
  const lines = [action, ""];
  for (const candidate of candidates) {
    lines.push(renderProposal(candidate, detail), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
