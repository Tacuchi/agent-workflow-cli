// Preferencias persistidas del TUI (density, layout, etc).
//
// Vive en `~/.config/agent-workflow/lib/config/tui-prefs.json` (relativo al
// userRoot del namespace activo). Si no existe se devuelven defaults. Las
// escrituras son atómicas: lee, mergea, escribe.

import { dirname, join } from "node:path";
import type { PathsService } from "../../application/paths-service.js";
import type { FileSystemPort } from "../../ports/file-system.js";

export type Density = "comfortable" | "compact";

export interface TuiPrefs {
  density: Density;
}

const DEFAULTS: TuiPrefs = {
  density: "comfortable",
};

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
    if (!(await this.fs.exists(path))) return { ...DEFAULTS };
    try {
      const raw = await this.fs.readText(path);
      const parsed = JSON.parse(raw) as Partial<TuiPrefs>;
      return {
        density:
          parsed.density === "compact" || parsed.density === "comfortable"
            ? parsed.density
            : DEFAULTS.density,
      };
    } catch {
      return { ...DEFAULTS };
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
