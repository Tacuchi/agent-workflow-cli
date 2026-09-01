import {
  type CheckpointWriteDegraded,
  type CheckpointWriteOptions,
  runAutoCompactOnClose,
  runCheckpointWrite,
} from "../../application/checkpoint-write-service.js";
import type { LifecycleOptions } from "../../application/lifecycle-target.js";
import type { CommandResult } from "../../domain/types.js";
import { readHookStdin, resolveContextId } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail, writeStderr } from "../render.js";
import type { CliContext } from "../types.js";

/**
 * Common lifecycle inputs: the explicit target and the conversation id (env var
 * or the hook payload's `session_id`, whichever the host provides). Two identity
 * signals that contradict each other surface as a failure instead of resolving
 * a session.
 *
 * `--can-pause` is deliberately NOT read. It used to declare that the host could
 * hold its compaction, and the hooks already installed on people's machines
 * still pass it; it stays in the parser's boolean flags — a flag the parser does
 * not know swallows the token after it — and means nothing here.
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
  };
}

export const checkpointWriteCommand: CliCommand = {
  name: "checkpoint-write",
  describe:
    "Write CHECKPOINT.md for the conversation's session (or --code). PreCompact hook target: " +
    "it NEVER holds a compaction back — with no resolvable session it parks a refuge " +
    "checkpoint and exits 0. An existing CHECKPOINT with content is preserved; --force " +
    "overwrites it. Usage: aw checkpoint-write [--code <session>] [--force].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const base = await lifecycleOptions(args, ctx);
    if ("failure" in base) return base.failure;

    const options: CheckpointWriteOptions = { ...base };
    if (args.flags.has("--force")) options.force = true;

    const data = await runCheckpointWrite(ctx.fs, ctx.env, ctx.git, ctx.paths, options);
    // Exit 0 whatever happened. A non-zero exit is how a host holds its
    // compaction, and holding it was irrecoverable from inside the conversation
    // — the ambiguity the notice asked to fix came back on the next attempt.
    // The host shows a person only stderr here (the stdout envelope stays
    // machine-facing), so what degraded and where the state went goes there.
    if ("continuity" in data) writeStderr(degradedNotice(data));
    return { ok: true, data, exitCode: 0 };
  },
};

function degradedNotice(data: CheckpointWriteDegraded): string {
  const refuge = data.refuge_path !== null ? ` — refugio: ${data.refuge_path}` : "";
  return `compactación continúa sin checkpoint: ${data.reason}${refuge}\n`;
}

export const autoCompactOnCloseCommand: CliCommand = {
  name: "auto-compact-on-close",
  describe: "SessionEnd hook target — checkpoint the conversation's session, and only that one.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const base = await lifecycleOptions(args, ctx);
    if ("failure" in base) return base.failure;
    const data = await runAutoCompactOnClose(ctx.fs, ctx.env, ctx.git, ctx.paths, base);
    return { ok: true, data, exitCode: 0 };
  },
};
