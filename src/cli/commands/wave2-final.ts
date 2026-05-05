import { runCheckBranch } from "../../application/check-branch-service.js";
import {
  runCheckpointRead,
  runCompressCheckpoint,
  runResumeSummary,
} from "../../application/checkpoint-service.js";
import { runPhaseNext } from "../../application/phase-next-service.js";
import { runSources } from "../../application/sources-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const sourcesCommand: QtcCommand = {
  name: "sources",
  describe: "List sources from QTC-PROJECT block with git status enrichment.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const session = args.values.get("session");
    const scopeRaw = args.values.get("scope");
    const skipGit = args.flags.has("--no-git");
    const flow = args.values.get("flow");
    const verbose = args.flags.has("--verbose");
    const input: Parameters<typeof runSources>[4] = {};
    if (session !== undefined) input.sessionCode = session;
    if (scopeRaw !== undefined) {
      input.scope = scopeRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    if (skipGit) input.skipGit = true;
    if (flow !== undefined) input.flowOverride = flow;
    if (verbose) input.verbose = true;
    const data = await runSources(ctx.fs, ctx.env, ctx.git, ctx.paths, input);
    return { ok: true, data, exitCode: 0 };
  },
};

export const checkpointReadCommand: QtcCommand = {
  name: "checkpoint-read",
  describe: "Read CHECKPOINT.md of the active (or --code) session.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const data = await runCheckpointRead(ctx.fs, ctx.env, ctx.paths, code);
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

export const resumeSummaryCommand: QtcCommand = {
  name: "resume-summary",
  describe: "Compact resume payload for PostCompact hook.",
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runResumeSummary(ctx.fs, ctx.env, ctx.paths);
    return { ok: true, data, exitCode: 0 };
  },
};

export const compressCheckpointCommand: QtcCommand = {
  name: "compress-checkpoint",
  describe: "Identify long artifacts that should be compressed (HALLAZGOS/EVIDENCIA/...).",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const thresholdRaw = args.values.get("threshold");
    const options: Parameters<typeof runCompressCheckpoint>[3] = {};
    if (code !== undefined) options.code = code;
    if (thresholdRaw !== undefined) {
      const n = Number.parseInt(thresholdRaw, 10);
      if (Number.isFinite(n)) options.threshold = n;
    }
    const data = await runCompressCheckpoint(ctx.fs, ctx.env, ctx.paths, options);
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

export const phaseNextCommand: QtcCommand = {
  name: "phase-next",
  describe: "Advance session phase to the next slot in the lifecycle.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const data = await runPhaseNext(ctx.fs, ctx.env, ctx.paths, code);
    if ("error" in data) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: data.error },
        data,
        exitCode: 1,
      };
    }
    // Python emits 2 JSON objects when phase actually advances (project-md-upsert + phase-next).
    if (data.projectMd) {
      const { writeStdout } = await import("../render.js");
      writeStdout(`${JSON.stringify(data.projectMd, null, 2)}\n`);
    }
    return { ok: true, data: data.phaseNext, exitCode: 0 };
  },
};

export const checkBranchCommand: QtcCommand = {
  name: "check-branch",
  describe: "Verify a source branch vs expected work branch.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const alias = args.values.get("source");
    const pathArg = args.values.get("path");
    const fileArg = args.values.get("file");
    const session = args.values.get("session");
    const flow = args.values.get("flow");
    const strict = args.flags.has("--strict");

    const input: Parameters<typeof runCheckBranch>[4] = {};
    if (alias !== undefined) input.alias = alias;
    if (pathArg !== undefined) input.pathArg = pathArg;
    if (fileArg !== undefined) input.fileArg = fileArg;
    if (session !== undefined) input.sessionCode = session;
    if (flow !== undefined) input.flowOverride = flow;
    if (strict) input.strict = true;

    const data = await runCheckBranch(ctx.fs, ctx.env, ctx.git, ctx.paths, input);
    const exit: 0 | 1 | 2 = strict && data.match === false ? 2 : 0;
    return { ok: true, data, exitCode: exit };
  },
};
