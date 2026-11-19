import type { Readable } from "node:stream";
import { text } from "node:stream/consumers";

/**
 * stdin of a command that DECLARES it mandatory (the hybrid `prepare → validate
 * → apply` handshake): read to EOF with no window at all.
 *
 * The payload is the whole point, and cutting it off after a fixed window
 * would hand the validator a truncated proposal that its own digest would then
 * seal as valid. A caller that pipes nothing
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
