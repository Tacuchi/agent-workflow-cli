import { runPhaseDetect } from "../../application/phase-detect-service.js";
import { runSkillIndex } from "../../application/skill-index-service.js";
import { runStack } from "../../application/stack-service.js";
import { runWorkspaceMode } from "../../application/workspace-mode-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const stackCommand: QtcCommand = {
  name: "stack",
  describe: "Detect stack of the project (language/framework/db/build).",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const projectDir = args.values.get("project-dir");
    const data = await runStack(ctx.fs, ctx.env, projectDir !== undefined ? { projectDir } : {});
    return { ok: true, data, exitCode: 0 };
  },
};

export const workspaceModeCommand: QtcCommand = {
  name: "workspace-mode",
  describe: "Read workspace mode (project|hub) + sources + working branches.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const verbose = args.flags.has("--verbose");
    const data = await runWorkspaceMode(ctx.fs, ctx.env, ctx.paths, { verbose });
    return { ok: true, data, exitCode: 0 };
  },
};

export const skillIndexCommand: QtcCommand = {
  name: "skill-index",
  describe: "Lazy-load skill index (frontmatter only).",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const pluginRoot = args.plugin.pluginRoot ?? args.values.get("plugin-root");
    const flow = args.plugin.flow ?? args.values.get("flow");
    const exportedOnly = args.flags.has("--exported-only");
    const input: Parameters<typeof runSkillIndex>[2] = {};
    if (pluginRoot !== undefined) input.pluginRoot = pluginRoot;
    if (flow !== undefined) input.flow = flow;
    if (exportedOnly) input.exportedOnly = true;
    const data = await runSkillIndex(ctx.fs, ctx.env, input);
    return { ok: true, data, exitCode: 0 };
  },
};

export const phaseDetectCommand: QtcCommand = {
  name: "phase-detect",
  describe: "Suggest current session phase from artifacts (no mutation).",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const data = await runPhaseDetect(ctx.fs, ctx.env, ctx.paths, code);
    if ("error" in data) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: data.error },
        data,
        exitCode: 1,
      };
    }
    return { ok: true, data, exitCode: 0 };
  },
};

export const workflowsCommand: QtcCommand = {
  name: "workflows",
  describe: "Dump registered specialty workflows (empty when no flow plugin loaded).",
  async execute(args: ParsedArgs): Promise<CommandResult> {
    const targetFlow = args.values.get("flow");
    if (targetFlow !== undefined) {
      return {
        ok: true,
        data: {
          error: `Workflow no registrado para flow=${pythonRepr(targetFlow)}`,
          registered_flows: [],
        },
        exitCode: 0,
      };
    }
    return {
      ok: true,
      data: {
        registered_flows: [],
        count: 0,
        workflows: [],
      },
      exitCode: 0,
    };
  },
};

function pythonRepr(s: string): string {
  return `'${s}'`;
}
