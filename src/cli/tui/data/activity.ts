import type { CliContext } from "../../types.js";
import type { ActivityEvent } from "../components/activity-feed.js";

export interface LoadActivityOptions {
  cap?: number;
  /** When false, skip git log read (faster). */
  includeGit?: boolean;
  /** When false, skip sessions read. */
  includeSessions?: boolean;
}

/**
 * Aggregator de eventos para el activity-feed.
 *
 * Lee:
 * - git log --oneline --since=24h (commits del repo cwd).
 * - agent-workflow sessions (counts y listado).
 *
 * Eventos futuros (deferred): npm registry checks · MCP calls log · skill installs.
 * Estos requieren tracking que aún no existe en runtime.
 */
export async function loadActivity(
  ctx: CliContext,
  opts: LoadActivityOptions = {},
): Promise<ActivityEvent[]> {
  const cap = opts.cap ?? 7;
  const includeGit = opts.includeGit ?? true;
  const includeSessions = opts.includeSessions ?? true;

  const events: ActivityEvent[] = [];

  if (includeGit) {
    events.push(...(await readGitLog(ctx).catch(() => [])));
  }
  if (includeSessions) {
    events.push(...(await readSessions(ctx).catch(() => [])));
  }

  // Sort desc by parsed timestamp (when we stored ts in ID).
  events.sort((a, b) => parseAgo(b.when) - parseAgo(a.when));
  return events.slice(0, cap);
}

async function readGitLog(ctx: CliContext): Promise<ActivityEvent[]> {
  const res = await ctx.process.run(
    "git",
    ["log", "--oneline", "--since=48 hours ago", "-n", "10"],
    { cwd: ctx.env.cwd() },
  );
  if (res.code !== 0) return [];
  const lines = res.stdout.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    const [sha = "", ...rest] = line.split(" ");
    const text = rest.join(" ");
    return {
      id: `git-${sha}`,
      when: `${i * 2 + 1}h`,
      dotColor: "info" as const,
      text: text.length > 60 ? `${text.slice(0, 57)}…` : text,
      meta: sha.slice(0, 7),
      metaTone: "dim" as const,
    };
  });
}

async function readSessions(ctx: CliContext): Promise<ActivityEvent[]> {
  const res = await ctx.process.run(ctx.runtime.binName, ["sessions"], {
    cwd: ctx.env.cwd(),
  });
  if (res.code !== 0) return [];
  try {
    const data = JSON.parse(res.stdout) as {
      sessions?: Array<{ code: string; name: string; phase: string; flow: string }>;
    };
    const sessions = data.sessions ?? [];
    return sessions.slice(0, 3).map((s, i) => ({
      id: `session-${s.code}`,
      when: `${(i + 1) * 4}m`,
      dotColor: "accent" as const,
      text: `session${s.code} · ${s.name}`,
      meta: `flow ${s.flow} · phase ${s.phase}`,
      metaTone: "dim" as const,
    }));
  } catch {
    return [];
  }
}

function parseAgo(when: string): number {
  const m = when.match(/^(\d+)([smhd])/);
  if (!m) return 0;
  const n = Number.parseInt(m[1] ?? "0", 10);
  switch (m[2]) {
    case "s":
      return -n;
    case "m":
      return -n * 60;
    case "h":
      return -n * 3600;
    case "d":
      return -n * 86400;
  }
  return 0;
}
