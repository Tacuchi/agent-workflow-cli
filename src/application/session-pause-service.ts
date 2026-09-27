import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import { upsertHistoryRow } from "./history-update-service.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { invalidateBindingsTo } from "./session-binding-service.js";
import { writeSessionNarrative } from "./session-narrative.js";
import {
  PAUSED_MARKER,
  readSessionState,
  resolveSessionTarget,
  sessionNumericCode,
} from "./session-resolver.js";

/** Pause is a user action: no loop implicitly changes this state. */
export async function runSessionPause(
  fs: FileSystemPort,
  paths: PathsService,
  code?: string,
): Promise<{ folder: string; state: "paused" } | { error: string; code: string }> {
  if (!code) return { error: "--code es obligatorio", code: "INVALID_INPUT" };
  const resolved = await resolveSessionTarget(fs, paths, {
    code,
    intent: "write",
    allowClosed: true,
  });
  if (resolved.outcome !== "resolved") return { error: resolved.message, code: resolved.code };
  const session = resolved.session;
  if (session.state !== "active" && session.state !== "paused") {
    return {
      error: `la sesión ${session.folder} ya está ${session.state}`,
      code: "SESSION_NOT_ACTIVE",
    };
  }
  const locked = await withCwdLock(fs, paths, async () => {
    const state = await readSessionState(fs, session.path);
    if (state !== "active" && state !== "paused") {
      return { error: `la sesión ${session.folder} pasó a ${state}`, code: "SESSION_NOT_ACTIVE" };
    }
    const invalidated = await invalidateBindingsTo(fs, paths, session.folder);
    if (!invalidated.ok) return { error: invalidated.reason, code: "SESSION_BINDING_INVALID" };
    await fs.writeText(join(session.path, PAUSED_MARKER), "");
    await upsertHistoryRow(fs, paths, {
      code: sessionNumericCode(session.folder) ?? session.folder,
      sesionName: session.name,
      state: "paused",
    });
    return { folder: session.folder, state: "paused" as const };
  });
  if ("error" in locked)
    return { error: locked.error, code: "code" in locked ? locked.code : "LOCK_BUSY" };
  await writeSessionNarrative(fs, paths, { folder: session.folder, path: session.path });
  return locked;
}
