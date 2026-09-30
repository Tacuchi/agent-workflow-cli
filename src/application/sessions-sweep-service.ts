import { join, relative } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import { sweepRefuges } from "./checkpoint-write-service.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { invalidateBindingsTo, readBindingRegistry } from "./session-binding-service.js";
import { listSessionFolders, readSessionState } from "./session-resolver.js";

export interface SessionSweepOutput {
  applied: boolean;
  locks: string[];
  attempts: string[];
  bindings: string[];
  refuges: string[];
}

/** Sweep only terminal or missing session runtime state; active and paused work survives. */
export async function runSessionsSweep(
  fs: FileSystemPort,
  paths: PathsService,
  apply = false,
): Promise<SessionSweepOutput | { error: string }> {
  const scan = async (): Promise<SessionSweepOutput> => {
    const folders = await listSessionFolders(fs, paths.cwdSessionsDir());
    const present = new Map(folders.map((folder) => [folder.name, folder.path]));
    const terminal = new Set<string>();
    const locks: string[] = [];
    for (const folder of folders) {
      const state = await readSessionState(fs, folder.path);
      if (state !== "closed" && state !== "abandoned") continue;
      terminal.add(folder.name);
      const lock = join(folder.path, ".flow-run.json.lock");
      if (await fs.exists(lock)) locks.push(relative(paths.workspaceDir(), lock));
    }
    const attempts = await terminalAttempts(fs, paths, terminal, present);
    const registry = await readBindingRegistry(fs, paths);
    if (!registry.ok) throw new Error(registry.reason);
    const bindings = [
      ...new Set(
        Object.values(registry.registry.bindings).filter((folder) => !present.has(folder)),
      ),
    ].sort();
    const refuges = await sweepRefuges(fs, paths, new Date(), apply);
    if (apply) await removeTerminalState(fs, paths, locks, attempts, bindings);
    return { applied: apply, locks, attempts, bindings, refuges };
  };
  const outcome = apply ? await withCwdLock(fs, paths, scan) : await scan();
  if ("error" in outcome) return outcome;
  return outcome;
}

async function terminalAttempts(
  fs: FileSystemPort,
  paths: PathsService,
  terminal: Set<string>,
  present: Map<string, string>,
): Promise<string[]> {
  const attempts: string[] = [];
  if (await fs.exists(paths.cwdFlowAttemptsDir())) {
    for (const file of await fs.list(paths.cwdFlowAttemptsDir())) {
      if (file.type !== "file" || !file.name.endsWith(".json")) continue;
      const folder = file.name.slice(0, -".json".length);
      if (terminal.has(folder) || !present.has(folder))
        attempts.push(relative(paths.workspaceDir(), file.path));
    }
  }
  return attempts;
}

async function removeTerminalState(
  fs: FileSystemPort,
  paths: PathsService,
  locks: string[],
  attempts: string[],
  bindings: string[],
): Promise<void> {
  for (const file of [...locks, ...attempts]) await fs.remove(join(paths.workspaceDir(), file));
  for (const folder of bindings) {
    const cleared = await invalidateBindingsTo(fs, paths, folder);
    if (!cleared.ok) throw new Error(cleared.reason);
  }
}
