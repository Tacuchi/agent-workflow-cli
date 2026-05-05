import { join } from "node:path";
import type { Namespace } from "../runtime/namespace.js";

export interface ProjectBlockMarkers {
  start: string;
  end: string;
}

export class PathsService {
  constructor(
    private readonly ns: Namespace,
    private readonly home: string,
    private readonly cwd: string,
  ) {}

  get namespace(): Namespace {
    return this.ns;
  }

  // user-level (~/.${ns}/...)
  userRoot(): string {
    return join(this.home, `.${this.ns}`);
  }
  userDevDir(): string {
    return join(this.userRoot(), "dev");
  }
  userDsnFile(): string {
    return join(this.userDevDir(), "dsn.env");
  }
  userLogsDir(): string {
    return join(this.userRoot(), "logs");
  }
  userLibConfigDir(): string {
    return join(this.userRoot(), "lib", "config");
  }
  userRuntimeJson(): string {
    return join(this.userRoot(), "agent-workflow", "runtime.json");
  }
  userConfigMd(): string {
    return join(this.userRoot(), "user-config.md");
  }

  // cwd-level (.${ns}/... in current workspace)
  cwdRoot(): string {
    return join(this.cwd, `.${this.ns}`);
  }
  cwdSessionsDir(): string {
    return join(this.cwdRoot(), "sessions");
  }
  cwdHistoryFile(): string {
    return join(this.cwdRoot(), "HISTORY.md");
  }
  cwdLogsDir(): string {
    return join(this.cwdRoot(), "logs");
  }
  cwdLogFile(): string {
    return join(this.cwdLogsDir(), "agent-workflow.log");
  }

  // CLAUDE.md / AGENTS.md project block markers
  blockMarkers(): ProjectBlockMarkers {
    const upper = this.ns.toUpperCase();
    return {
      start: `<!-- ${upper}-PROJECT-START -->`,
      end: `<!-- ${upper}-PROJECT-END -->`,
    };
  }
}
