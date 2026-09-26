import { hashContextId } from "../../src/application/session-binding-service.js";
import type { MemFs } from "./mem-fs.js";

/**
 * The association a conversation already holds, seeded the way the registry
 * stores it. A hook carries no `--code`, so this is how it resolves on its own.
 */
export function seedBinding<T extends MemFs>(
  fs: T,
  sessionsDir: string,
  contextId: string,
  folder: string,
): T {
  const bindings = { [hashContextId(contextId)]: folder };
  fs.file(`${sessionsDir}/.bindings.json`, `${JSON.stringify({ version: 1, bindings })}\n`);
  return fs;
}
