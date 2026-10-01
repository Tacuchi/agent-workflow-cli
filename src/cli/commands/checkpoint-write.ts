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
 * not know swallows the token after it — and the contract lists it as retired,
 * so it is accepted and means nothing here.
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

/** `aw checkpoint-write --code`: what agents call to persist a session's CHECKPOINT. */
export const checkpointWriteCommand: CliCommand = {
  name: "checkpoint-write",
  flags: { known: ["code", "force"], retired: ["can-pause"], mode: "warn" },
  help: {
    purpose:
      "Write CHECKPOINT.md for the named or conversation-bound session, never holding a compaction back. The host's PreCompact hook runs the same write as aw hook pre-compact.",
    flags: {
      code: {
        value: "<code>",
        effect: "Session to checkpoint; defaults to the one bound to this conversation.",
      },
      force: { effect: "Overwrite an existing CHECKPOINT.md that already has content." },
    },
    output:
      '{session, checkpoint_path, lines_written?, progress_pct?, tasks_open?, tasks_closed?, files_touched_count?, skipped?, preserved?, reason?}; degraded: {skipped: true, reason, continuity: "degraded", primary_session: null, active_sessions[], candidates[], action, refuge_path, refuges_swept?}.',
    notes: [
      "Never falls back to the sole active session on its own. With no resolvable session it still exits 0 and, when a session is active, parks a refuge checkpoint naming the active ones; the degradation is reported on stderr. The conversation id comes from the environment or the hook payload session_id on stdin; if they contradict each other it fails.",
    ],
  },
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
    if ("continuity" in data) writeStderr(degradedNotice("la compactación", data));
    return { ok: true, data, exitCode: 0 };
  },
};

/** `aw hook pre-compact`: the PreCompact target, the same write as `checkpoint-write`. */
export const preCompactHook: CliCommand = {
  ...checkpointWriteCommand,
  name: "hook pre-compact",
  help: {
    ...checkpointWriteCommand.help,
    purpose:
      "PreCompact hook target: write CHECKPOINT.md for the named or conversation-bound session, never holding a compaction back.",
  },
};

function degradedNotice(
  event: string,
  data: Pick<CheckpointWriteDegraded, "reason" | "refuge_path">,
): string {
  const refuge = data.refuge_path !== null ? ` — refugio: ${data.refuge_path}` : "";
  return `${event} continúa sin checkpoint: ${data.reason}${refuge}\n`;
}

/** `aw hook session-end`: the SessionEnd target, dispatched by `aw hook`. */
export const sessionEndHook: CliCommand = {
  name: "hook session-end",
  flags: { known: ["code"], retired: ["can-pause"], mode: "warn" },
  help: {
    purpose:
      "SessionEnd hook target: checkpoint the named or conversation-bound session, and only that one.",
    flags: {
      code: {
        value: "<code>",
        effect: "Session to checkpoint; defaults to the one bound to this conversation.",
      },
    },
    output:
      "{checkpoints_written[] ({session?, checkpoint_path?, progress_pct?, skipped?, preserved?, reason?, error?, refuge_adopted?}), continuity?, primary_session?, reason?, candidates?, action?, refuge_path?, refuges_swept?}.",
    notes: [
      "Always exits 0. When no session resolves it parks a refuge checkpoint and reports the degradation on stderr.",
    ],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const base = await lifecycleOptions(args, ctx);
    if ("failure" in base) return base.failure;
    const data = await runAutoCompactOnClose(ctx.fs, ctx.env, ctx.git, ctx.paths, base);
    // Same channel as PreCompact: stderr is what the host shows a person.
    if (data.continuity === "degraded") {
      writeStderr(
        degradedNotice("el cierre", {
          reason: data.reason ?? "",
          refuge_path: data.refuge_path ?? null,
        }),
      );
    }
    return { ok: true, data, exitCode: 0 };
  },
};
