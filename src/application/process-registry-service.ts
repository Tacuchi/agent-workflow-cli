import { dirname } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ProcessPort } from "../ports/process.js";
import { LockBusyError, type LockHandle, acquireLock } from "./lock-service.js";

/** Lifecycle state of a registered detached process. */
export type ProcessState = "running" | "exited" | "stopped";

/** One detached source process tracked in `.workflow/processes.json`. */
export interface ProcessRecord {
  /** Stable id within the registry: `<alias>__<profile>__<pid>`. */
  id: string;
  sourceAlias: string;
  profile: string | null;
  command: string;
  args: string[];
  pid: number;
  /** ISO timestamp of when the launch was registered. */
  startedAt: string;
  /** Absolute path to the per-process log file. */
  logPath: string;
  /** Non-secret param values entered at launch, so a relaunch reuses them (secrets never persisted). */
  values?: Record<string, string>;
  /** How it was launched: "terminal" (visible window) or "background" (detached + log fallback). Absent = legacy background. */
  launchMode?: "terminal" | "background";
  state: ProcessState;
}

/** Fields the caller supplies when registering a launch (id/state are derived). */
export type ProcessRegistration = Omit<ProcessRecord, "id" | "state">;

function recordId(alias: string, profile: string | null, pid: number): string {
  return `${alias}__${profile ?? "default"}__${pid}`;
}

/**
 * How long a registry mutation waits for the workspace lock.
 *
 * `register` runs AFTER the process is already spawned, so failing fast would
 * leave a live process nobody tracks. The critical section is a small JSON
 * rewrite, so waiting absorbs the concurrency of two flows launching at once.
 */
const REGISTRY_LOCK_WAIT_MS = 5_000;

/**
 * Persistent registry of detached source processes, backed by a JSON array on
 * disk (`.workflow/processes.json`). `list()` reconciles each record against
 * live OS state (via `ProcessPort.isAlive`) before returning, and persists the
 * reconciled snapshot so the file stays honest across TUI restarts.
 *
 * A corrupt/unreadable registry degrades to empty rather than crashing callers
 * (the TUI must keep working).
 */
export class ProcessRegistryService {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly proc: ProcessPort,
    private readonly filePath: string,
    /**
     * Workspace lock that serializes the read-modify-write. `null` leaves the
     * registry unserialized — only for callers that own no workspace (tests over
     * a bare temp dir).
     */
    private readonly lockPath: string | null = null,
  ) {}

  private async read(): Promise<ProcessRecord[]> {
    if (!(await this.fs.exists(this.filePath))) return [];
    try {
      const raw = await this.fs.readText(this.filePath);
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ProcessRecord[]) : [];
    } catch {
      // Corrupt registry → degrade to empty (best-effort; never brick the TUI).
      return [];
    }
  }

  private async write(records: ProcessRecord[]): Promise<void> {
    await this.fs.mkdirp(dirname(this.filePath));
    await this.fs.writeText(this.filePath, `${JSON.stringify(records, null, 2)}\n`);
  }

  /**
   * Read-modify-write serialized by the workspace lock.
   *
   * The read has to happen INSIDE the lock, which is why `apply` receives the
   * records instead of the caller reading them first: two flows launching at the
   * same moment used to read the same array and write back their own copy of it,
   * so whoever wrote second erased the other's process — the registry then showed
   * one launch and the machine ran two.
   *
   * `apply` returning `null` means "nothing to write" and skips the write.
   */
  private async mutate(
    apply: (records: ProcessRecord[]) => Promise<ProcessRecord[] | null>,
  ): Promise<ProcessRecord[]> {
    const run = async () => {
      const records = await this.read();
      const next = await apply(records);
      if (next === null) return records;
      await this.write(next);
      return next;
    };
    if (this.lockPath === null) return run();
    let lock: LockHandle;
    try {
      lock = await acquireLock(this.lockPath, this.fs, { waitMs: REGISTRY_LOCK_WAIT_MS });
    } catch (err) {
      // ONLY a busy lock becomes this message. Catching everything here would
      // report "another flow is holding it" for a broken filesystem or a bad
      // path — a diagnosis nobody could act on, about a flow that never existed.
      if (!(err instanceof LockBusyError)) throw err;
      // The holder is alive and still working past the budget. Writing anyway is
      // exactly the lost update the lock exists to prevent, so the caller hears
      // about it instead of getting a registry that quietly dropped a process.
      throw new Error(
        `el registro de procesos está bloqueado por otro flujo (${this.lockPath}); reintentá en unos segundos`,
      );
    }
    try {
      return await run();
    } finally {
      await lock.release();
    }
  }

  /** Register a freshly launched process as `running`. Returns the stored record. */
  async register(reg: ProcessRegistration): Promise<ProcessRecord> {
    const record: ProcessRecord = {
      ...reg,
      id: recordId(reg.sourceAlias, reg.profile, reg.pid),
      state: "running",
    };
    // A recycled pid could collide with a stale record id — replace it.
    await this.mutate(async (records) => [...records.filter((r) => r.id !== record.id), record]);
    return record;
  }

  /**
   * Return all records with their state reconciled against live OS state:
   * `running` records whose pid is no longer alive become `exited`; `stopped`
   * and `exited` records are sticky. Persists the reconciled snapshot.
   *
   * The lock is taken only when the reconciliation actually has something to
   * write: `list()` is the TUI's refresh path and the steady state is a no-op.
   */
  async list(): Promise<ProcessRecord[]> {
    const records = await this.read();
    const reconciled = await this.reconcile(records);
    if (!differs(records, reconciled)) return reconciled;
    return this.mutate(async (fresh) => {
      const next = await this.reconcile(fresh);
      return differs(fresh, next) ? next : null;
    });
  }

  private async reconcile(records: ProcessRecord[]): Promise<ProcessRecord[]> {
    return Promise.all(
      records.map(async (r) => {
        if (r.state !== "running") return r;
        const alive = await this.proc.isAlive(r.pid);
        return alive ? r : { ...r, state: "exited" as ProcessState };
      }),
    );
  }

  /** Mark a record as deliberately stopped (sticky; survives reconciliation). */
  async markStopped(id: string): Promise<void> {
    await this.mutate(async (records) => {
      let touched = false;
      const next = records.map((r) => {
        if (r.id === id && r.state !== "stopped") {
          touched = true;
          return { ...r, state: "stopped" as ProcessState };
        }
        return r;
      });
      return touched ? next : null;
    });
  }

  /** Drop a record from the registry entirely. */
  async remove(id: string): Promise<void> {
    await this.mutate(async (records) => {
      const next = records.filter((r) => r.id !== id);
      return next.length !== records.length ? next : null;
    });
  }
}

/** Whether the reconciliation changed any record's state. */
function differs(before: ProcessRecord[], after: ProcessRecord[]): boolean {
  return after.some((r, i) => r.state !== before[i]?.state);
}
