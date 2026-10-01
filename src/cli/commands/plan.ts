/**
 * `aw plan`: actions over a plan document that need no run.
 *
 * `lint` returns the whole plan grammar in one pass — what saving the plan and
 * entering its execution would each refuse — so an author fixes every clause at
 * once instead of discovering them one refused attempt at a time. It opens no
 * flow, creates no session and writes nothing.
 */

import { type PlanLintReport, lintPlan } from "../../application/plan-lint-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

const USAGE = "uso: plan lint <ruta del plan|correlativo>";

export const planCommand: CliCommand<PlanLintReport> = {
  name: "plan",
  flags: { known: [], actions: { lint: { known: [] } } },
  help: {
    purpose: "Run actions over a plan document that need no flow or session.",
    actions: {
      lint: {
        purpose:
          "Report every plan grammar violation at once: sources, closing clauses, execution limit and lineage.",
        args: "<plan-path|number>",
        output:
          "{plan, hub_block, violations[] ({code, line, message, rule, moment: publication|execution-entry|both})}.",
        exit_codes: { "2": "The plan has violations; the report is still printed." },
        notes: [
          "Read-only: opens no flow, creates no session and writes nothing. Without a readable hub block (hub_block false) publication judges the clauses only.",
        ],
      },
    },
  },

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<PlanLintReport>> {
    const action = args.rest[0];
    const target = args.rest[1];
    if (action !== "lint" || target === undefined || args.rest.length > 2) {
      return failSemantic<PlanLintReport>({ code: "INVALID_INPUT", message: USAGE, action: USAGE });
    }
    const linted = await lintPlan(ctx.fs, ctx.paths, target);
    if (!linted.ok) return failSemantic<PlanLintReport>(linted.failure);
    return {
      ok: true,
      data: linted.report,
      exitCode: linted.report.violations.length > 0 ? 2 : 0,
    };
  },

  renderHuman(result): string {
    if (!result.ok || result.data === undefined) return "";
    const report = result.data;
    if (report.violations.length === 0) return `${report.plan}: sin violaciones de la gramática\n`;
    const lines = [`${report.plan}: ${report.violations.length} violación(es)`];
    for (const violation of report.violations) {
      const at = violation.line === null ? "" : `:${violation.line}`;
      lines.push(
        "",
        `${report.plan}${at} ${violation.code} [${violation.moment}]`,
        `  ${violation.message}`,
        `  → ${violation.rule}`,
      );
    }
    if (!report.hub_block) {
      lines.push("", "sin bloque del hub: la publicación juzga sólo las cláusulas");
    }
    return `${lines.join("\n")}\n`;
  },
};
