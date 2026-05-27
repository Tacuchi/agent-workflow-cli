import type { CliContext } from "../../types.js";
import type { ActivityEvent } from "../components/activity-feed.js";

export interface LoadActivityOptions {
  /** Máximo de sesiones a devolver (default 5). */
  cap?: number;
}

interface SessionRow {
  code: string;
  name: string;
  flow: string;
  state: string;
  type?: string;
  date?: string;
}

/**
 * Sesiones recientes para el activity-feed (Status tab).
 *
 * Lista TODAS las sesiones (`sessions --all`), la más reciente primero (por
 * código zero-padded), y devuelve las `cap` primeras con tipo/flujo/estado.
 */
export async function loadActivity(
  ctx: CliContext,
  opts: LoadActivityOptions = {},
): Promise<ActivityEvent[]> {
  const cap = opts.cap ?? 5;
  const res = await ctx.process
    .run(ctx.runtime.binName, ["sessions", "--all"], { cwd: ctx.env.cwd() })
    .catch(() => null);
  if (!res || res.code !== 0) return [];

  let sessions: SessionRow[];
  try {
    const data = JSON.parse(res.stdout) as { sessions?: SessionRow[] };
    sessions = data.sessions ?? [];
  } catch {
    return [];
  }

  return [...sessions]
    .sort((a, b) => b.code.localeCompare(a.code))
    .slice(0, cap)
    .map((s) => ({
      id: `session-${s.code}`,
      when: s.date ?? "",
      dotColor: s.state === "active" ? "accent" : "dim",
      text: `session${s.code} · ${s.name}`,
      meta: [s.type, s.flow, s.state].filter((v): v is string => Boolean(v)).join(" · "),
      metaTone: "dim",
    }));
}
