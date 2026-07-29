import type { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { parseHookPayload } from "../application/hook-common.js";
import type { EnvPort } from "../ports/env.js";

/**
 * Neutral conversation-identity boundary.
 *
 * The core never interprets the id's format — it only needs an opaque, stable
 * value per host conversation. Two sources feed it: the agreed env var, and the
 * `session_id` every host already puts on a lifecycle hook's JSON stdin. Which
 * host injects what, and how, belongs to the multi-host surface work (spec 010).
 */
export const CONTEXT_ID_ENV = "AW_CONTEXT_ID";

export type ContextIdResolution =
  | { ok: true; contextId?: string }
  | { ok: false; code: "CONTEXT_ID_CONFLICT"; message: string };

/** The conversation id from the environment alone (non-hook invocations). */
export function readContextId(env: EnvPort): string | undefined {
  return nonEmpty(env.get(CONTEXT_ID_ENV));
}

/**
 * The single conversation identity for a lifecycle surface, from the env var
 * and/or the hook payload's `session_id`.
 *
 * Two signals that name DIFFERENT conversations is not something to arbitrate:
 * picking either one could checkpoint or restore the wrong line, so it fails
 * before any session is resolved.
 */
export function resolveContextId(env: EnvPort, stdin?: string): ContextIdResolution {
  const fromEnv = readContextId(env);
  const fromStdin = stdin !== undefined ? sessionIdFromPayload(stdin) : undefined;
  if (fromEnv !== undefined && fromStdin !== undefined && fromEnv !== fromStdin) {
    return {
      ok: false,
      code: "CONTEXT_ID_CONFLICT",
      message: `${CONTEXT_ID_ENV} y el session_id de stdin identifican conversaciones distintas; resolvé cuál corresponde antes de reintentar`,
    };
  }
  const contextId = fromEnv ?? fromStdin;
  return contextId !== undefined ? { ok: true, contextId } : { ok: true };
}

/**
 * How long to wait for a hook payload's first byte before concluding there is
 * none. A host writes the JSON into the pipe as it spawns the hook, so a real
 * payload is already there or arrives immediately; the window only elapses when
 * stdin is an open handle nobody writes to.
 */
const HOOK_STDIN_WINDOW_MS = 150;

/**
 * A lifecycle hook's JSON payload, or `undefined` when there is none.
 *
 * These commands are BOTH hook targets and hand/agent-invocable (`aw
 * checkpoint-write --code`, `aw resume-summary`), so the read must be bounded.
 * An interactive terminal is the easy case; the dangerous one is an inherited
 * stdin that is neither a TTY nor ever written to — an agent shell tool spawns
 * with a socket on fd 0, where `isTTY` is undefined and reading to EOF blocks
 * until the tool times out. So: wait a short window for the first byte, and
 * only then read to EOF (unbounded, so a large payload is never truncated).
 */
export async function readHookStdin(
  stdin: Readable = process.stdin,
  windowMs: number = HOOK_STDIN_WINDOW_MS,
): Promise<string | undefined> {
  if ((stdin as NodeJS.ReadStream).isTTY === true) return undefined;
  if (!(await waitForFirstByte(stdin, windowMs))) {
    // Release the handle so an abandoned read never holds the process open.
    stdin.pause();
    return undefined;
  }
  try {
    return await text(stdin);
  } catch {
    return undefined;
  }
}

/**
 * `true` as soon as stdin delivers anything. An immediate EOF (`< /dev/null`)
 * and an idle handle both answer `false` — they differ only in how fast.
 */
function waitForFirstByte(stdin: Readable, windowMs: number): Promise<boolean> {
  if (stdin.readableLength > 0) return Promise.resolve(true);
  if (stdin.readableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    const settle = (hasData: boolean): void => {
      clearTimeout(timer);
      stdin.off("readable", onReadable);
      stdin.off("end", onDone);
      stdin.off("error", onDone);
      resolve(hasData);
    };
    const onReadable = (): void => {
      if (stdin.readableLength > 0) settle(true);
    };
    const onDone = (): void => settle(false);
    // Deliberately NOT unref'd. This timer is the only thing guaranteeing the
    // promise settles when stdin is an idle handle: unref'd, the event loop
    // empties while nothing is pending and Node exits 0 before the command
    // ever writes its output.
    const timer = setTimeout(() => settle(false), windowMs);
    stdin.on("readable", onReadable);
    stdin.once("end", onDone);
    stdin.once("error", onDone);
  });
}

function sessionIdFromPayload(stdin: string): string | undefined {
  const payload = parseHookPayload(stdin);
  if (payload === null) return undefined;
  const raw = payload.session_id;
  return typeof raw === "string" ? nonEmpty(raw) : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}
