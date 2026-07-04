// Host registry shared by the whole TUI.
//
// Single source of truth for chips, lists, status. The backend services
// (install/uninstall/cache/detect) use their own `InstallTarget`. Gemini also
// covers Antigravity CLI (it reuses ~/.gemini/).
//
// Whether a host has a real install/uninstall backend is NOT stored here — it
// is derived from the backend's own `TARGET_ROOTS` keys where needed, so the
// TUI cannot drift from what the services support (clean-legacy v14.5.1
// lesson).

export interface HostMeta {
  /** Stable id used in data + shortcuts. */
  id: string;
  /** Long label (shown in cards / detail panels). */
  name: string;
  /** 1-letter glyph for compact chips. */
  glyph: string;
  /** Short alias for dense text. */
  short: string;
}

export const HOSTS: readonly HostMeta[] = [
  { id: "claude", name: "Claude Code", glyph: "C", short: "claude" },
  { id: "codex", name: "Codex", glyph: "X", short: "codex" },
  { id: "warp", name: "Warp Terminal", glyph: "W", short: "warp" },
  { id: "gemini", name: "Gemini CLI / Antigravity", glyph: "G", short: "gemini" },
  { id: "opencode", name: "OpenCode", glyph: "O", short: "opencode" },
  { id: "crush", name: "Crush", glyph: "R", short: "crush" },
  { id: "agents", name: "Agents", glyph: "A", short: "agents" },
] as const;
