import { join, relative } from "node:path";
import type { Flow, Phase, SessionState } from "../domain/types.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { firstNonEmptyLine, parseMdSection, parseMdValue } from "./markdown.js";

export const KNOWN_FLOWS: ReadonlyArray<Flow> = ["core", "dev", "design", "analyze"];
const SESSION_FOLDER_RE = /^session(\d{3})-(.+)$/;

export interface SessionEntry {
  code: string | null;
  flow: Flow | null;
  name: string;
  folder: string;
  path: string;
  state: SessionState;
  phase: Phase | "requirement";
  date?: string;
  summary?: string;
  branch?: string;
  legacy_source?: string;
}

export interface ListSessionsInput {
  includeLegacy?: boolean;
  state?: SessionState | "all";
  verbose?: boolean;
}

export interface ListSessionsOutput {
  sessions: SessionEntry[];
  active_count: number;
  closed_count: number;
  total_count: number;
  next_correlative: string;
  legacy?: SessionEntry[];
  history_exists?: boolean;
}

export class SessionsService {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly env: EnvPort,
  ) {}

  async list(input: ListSessionsInput = {}): Promise<ListSessionsOutput> {
    const cwd = this.env.cwd();
    const sessionsDir = join(cwd, ".qtc", "sessions");
    const sessions = await this.scanFolder(sessionsDir, undefined, cwd, input.verbose === true);

    const legacyEntries: SessionEntry[] = [];
    if (input.includeLegacy === true) {
      for (const prefix of [".claude", ".codex"] as const) {
        const dir = join(cwd, prefix, "sessions");
        const entries = await this.scanFolder(dir, prefix, cwd, input.verbose === true);
        legacyEntries.push(...entries);
      }
    }

    const qtcCodes = new Set(sessions.map((s) => s.code).filter((c): c is string => c !== null));
    const legacy = legacyEntries.filter((l) => l.code === null || !qtcCodes.has(l.code));

    const numericCodes = sessions
      .map((s) => s.code)
      .filter((c): c is string => c !== null && /^\d+$/.test(c))
      .map((c) => Number.parseInt(c, 10));
    const nextCorr =
      numericCodes.length > 0 ? String(Math.max(...numericCodes) + 1).padStart(3, "0") : "001";

    const activeCount = sessions.filter((s) => s.state === "active").length;
    const closedCount = sessions.filter((s) => s.state === "closed").length;

    const filtered = this.applyFilter(sessions, input);

    const payload: ListSessionsOutput = {
      sessions: filtered,
      active_count: activeCount,
      closed_count: closedCount,
      total_count: sessions.length,
      next_correlative: nextCorr,
    };

    if (input.includeLegacy === true || legacy.length > 0) {
      payload.legacy = legacy;
    }
    if (input.verbose === true) {
      payload.history_exists = await this.fs.exists(join(cwd, ".qtc", "HISTORY.md"));
    }

    return payload;
  }

  private async scanFolder(
    dir: string,
    legacySource: string | undefined,
    cwd: string,
    verbose: boolean,
  ): Promise<SessionEntry[]> {
    if (!(await this.fs.exists(dir))) {
      return [];
    }
    const entries = await this.fs.list(dir);
    const sessionDirs = entries
      .filter((e) => e.type === "dir" && SESSION_FOLDER_RE.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const result: SessionEntry[] = [];
    for (const entry of sessionDirs) {
      result.push(await this.buildEntry(entry.path, entry.name, legacySource, cwd, verbose));
    }
    return result;
  }

  private async buildEntry(
    sessionPath: string,
    folder: string,
    legacySource: string | undefined,
    cwd: string,
    verbose: boolean,
  ): Promise<SessionEntry> {
    const { code, flow, name } = parseSessionFolder(folder);

    const status = await this.readStatus(sessionPath);
    const hasStatus = status !== null;
    const state: SessionState = status?.state ?? "active";
    const phase: Phase | "requirement" = status?.phase ?? "requirement";

    const requirement = await this.readRequirement(sessionPath);
    const date = requirement.date ?? (await this.mtimeAsDate(sessionPath));
    const summary = requirement.summary ?? (name ? name.replace(/-/g, " ") : folder);

    if (!verbose) {
      const compact: SessionEntry = {
        code,
        flow,
        name,
        folder,
        path: relativeToCwd(sessionPath, cwd),
        state,
        phase,
        ...(date ? { date } : {}),
        summary,
        ...(requirement.branch ? { branch: requirement.branch } : {}),
        ...(legacySource ? { legacy_source: legacySource } : {}),
      };
      return compact;
    }

    const verboseEntry: SessionEntry & { has_status: boolean } = {
      code,
      flow,
      name,
      folder,
      path: sessionPath,
      state,
      phase,
      ...(date ? { date } : {}),
      summary,
      ...(requirement.branch ? { branch: requirement.branch } : {}),
      has_status: hasStatus,
      ...(legacySource ? { legacy_source: legacySource } : {}),
    };
    return verboseEntry;
  }

  private async readStatus(
    sessionPath: string,
  ): Promise<{ state: SessionState; phase: Phase } | null> {
    const path = join(sessionPath, "STATUS.md");
    if (!(await this.fs.exists(path))) {
      return null;
    }
    const text = await this.fs.readText(path);
    const stateRaw = parseMdValue(text, "State")?.toLowerCase();
    const phaseRaw = parseMdValue(text, "Phase")?.toLowerCase();
    const state: SessionState = stateRaw === "closed" ? "closed" : "active";
    const phase: Phase = isPhase(phaseRaw) ? phaseRaw : "planning";
    return { state, phase };
  }

  private async readRequirement(
    sessionPath: string,
  ): Promise<{ date?: string; summary?: string; branch?: string }> {
    const objetivoPath = join(sessionPath, "OBJETIVO.md");
    const requirementsPath = join(sessionPath, "REQUIREMENTS.md");
    const path = (await this.fs.exists(objetivoPath))
      ? objetivoPath
      : (await this.fs.exists(requirementsPath))
        ? requirementsPath
        : null;
    if (path === null) {
      return {};
    }
    const text = await this.fs.readText(path);
    const date = parseMdValue(text, "Fecha de inicio");
    const branch = parseMdValue(text, "Rama");
    const section =
      parseMdSection(text, "Requerimiento") ??
      parseMdSection(text, "Brief") ??
      parseMdSection(text, "Pregunta") ??
      parseMdSection(text, "Descripción") ??
      parseMdSection(text, "Descripcion");
    const firstLine = section ? firstNonEmptyLine(section) : undefined;
    const summary = firstLine ? firstLine.slice(0, 100) : undefined;
    return {
      ...(date ? { date } : {}),
      ...(summary ? { summary } : {}),
      ...(branch ? { branch } : {}),
    };
  }

  private async mtimeAsDate(path: string): Promise<string | undefined> {
    try {
      const info = await this.fs.stat(path);
      return formatDateOnly(info.mtime);
    } catch {
      return undefined;
    }
  }

  private applyFilter(sessions: SessionEntry[], input: ListSessionsInput): SessionEntry[] {
    if (input.state && input.state !== "all") {
      return sessions.filter((s) => s.state === input.state);
    }
    if (input.state === "all" || input.verbose === true) {
      return sessions;
    }
    return sessions.filter((s) => s.state === "active");
  }
}

export function parseSessionFolder(folder: string): {
  code: string | null;
  flow: Flow | null;
  name: string;
} {
  const m = folder.match(SESSION_FOLDER_RE);
  if (!m || !m[1] || !m[2]) {
    return { code: null, flow: null, name: folder };
  }
  const code = m[1];
  const rest = m[2];
  const parts = rest.split("-");
  const candidate = parts[0];
  if (
    parts.length >= 2 &&
    candidate &&
    (KNOWN_FLOWS as ReadonlyArray<string>).includes(candidate)
  ) {
    return { code, flow: candidate as Flow, name: parts.slice(1).join("-") };
  }
  return { code, flow: null, name: rest };
}

function isPhase(value: string | undefined): value is Phase {
  return (
    value === "planning" || value === "execution" || value === "validation" || value === "closure"
  );
}

function relativeToCwd(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel.length > 0 ? rel : ".";
}

function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
