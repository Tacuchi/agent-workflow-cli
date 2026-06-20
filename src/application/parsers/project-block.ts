import { parseMdSection } from "../markdown.js";

export interface ProjectFuente {
  alias: string;
  path: string;
  main_branch: string;
}

export interface ProjectStack {
  language?: string;
  framework?: string;
  db?: string;
  build?: string;
}

export interface ParsedProjectBlock {
  proyecto: string;
  fuentes: ProjectFuente[];
  stack: ProjectStack;
  working_branches: Record<string, string>;
  qa_branches: Record<string, string>;
  last_activity: string | null;
}

export interface ProjectBlockMarkers {
  start: string;
  end: string;
}

export const LEGACY_QTC_MARKERS: ProjectBlockMarkers = {
  start: "<!-- QTC-PROJECT-START -->",
  end: "<!-- QTC-PROJECT-END -->",
};

const STACK_KEY_MAP: Record<string, keyof ProjectStack> = {
  lenguaje: "language",
  framework: "framework",
  bd: "db",
  build: "build",
};

export function parseProjectBlock(
  text: string,
  markers: ProjectBlockMarkers = LEGACY_QTC_MARKERS,
): ParsedProjectBlock | null {
  const primary = parseWithMarkers(text, markers);
  if (primary !== null) return primary;
  if (markers.start !== LEGACY_QTC_MARKERS.start) {
    return parseWithMarkers(text, LEGACY_QTC_MARKERS);
  }
  return null;
}

function parseWithMarkers(text: string, markers: ProjectBlockMarkers): ParsedProjectBlock | null {
  if (!text.includes(markers.start) || !text.includes(markers.end)) {
    return null;
  }
  const start = text.indexOf(markers.start) + markers.start.length;
  const end = text.indexOf(markers.end, start);
  if (end < 0) return null;
  const inner = text.slice(start, end);

  const proyectoText = parseMdSection(inner, "Proyecto") ?? "";
  const fuentesText = parseMdSection(inner, "Fuentes") ?? "";
  const stackText = parseMdSection(inner, "Stack") ?? "";
  const statusText = parseMdSection(inner, "Status") ?? "";

  const fuentes = parseFuentesTable(fuentesText);
  const stack = parseStackList(stackText);
  const status = parseStatusBlock(statusText);

  return {
    proyecto: stripLegacyModeLine(proyectoText),
    fuentes,
    stack,
    working_branches: status.workingBranches,
    qa_branches: status.qaBranches,
    last_activity: status.lastActivity,
  };
}

function parseFuentesTable(text: string): ProjectFuente[] {
  const fuentes: ProjectFuente[] = [];
  let header: string[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^[-:\s]*$/.test(c))) {
      continue;
    }
    if (header === null) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (cells.length < 3) continue;
    const alias = cells[0];
    const path = cells[1];
    const mainBranch = cells[2];
    if (alias === undefined || path === undefined) continue;
    fuentes.push({
      alias,
      path,
      main_branch: mainBranch ?? "certificacion",
    });
  }
  return fuentes;
}

function parseStackList(text: string): ProjectStack {
  const stack: ProjectStack = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^[-*]\s+(Lenguaje|Framework|BD|Build):\s*(.+)$/i);
    if (m?.[1] && m[2]) {
      const key = STACK_KEY_MAP[m[1].toLowerCase()];
      if (key) {
        stack[key] = m[2].trim();
      }
    }
  }
  return stack;
}

interface StatusBlock {
  workingBranches: Record<string, string>;
  qaBranches: Record<string, string>;
  lastActivity: string | null;
}

type StatusSection = "none" | "working" | "qa";

function parseStatusBlock(text: string): StatusBlock {
  const workingBranches: Record<string, string> = {};
  const qaBranches: Record<string, string> = {};
  let lastActivity: string | null = null;
  let section: StatusSection = "none";

  for (const raw of text.split("\n")) {
    const stripped = raw.trim();
    const transition = transitionSection(stripped);
    if (transition.handled) {
      section = transition.next;
      if (transition.lastActivity !== undefined) {
        lastActivity = transition.lastActivity;
      }
      continue;
    }
    if (!stripped.startsWith("- ")) continue;
    const entry = stripped.slice(2).trim();
    if (section === "working") {
      addWorkingBranch(workingBranches, entry);
    } else if (section === "qa") {
      addWorkingBranch(qaBranches, entry);
    }
  }

  return { workingBranches, qaBranches, lastActivity };
}

function transitionSection(stripped: string): {
  handled: boolean;
  next: StatusSection;
  lastActivity?: string | null;
} {
  if (stripped.startsWith("- Ramas de trabajo actuales:"))
    return { handled: true, next: "working" };
  if (stripped.startsWith("- Ramas QA actuales:")) return { handled: true, next: "qa" };
  if (stripped.startsWith("- Última actividad:")) {
    const idx = stripped.indexOf(":");
    return {
      handled: true,
      next: "none",
      lastActivity: idx >= 0 ? stripped.slice(idx + 1).trim() : null,
    };
  }
  if (stripped.startsWith("- Histórico") || stripped.startsWith("- Historico")) {
    return { handled: true, next: "none" };
  }
  return { handled: false, next: "none" };
}

function addWorkingBranch(out: Record<string, string>, entry: string): void {
  const colon = entry.indexOf(":");
  if (colon <= 0) return;
  const alias = entry.slice(0, colon).trim();
  const branch = entry.slice(colon + 1).trim();
  if (alias && branch) {
    out[alias] = branch;
  }
}

/**
 * Drop any legacy `Mode:` line from the Proyecto text. The project/hub mode
 * concept was removed (a workspace simply has 1+ sources), so the value is
 * ignored — but historic blocks may still carry the line, and it must not leak
 * into the parsed `proyecto`.
 */
function stripLegacyModeLine(text: string): string {
  // Strip any legacy `Mode: <value>` line (hub/project/single-repo/...); the mode
  // concept is gone, so its value is ignored and must not leak into `proyecto`.
  const cleanLines = text.split("\n").filter((line) => !/^\s*Mode:\s*\S/i.test(line));
  return cleanLines.join("\n").trim();
}
