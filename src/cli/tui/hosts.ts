// Host registry compartido por toda la TUI.
//
// Single source of truth para chips, listas, status. Los servicios backend
// (install/uninstall/cache/detect) usan su propio `InstallTarget`. Desde la
// ronda multi-host, gemini/opencode/crush tienen HarnessSpec real (registry +
// MCP writer + detect + install a su skill dir), así que están `backed: true`.
// Gemini cubre además Antigravity CLI (reusa ~/.gemini/).
//
// El campo `backed` indica si el host tiene servicio de install/uninstall real.
// Hosts con `backed: false` se renderizan en la lista pero la acción muestra
// un toast "host no soportado todavía".

export interface HostMeta {
  /** id estable usado en data + atajos */
  id: string;
  /** label largo (mostrar en cards / detail panels) */
  name: string;
  /** glyph de 1 letra para chips compactos */
  glyph: string;
  /** alias corto para textos densos */
  short: string;
  /** true si install/uninstall/detect ya soportan este host */
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
