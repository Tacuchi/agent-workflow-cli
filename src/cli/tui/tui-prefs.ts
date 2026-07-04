// Persisted TUI preferences (accent, initial screen, hosts).
//
// Lives in `~/.config/agent-workflow/lib/config/tui-prefs.json` (relative to
// the active namespace's userRoot). Missing file yields defaults. Writes are
// atomic: read, merge, write. Every field is validated on load (an invalid
// value falls back to its default, never breaks the TUI).

import { dirname, join } from "node:path";
import type { PathsService } from "../../application/paths-service.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { TABS_LIST, type TabId } from "./components/tabs-config.js";
import { ACCENTS, type AccentColor, DEFAULT_ACCENT } from "./theme.js";

export interface TuiPrefs {
  accentColor: AccentColor;
  /** Tab `aw` lands on at startup. */
  initialScreen: TabId;
  /** Hosts excluded from targeting (opt-out). Empty = all enabled. */
  disabledHosts: string[];
  /** Last app used in the log history's "open with…" (memory + prefill). */
  lastOpenApp?: string;
}

export const DEFAULT_TUI_PREFS: TuiPrefs = {
  accentColor: DEFAULT_ACCENT,
  initialScreen: "status",
  disabledHosts: [],
};

function isAccent(v: unknown): v is AccentColor {
  return typeof v === "string" && v in ACCENTS;
}

function isTabId(v: unknown): v is TabId {
  return typeof v === "string" && TABS_LIST.some((t) => t.id === v);
}

export class TuiPrefsService {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly paths: PathsService,
  ) {}

  private filePath(): string {
    return join(this.paths.userLibConfigDir(), "tui-prefs.json");
  }

  async load(): Promise<TuiPrefs> {
    const path = this.filePath();
    if (!(await this.fs.exists(path))) return { ...DEFAULT_TUI_PREFS };
    try {
      const raw = await this.fs.readText(path);
      const parsed = JSON.parse(raw) as Partial<TuiPrefs>;
      return {
        accentColor: isAccent(parsed.accentColor)
          ? parsed.accentColor
          : DEFAULT_TUI_PREFS.accentColor,
        initialScreen: isTabId(parsed.initialScreen)
          ? parsed.initialScreen
          : DEFAULT_TUI_PREFS.initialScreen,
        disabledHosts: Array.isArray(parsed.disabledHosts)
          ? parsed.disabledHosts.filter((h): h is string => typeof h === "string")
          : DEFAULT_TUI_PREFS.disabledHosts,
        ...(typeof parsed.lastOpenApp === "string" ? { lastOpenApp: parsed.lastOpenApp } : {}),
      };
    } catch {
      return { ...DEFAULT_TUI_PREFS };
    }
  }

  async save(patch: Partial<TuiPrefs>): Promise<void> {
    const current = await this.load();
    const next: TuiPrefs = { ...current, ...patch };
    const path = this.filePath();
    await this.fs.mkdirp(dirname(path));
    await this.fs.writeText(path, `${JSON.stringify(next, null, 2)}\n`);
  }
}
