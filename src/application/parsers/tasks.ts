import { parsePlanSourceBoundary } from "../source-boundary-policy.js";

export type TaskStatus = "open" | "closed";

export interface TaskItem {
  n: number;
  status: TaskStatus;
  text: string;
  /** Owning plan phase when this came from a declared `## Tasks` phase block. */
  phase?: number;
  /** Explicit aliases from `_(fuentes: …)_`; absent preserves legacy task projections. */
  sources?: string[];
  deps?: string[];
}

export interface ParsedTasks {
  total: number;
  open: number;
  closed: number;
  progress_pct: number;
  items: TaskItem[];
  next_open: TaskItem | null;
}

const TASK_RE = /^\s*[-*]\s*\[([ xX])\]\s+(.+)$/;
const DEP_RE = /\(deps?:\s*([^)]+)\)/i;
const SOURCES_RE = /_\(\s*fuentes\s*:\s*([^)]*)\)_/i;

export function parseTasks(text: string, compact = true): ParsedTasks {
  const items: TaskItem[] = [];
  let n = 0;
  const declarations = new Map<number, { phase: number; sources: string[] | null }>();
  for (const phase of parsePlanSourceBoundary(text).phases) {
    for (const task of phase.tasks) {
      declarations.set(task.line, { phase: phase.n, sources: task.sources });
    }
  }

  for (const [index, line] of text.split("\n").entries()) {
    const match = line.match(TASK_RE);
    if (!match || !match[1] || !match[2]) continue;
    n += 1;
    const status: TaskStatus = match[1].toLowerCase() === "x" ? "closed" : "open";
    let body = match[2].trim();
    const declared = declarations.get(index + 1);
    const sourceMatch = SOURCES_RE.exec(body);
    const sources = declared?.sources ?? readSources(sourceMatch?.[1]);
    body = body.replace(SOURCES_RE, "").trim();

    let deps: string[] = [];
    const depMatch = body.match(DEP_RE);
    if (depMatch?.[1]) {
      deps = depMatch[1]
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
      body = body.replace(DEP_RE, "").trim();
    }

    const item: TaskItem = { n, status, text: body };
    if (declared !== undefined) item.phase = declared.phase;
    if (sources !== null) item.sources = sources;
    if (deps.length > 0 || !compact) {
      item.deps = deps;
    }
    items.push(item);
  }

  const closedItems = items.filter((t) => t.status === "closed");
  const openItems = items.filter((t) => t.status === "open");
  const progressPct = items.length > 0 ? Math.round((100 * closedItems.length) / items.length) : 0;

  return {
    total: items.length,
    open: openItems.length,
    closed: closedItems.length,
    progress_pct: progressPct,
    items,
    next_open: openItems[0] ?? null,
  };
}

function readSources(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  return raw
    .split(",")
    .map((source) => source.trim())
    .filter((source) => source.length > 0);
}
