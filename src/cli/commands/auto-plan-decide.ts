import { runProjectMdRead } from "../../application/project-md-service.js";
import { type AutoPlanOptions, shouldSkipFullPlan } from "../../application/auto-plan.js";
import type { CommandResult } from "../../domain/types.js";
import { readObjetivoIfPresent } from "../helpers/objetivo-loader.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { writeStdout } from "../render.js";
import type { CliContext } from "../types.js";

const VALID_FLOWS = new Set(["dev", "design", "analyze"]);

export const autoPlanDecideCommand: QtcCommand = {
  name: "auto-plan-decide",
  describe: "Decide plan scope (skip|lite|full) for an OBJETIVO. Optional --code|--flow honors doctrina analyze=skip.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const objetivo = await readObjetivoIfPresent(args);
    const options = await resolveOptions(args, ctx);
    const result = shouldSkipFullPlan(objetivo ?? "", options);
    writeStdout(`${stringifyWithFloatField(result, "eta_hours")}\n`);
    return { ok: true, exitCode: 0 };
  },
};

async function resolveOptions(args: ParsedArgs, ctx: CliContext): Promise<AutoPlanOptions> {
  const opts: AutoPlanOptions = {};

  const flowFromPlugin = args.plugin.flow;
  if (flowFromPlugin !== undefined && VALID_FLOWS.has(flowFromPlugin)) {
    opts.flow = flowFromPlugin;
  } else {
    const flowFromValues = args.values.get("flow");
    if (flowFromValues !== undefined && VALID_FLOWS.has(flowFromValues)) {
      opts.flow = flowFromValues;
    }
  }

  const modalidad = args.values.get("modalidad");
  if (modalidad !== undefined) opts.modalidad = modalidad;

  const projectBlock = await tryReadProjectBlock(ctx);

  const code = args.values.get("code");
  if (code !== undefined && opts.flow === undefined && projectBlock !== null) {
    const derived = deriveFlowFromBlock(code, projectBlock.sessions);
    if (derived !== null) opts.flow = derived;
  }

  if (projectBlock !== null && projectBlock.fuentes.length > 0) {
    opts.declaredAliases = projectBlock.fuentes.map((f) => f.alias);
  }

  return opts;
}

async function tryReadProjectBlock(ctx: CliContext): Promise<{
  sessions: { folder: string }[];
  fuentes: { alias: string }[];
} | null> {
  try {
    const read = await runProjectMdRead(ctx.fs, ctx.env, ctx.paths, {});
    if (!read.block) return null;
    return { sessions: read.block.sessions, fuentes: read.block.fuentes };
  } catch {
    return null;
  }
}

function deriveFlowFromBlock(code: string, sessions: { folder: string }[]): string | null {
  const padded = code.padStart(3, "0");
  for (const s of sessions) {
    if (s.folder.startsWith(`session${padded}-`)) {
      const parts = s.folder.split("-");
      const candidate = parts[1];
      if (candidate !== undefined && VALID_FLOWS.has(candidate)) return candidate;
    }
  }
  return null;
}

function stringifyWithFloatField(value: unknown, floatField: string): string {
  const json = JSON.stringify(value, null, 2);
  const re = new RegExp(`("${floatField}":\\s+)(-?\\d+)(,?)$`, "gm");
  return json.replace(re, "$1$2.0$3");
}
