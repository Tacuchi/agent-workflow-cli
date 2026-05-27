// Preferencias persistidas del TUI (accent, initial screen, hosts).
//
// Vive en `~/.config/agent-workflow/lib/config/tui-prefs.json` (relativo al
// userRoot del namespace activo). Si no existe se devuelven defaults. Las
// escrituras son atómicas: lee, mergea, escribe. Cada campo se valida al cargar
// (un valor inválido cae a su default, no rompe el TUI).

import { dirname, join } from "node:path";
import type { PathsService } from "../../application/paths-service.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { TABS_LIST, type TabId } from "./components/tabs-config.js";
import { ACCENTS, type AccentColor, DEFAULT_ACCENT } from "./theme.js";

export interface TuiPrefs {
  accentColor: AccentColor;
  /** Tab donde aterriza `aw` al arrancar. */
  initialScreen: TabId;
  /** Hosts excluidos del targeting (opt-out). Vacío = todos habilitados. */
  disabledHosts: string[];
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
