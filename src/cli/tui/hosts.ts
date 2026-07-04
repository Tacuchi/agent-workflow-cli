// Host registry shared by the whole TUI.
//
// Single source of truth for chips, lists, status. The backend services
// (install/uninstall/cache/detect) use their own `InstallTarget`. Gemini also
// covers Antigravity CLI (it reuses ~/.gemini/).
//
// `backed` states whether the host has a real install/uninstall service.
// Hosts with `backed: false` still render in the list, but the action shows a
// "host not supported yet" toast.

export interface HostMeta {
  /** Stable id used in data + shortcuts. */
  id: string;
  /** Long label (shown in cards / detail panels). */
  name: string;
  /** 1-letter glyph for compact chips. */
  glyph: string;
  /** Short alias for dense text. */
  short: string;
  /** True when install/uninstall/detect already support this host. */
  backed: boolean;
}

export const HOSTS: readonly HostMeta[] = [
  { id: "claude", name: "Claude Code", glyph: "C", short: "claude", backed: true },
  { id: "codex", name: "Codex", glyph: "X", short: "codex", backed: true },
  { id: "warp", name: "Warp Terminal", glyph: "W", short: "warp", backed: true },
  { id: "gemini", name: "Gemini CLI / Antigravity", glyph: "G", short: "gemini", backed: true },
  { id: "opencode", name: "OpenCode", glyph: "O", short: "opencode", backed: true },
  { id: "crush", name: "Crush", glyph: "R", short: "crush", backed: true },
  { id: "agents", name: "Agents", glyph: "A", short: "agents", backed: true },
] as const;

export const HOST_BY_ID: Record<string, HostMeta> = Object.fromEntries(HOSTS.map((h) => [h.id, h]));

export function hostMeta(id: string): HostMeta {
  return (
    HOST_BY_ID[id] ?? {
      id,
      name: id,
      glyph: id[0]?.toUpperCase() ?? "?",
      short: id,
      backed: false,
    }
  );
}
