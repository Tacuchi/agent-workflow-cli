import {
  type CheckpointWriteOptions,
  runAutoCompactOnClose,
  runCheckpointWrite,
} from "../../application/checkpoint-write-service.js";
import type { LifecycleOptions } from "../../application/lifecycle-target.js";
import type { CommandResult } from "../../domain/types.js";
import { readHookStdin, resolveContextId } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail, failSessionResolution } from "../render.js";
import type { CliContext } from "../types.js";

/**
 * Common lifecycle inputs: the explicit target, the conversation id (env var or
 * the hook payload's `session_id`, whichever the host provides), and whether the
 * host declared it can hold its compaction. Two identity signals that contradict
 * each other surface as a failure instead of resolving a session.
 */
async function lifecycleOptions(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<LifecycleOptions | { failure: CommandResult }> {
  const context = resolveContextId(ctx.env, await readHookStdin());
  if (!context.ok) return { failure: fail(context.code, context.message) };
  const code = args.values.get("code");
  return {
    ...(code !== undefined ? { code } : {}),
    ...(context.contextId !== undefined ? { contextId: context.contextId } : {}),
    // Never inferred: a host that cannot pause would get false blocks.
    ...(args.flags.has("--can-pause") ? { canPauseCompaction: true } : {}),
  };
}

export const checkpointWriteCommand: QtcCommand = {
  name: "checkpoint-write",
  describe:
    "Write CHECKPOINT.md for the conversation's session (or --code). PreCompact hook target. " +
    "Usage: aw checkpoint-write [--code <session>] [--force] [--can-pause].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const base = await lifecycleOptions(args, ctx);
    if ("failure" in base) return base.failure;

    const options: CheckpointWriteOptions = { ...base };
    if (args.flags.has("--force")) options.force = true;

    const data = await runCheckpointWrite(ctx.fs, ctx.env, ctx.git, ctx.paths, options);
    // Pausable host: exit 2 is the host-level "hold the compaction" signal, and
    // the envelope carries the candidates the human picks from.
    if ("blocked" in data) {
      return { ...failSessionResolution(data.sessionError), exitCode: 2 };
    }
    return { ok: true, data, exitCode: 0 };
  },
};

export const autoCompactOnCloseCommand: QtcCommand = {
  name: "auto-compact-on-close",
  describe: "SessionEnd hook target — checkpoint the conversation's session, and only that one.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const base = await lifecycleOptions(args, ctx);
    if ("failure" in base) return base.failure;
    const data = await runAutoCompactOnClose(ctx.fs, ctx.env, ctx.git, ctx.paths, base);
    return { ok: true, data, exitCode: 0 };
  },
};
