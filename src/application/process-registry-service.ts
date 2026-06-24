import { dirname } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ProcessPort } from "../ports/process.js";

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
  state: ProcessState;
}

/** Fields the caller supplies when registering a launch (id/state are derived). */
export type ProcessRegistration = Omit<ProcessRecord, "id" | "state">;

function recordId(alias: string, profile: string | null, pid: number): string {
  return `${alias}__${profile ?? "default"}__${pid}`;
}

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

  /** Register a freshly launched process as `running`. Returns the stored record. */
  async register(reg: ProcessRegistration): Promise<ProcessRecord> {
    const records = await this.read();
    const record: ProcessRecord = {
      ...reg,
      id: recordId(reg.sourceAlias, reg.profile, reg.pid),
      state: "running",
    };
    // A recycled pid could collide with a stale record id — replace it.
    const next = records.filter((r) => r.id !== record.id);
    next.push(record);
    await this.write(next);
    return record;
  }

  /**
   * Return all records with their state reconciled against live OS state:
   * `running` records whose pid is no longer alive become `exited`; `stopped`
   * and `exited` records are sticky. Persists the reconciled snapshot.
   */
  async list(): Promise<ProcessRecord[]> {
    const records = await this.read();
    const reconciled = await Promise.all(
      records.map(async (r) => {
        if (r.state !== "running") return r;
        const alive = await this.proc.isAlive(r.pid);
        return alive ? r : { ...r, state: "exited" as ProcessState };
      }),
    );
    // Only rewrite when the reconciliation actually changed something.
    const changed = reconciled.some((r, i) => r.state !== records[i]?.state);
    if (changed) await this.write(reconciled);
    return reconciled;
  }

  /** Mark a record as deliberately stopped (sticky; survives reconciliation). */
  async markStopped(id: string): Promise<void> {
    const records = await this.read();
    let touched = false;
    const next = records.map((r) => {
      if (r.id === id && r.state !== "stopped") {
        touched = true;
        return { ...r, state: "stopped" as ProcessState };
      }
      return r;
    });
    if (touched) await this.write(next);
  }

  /** Drop a record from the registry entirely. */
  async remove(id: string): Promise<void> {
    const records = await this.read();
    const next = records.filter((r) => r.id !== id);
    if (next.length !== records.length) await this.write(next);
  }
}
