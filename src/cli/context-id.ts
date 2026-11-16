import type { Readable } from "node:stream";
import { text } from "node:stream/consumers";

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
 * checkpoint-write --code`, `aw hook post-compact`), so the read must be bounded.
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
 * stdin of a command that DECLARES it mandatory (the hybrid `prepare → validate
 * → apply` handshake): read to EOF with no window at all.
 *
 * The bounded read above exists because a hook may legitimately receive
 * nothing. Here the opposite holds: the payload is the whole point, and cutting
 * it off after a fixed window would hand the validator a truncated proposal
 * that its own digest would then seal as valid. A caller that pipes nothing
 * gets an empty string and fails validation, which is the correct answer.
 */
export async function readRequiredStdin(stdin: Readable = process.stdin): Promise<string> {
  if ((stdin as NodeJS.ReadStream).isTTY === true) return "";
  try {
    return await text(stdin);
  } catch {
    return "";
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
