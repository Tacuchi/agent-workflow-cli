import { join, relative } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ProcessPort } from "../ports/process.js";
import { sweepRefuges } from "./checkpoint-write-service.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { type ProcessRecord, ProcessRegistryService } from "./process-registry-service.js";
import { invalidateBindingsTo, readBindingRegistry } from "./session-binding-service.js";
import { listSessionFolders, readSessionState } from "./session-resolver.js";

export interface SessionSweepOutput {
  applied: boolean;
  locks: string[];
  attempts: string[];
  processes: string[];
  bindings: string[];
  refuges: string[];
}

/** Sweep only terminal or missing session runtime state; active and paused work survives. */
export async function runSessionsSweep(
  fs: FileSystemPort,
  paths: PathsService,
  apply = false,
  process?: ProcessPort,
): Promise<SessionSweepOutput | { error: string }> {
  if (apply && process === undefined) {
    return {
      error: "el barrido requiere acceso al registro de procesos para aplicar todos los residuos",
    };
  }
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
    const attempts: string[] = [];
    if (await fs.exists(paths.cwdFlowAttemptsDir())) {
      for (const file of await fs.list(paths.cwdFlowAttemptsDir())) {
        if (file.type !== "file" || !file.name.endsWith(".json")) continue;
        const folder = file.name.slice(0, -".json".length);
        if (terminal.has(folder) || !present.has(folder))
          attempts.push(relative(paths.workspaceDir(), file.path));
      }
    }
    const registry = await readBindingRegistry(fs, paths);
    if (!registry.ok) throw new Error(registry.reason);
    const bindings = [
      ...new Set(
        Object.values(registry.registry.bindings).filter((folder) => !present.has(folder)),
      ),
    ].sort();
    const processFile = paths.cwdProcessesFile();
    let processRows: ProcessRecord[] = [];
    if (await fs.exists(processFile)) {
      const parsed: unknown = JSON.parse(await fs.readText(processFile));
      if (!Array.isArray(parsed)) throw new Error("processes.json no es una lista");
      processRows = parsed as ProcessRecord[];
    }
    const processes = processRows
      .filter((record) => record.state === "exited")
      .map((record) => record.id);
    const refuges = await sweepRefuges(fs, paths, new Date(), apply);
    if (apply) {
      for (const file of [...locks, ...attempts]) await fs.remove(join(paths.workspaceDir(), file));
      for (const folder of bindings) {
        const cleared = await invalidateBindingsTo(fs, paths, folder);
        if (!cleared.ok) throw new Error(cleared.reason);
      }
    }
    return { applied: apply, locks, attempts, processes, bindings, refuges };
  };
  const outcome = apply ? await withCwdLock(fs, paths, scan) : await scan();
  if ("error" in outcome) return outcome;
  if (apply && process) {
    const registry = new ProcessRegistryService(
      fs,
      process,
      paths.cwdProcessesFile(),
      paths.cwdLockFile(),
    );
    for (const id of outcome.processes) await registry.remove(id);
  }
  return outcome;
}
